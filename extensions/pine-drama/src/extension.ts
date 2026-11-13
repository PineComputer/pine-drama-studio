import { registerProjectCommands } from './projectCommands';
import * as vscode from 'vscode';
import { savedConnection, connectionScope, disconnectProblem, developerConnectionFile, PINE_KEY_SECRET } from './core/pineConnection';
import { registerPineConnection, CONNECTION_COMMAND } from './pineConnection';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatService, stopAllSummary } from './core/chats';
import { dramaRecordOf, installedSnapshots, previewVersions } from './core/taskRun';
import type { SecretVault } from './core/pinePort';
import { setAsideNotice, Store } from './core/store';
import { lockProjectWindow, type ProjectWindowLock } from './core/projectWindowLock';
import { sessionProjectRoot } from './core/projectSessions';
import { configLine, endpointHost, notSetUpText, pineConfig, type PineConfig } from './pineConfig';
import { registerPineSessions, windowFileFolders } from './pineSessions';
import { registerEpisodeCanvas } from './episodeCanvas';
import { cardActions } from './cardActions';
import { registerGalleries } from './galleries';
import { registerSegEditor } from './segEditor';

/** Two views refreshed as one. */
const both = (a: { refresh(): void }, b: { refresh(): void }) => ({ refresh: () => { a.refresh(); b.refresh(); } });
import { registerProjectViews, type ProjectViews } from './projectViews';
import { DramaProject } from './core/project';
import { owningChat } from './core/projectPlace';
import { SdkPort } from './sdkPort';
import { showInChatView } from './chatView';
import { registerReviewView } from './reviewView';
import { waitingReason } from './core/reviews';
import { destinationOf, statusText, waitingItems, type WaitingItem } from './core/attention';
import { sessionTitles } from './core/sessionTitle';
import { openProjectChat, projectWindowRestorer, type RestoredProjectChat } from './projectChatNavigation';

// Wires the Studio's parts to the workbench: business state in SQLite
// under the extension's global storage, credentials in VS Code SecretStorage, Pine through the SDK.
// Computers are not stopped when the window closes: the Chat continues after a restart.

let store: Store | undefined;
let windowLock: ProjectWindowLock | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Pine Drama Studio');
	context.subscriptions.push(output);
	const log = (line: string) => output.appendLine(`${new Date().toISOString()} ${line}`);
	log(`activated in "${vscode.env.appName}" ${vscode.version}`);

	// One Studio window per project (core/projectWindowLock.ts). A window that does not get its project window lock loads nothing
	// for the project, not even its views, and says so in one line. A window with no single folder has no project to lock.
	let lockedRoot: string | undefined;
	try {
		lockedRoot = sessionProjectRoot(windowFileFolders());
		windowLock = lockedRoot ? lockProjectWindow(lockedRoot) : undefined;
	} catch (error) {
		log(`project window lock: ${lockedRoot ?? 'the window folder'}: ${(error as Error).stack ?? error}`);
		void vscode.window.showErrorMessage(`Pine: this window could not take its project's lock (${(error as Error).message}), so it loads nothing for the project. See Output › Pine Drama Studio.`);
		return;
	}
	if (windowLock?.kind === 'elsewhere') {
		log(`project window lock: ${lockedRoot} is open in another Studio window (${windowLock.file}); this window loads nothing for it`);
		void vscode.window.showWarningMessage('Pine: This project is open in another Studio window. This window loads nothing for it.');
		return;
	}
	if (windowLock) { log(`project window lock: ${lockedRoot} (${windowLock.file})`); }
	const held = windowLock?.kind === 'held' ? lockedRoot : undefined;

	// The project views read files only: they register first, whatever happens to the Chat store below.
	// The project may arrive later: a session bound to an empty folder receives its config at the first publication
	// (core/projectFinder.ts). The parts that read it register once, when it first appears, and then meet the session.
	let opened: { views: ProjectViews; canvas: { refresh(): void }; galleries: ReturnType<typeof registerGalleries> } | undefined;
	let projectOpened: (() => void) | undefined;
	let protocolStorage: string | undefined;
	// The downloaded versions (protocol 4.6) are extracted in the drama's record, outside its folder: a watcher on the
	// record's previews refreshes the views as each arrives or goes, once both the project and the storage are known.
	let previewsWatched = false;
	const watchPreviews = () => {
		if (previewsWatched || !opened || !protocolStorage) {
			return;
		}
		previewsWatched = true;
		const shown = opened;
		let timer: NodeJS.Timeout | undefined;
		const changed = () => {
			clearTimeout(timer);
			timer = setTimeout(() => { shown.views.refresh(); shown.galleries.refresh(); shown.canvas.refresh(); }, 300);
		};
		const dir = join(dramaRecordOf(protocolStorage, shown.views.project.root).dir, 'previews');
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.json'));
		context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidDelete(changed), { dispose: () => clearTimeout(timer) });
	};
	// A Chat's title for the cards' marks, known once the sessions are read below.
	let chatTitleOf: (key: string) => string | undefined = () => undefined;
	const projects = await registerProjectViews(context, output, views => {
		const root = views.project.root;
		// Every view reads the folder's files, so a change of them refreshes the tree, the galleries and the canvases a
		// second after the last one (Code-OSS's FileSystemWatcher).
		let timer: NodeJS.Timeout | undefined;
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
		const changed = () => {
			clearTimeout(timer);
			timer = setTimeout(() => { views.refresh(); opened?.galleries.refresh(); opened?.canvas.refresh(); }, 1000);
		};
		context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed), { dispose: () => clearTimeout(timer) });
		opened = {
			views,
			// An episode's two views of one model: its seg editor and its canvas, refreshed together.
			// The record panel on the canvas runs the grid's card actions (cardActions.ts).
			canvas: both(registerEpisodeCanvas(context, views, output, cardActions(context, root), key => chatTitleOf(key)), registerSegEditor(context, views, output)),
			galleries: registerGalleries(context, views, output, key => chatTitleOf(key)),
		};
		watchPreviews();
		projectOpened?.();
	},
	// The views read the drama's record under the connection's protocol storage (core/taskRun.ts), known once the Pine
	// connection is read below: the installed returns' snapshots, the downloaded versions not installed yet, and each
	// request as sent and return dealt with, for the cards' marks.
	root => () => protocolStorage ? installedSnapshots(protocolStorage, root) : [],
	root => () => protocolStorage ? previewVersions(protocolStorage, root) : [],
	root => ({
		requests: () => protocolStorage ? dramaRecordOf(protocolStorage, root).requests() : [],
		returns: () => protocolStorage ? dramaRecordOf(protocolStorage, root).returns() : [],
	}));

	registerProjectCommands(context, output);

	let connectionCurrent = true;
	const usesDeveloperFile = !!developerConnectionFile(context.extensionMode === vscode.ExtensionMode.Development, process.env.PINE_DRAMA_ENV_FILE);
	// Observe before reading: even an invalid saved key remains repairable, while any concurrent update invalidates admission.
	context.subscriptions.push(context.secrets.onDidChange(event => {
		if (event.key !== PINE_KEY_SECRET || usesDeveloperFile) { return; }
		connectionCurrent = false;
		void vscode.window.showWarningMessage('The Pine connection changed. Reload before sending more work.', 'Reload Window').then(action => {
			if (action) { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
		});
	}));

	const config = await loadPine(context, output);
	const connectionRoot = config.kind === 'set' && config.saved
		? join(context.globalStorageUri.fsPath, 'connections', connectionScope(config.pine)) : config.kind === 'disconnected' ? join(context.globalStorageUri.fsPath, 'connections', 'disconnected') : context.globalStorageUri.fsPath;
	await mkdir(connectionRoot, { recursive: true });
	// The protocol client's storage (doc/protocol.md): kept archives and each drama's record, outside the drama's folder.
	protocolStorage = join(connectionRoot, 'protocol');
	opened?.views.refresh();
	watchPreviews();
	const dbPath = join(connectionRoot, 'studio.sqlite');
	try {
		store = new Store(dbPath);
		if (store.setAside) {
			const notice = setAsideNotice(store.setAside);
			log(`conversation store: schema ${store.setAside.schema} database set aside: ${notice}`);
			void vscode.window.showInformationMessage(`Pine: ${notice}`);
		}
	} catch (error) {
		// The refusal stays explicit (AGENTS.md, coding rules 1 and 4: no silent migration); only Pine's part stops.
		log(`conversation store: ${(error as Error).message}`);
		void vscode.window.showErrorMessage(`Pine sessions are unavailable: ${(error as Error).message}`);
		return;
	}
	const studioStore = store;
	const vault: SecretVault = {
		get: name => Promise.resolve(context.secrets.get(name)),
		store: (name, value) => Promise.resolve(context.secrets.store(name, value)),
		delete: name => Promise.resolve(context.secrets.delete(name)),
	};
	let sessions: ReturnType<typeof registerPineSessions> | undefined;
	let reviews: ReturnType<typeof registerReviewView> | undefined;
	let onChanged: (() => void) | undefined;
	let chatsChanged: (() => void) | undefined;
	const service = new ChatService({
		store,
		port: new SdkPort(),
		vault,
		pine: config.kind === 'set' ? config.pine : undefined,
		connectionCurrent: () => connectionCurrent,
		holdsProject: root => root === held,
		files: {
			libraryRoot: join(connectionRoot, 'library'),
			projectsRoot: join(connectionRoot, 'projects'),
		},
		protocol: { storage: protocolStorage },
		log,
		onChange: key => {
			sessions?.refresh(key);
			reviews?.refresh(key);
			onChanged?.();
			chatsChanged?.();
			// A stop this window settled may have initialized the project's root; the watcher sees it too, later.
			projects.possibleChange();
		},
	});
	registerPineConnection(context, config, vault, log, () => { connectionCurrent = false; }, () => connectionCurrent, () => disconnectProblem(service.chats()));
	log(`conversation store ${dbPath}`);
	// One title per session wherever it is named: the sessions list, the pickers, Review, the status bar.
	const titleOf = sessionTitles(key => service.projectRoot(key), log, key => service.chat(key));
	chatTitleOf = titleOf;
	// The open reviews with each item's verdict so far: a session's project window shows its own Chat's. Registered
	// before the sessions, whose Chat cards submit through it.
	reviews = registerReviewView(context, output, service, titleOf);
	sessions = registerPineSessions(context, output, config, service, reviews);

	// A session's project is its locally published folder,
	// matched by the root the Project view chose. The stops may be
	// settled by another window (the Chat's), so this window watches the folder rather than its own service.
	const projectsRoot = join(connectionRoot, 'projects');
	const titled = (conv: { key: string; label: string }) => titleOf(conv.key) ?? conv.label;
	const tabs = {
		active: () => vscode.window.tabGroups.activeTabGroup.activeTab,
		isOpen: (tab: vscode.Tab) => vscode.window.tabGroups.all.some(group => group.tabs.includes(tab)),
		close: (tab: vscode.Tab) => vscode.window.tabGroups.close(tab),
	};
	const showInChat = (key: string) => showInChatView((command, ...args) => vscode.commands.executeCommand(command, ...args), tabs, vscode.Uri.parse(key));
	// The window shows the drama of its folder: the session bound to it, whether or not its project has come back yet.
	// A folder that was empty at activation is bound by its first message,
	// so the session is looked up again when the project arrives (wireProject).
	const windowFolders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
	const projectSession = () => owningChat(service.chats(), projectsRoot, opened ? [opened.views.project.root] : windowFolders);
	let session = projectSession();
	reviews.scope(sessions?.scope()?.root);
	/**
	 * Meets the window's project with its session, once both are known: at activation, when the project arrives, or when
	 * a Chat binds the folder later (ChatService's onChange, after `bound to`). Code-OSS's git extension does the same with
	 * its folders: it runs one handler at start for the folders it has and again on each change event
	 * (extensions/git/src/model.ts:295, :325, Code-OSS 1.145.0).
	 */
	let wired = false;
	const wireProject = () => {
		if (!opened || wired) {
			return;
		}
		const { views, canvas } = opened;
		session = projectSession();
		reviews!.scope(sessions?.scope()?.root);
		if (!session) {
			return; // a local project: no session's lineage, arrivals or Chat
		}
		wired = true;
		const owner = session;
		const title = titled(owner);
		const label = `Pine · ${title}`;
		// Script remains read-only; explicit decisions use the shared local Review path.
		views.setOrigin(label);
		canvas.refresh();
		log(`project: ${owner.label}'s project (${views.project.root})`);
	};
	projectOpened = wireProject;
	chatsChanged = wireProject;
	wireProject();

	const openProjectWindow = (key: string) => openProjectChat(key, {
		scope: () => sessions?.scope(),
		chat: key => service.chat(key),
		show: showInChat,
		request: key => studioStore.requestChatReveal(key),
		clear: token => studioStore.clearChatReveal(token),
		open: async root => { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true }); },
	});
	// A named row opens its own project first; the palette uses this project's main entry. Neither dispatches work.
	context.subscriptions.push(vscode.commands.registerCommand('pineDrama.openSessionProject', async (row?: vscode.ChatSessionItem | string) => {
		const key = typeof row === 'string' ? row : row?.resource?.toString() ?? sessions?.scope()?.mainKey;
		if (!key) { await vscode.commands.executeCommand('pineDrama.openProject'); return; }
		try { await openProjectWindow(key); }
		catch (error) {
			log(`project destination ${key}: ${(error as Error).stack ?? error}`);
			void vscode.window.showErrorMessage(`Pine: ${(error as Error).message}`);
		}
	}));

	// The Chats list is upstream's Agent Sessions view inside Chat; this opens Chat and shows it.
	context.subscriptions.push(vscode.commands.registerCommand('pineDrama.showConversations', async () => {
		await vscode.commands.executeCommand('workbench.action.chat.open');
		await vscode.commands.executeCommand('agentSessions.showAgentSessionsSidebar');
		await vscode.commands.executeCommand('pine.workbench.showProjectSessions');
	}));
	// What waits for the person, and where a click takes them: to the waiting item by its kind and this window's scope,
	// or to a pick of them (core/attention.ts; change 4).
	const waiting = (): WaitingItem[] => waitingItems(
		(sessions?.scope()?.chats ?? []),
		key => { const open = service.openReview(key); return open && { id: open.review.id, items: open.review.items.length }; },
		conv => waitingReason(titled(conv), service.openReview(conv.key)?.review),
		titled,
	);
	const goTo = async (item: WaitingItem) => {
		const hasProject = await DramaProject.isProject(service.projectRoot(item.key)!);
		const to = destinationOf(item, (sessions?.scope()?.chats ?? []).map(c => c.key), hasProject);
		log(`waiting: ${item.label} → ${to.to}`);
		if (to.to === 'review' && await reviews?.reveal(to.reviewId)) {
			return;
		}
		if (to.to === 'window') {
			// The project window reveals it when it activates or gains focus: opening a folder a window already shows only
			// focuses that window (windowsMainService.ts, "Check for existing instances"), so the request goes through the
			// store every window shares.
			studioStore.requestReveal(item.key, to.reviewId);
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(service.projectRoot(item.key)!), { forceNewWindow: true });
			return;
		}
		await openProjectWindow(item.key);
	};
	context.subscriptions.push(vscode.commands.registerCommand('pineDrama.showWaiting', async () => {
		const items = waiting();
		if (!items.length) {
			await vscode.commands.executeCommand('pineDrama.showConversations');
			return;
		}
		const picked = items.length === 1 ? items[0] : (await vscode.window.showQuickPick(
			items.map(item => ({ label: item.label, detail: item.reason.startsWith(`${item.label}: `) ? item.reason.slice(item.label.length + 2) : item.reason, item })),
			{ title: 'What waits for you', placeHolder: 'Each session that waits, the most recently active first' },
		))?.item;
		if (picked) {
			await goTo(picked);
		}
	}));
	// A review another window asked this project's window to reveal ("Revealing a decision in another window").
	// The project's Chats are read at each focus: a Chat bound after activation is a member from then on.
	const revealReviewAsked = async () => {
		const reviewId = studioStore.takeReveal((sessions?.scope()?.chats ?? []).map(c => c.key), 60_000);
		if (reviewId) {
			const shown = await reviews?.reveal(reviewId);
			log(`waiting: review ${reviewId} ${shown ? 'revealed' : 'is no longer open'}`);
		}
	};

	const restoreWindow = projectWindowRestorer({
		scope: () => sessions?.scope(),
		// The private window API reports Local only; L2 awaits native extension-session restoration.
		prepare: key => Promise.resolve(vscode.commands.executeCommand<RestoredProjectChat | undefined>('pine.workbench.prepareProjectChat', key)),
		takeRequested: root => studioStore.takeChatReveal(root, 60_000),
		show: showInChat,
		review: revealReviewAsked,
		failed: error => {
			log(`window navigation: ${(error as Error).stack ?? error}`);
			void vscode.window.showErrorMessage(`Pine: the Chat could not be restored: ${(error as Error).message}. See Output › Pine Drama Studio.`);
		},
	});
	// Do not await activation on restoration: resolving the native provider can itself await activation.
	void restoreWindow();
	context.subscriptions.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) { void restoreWindow(); } }));

	const status = vscode.window.createStatusBarItem('pineDrama.conversations', vscode.StatusBarAlignment.Left, 100);
	status.name = 'Pine sessions';
	// No Pine environment set up: the label says so, with no colour (VS Code UX guidelines, Status Bar: a background is "a last
	// resort"), the tooltip is the chat's sentence, and a click shows the detail in Output.
	context.subscriptions.push(vscode.commands.registerCommand('pineDrama.showPineSetup', () => output.show(true)));
	const updateStatus = () => {
		const all = [...(sessions?.scope()?.chats ?? [])];
		if (config.kind !== 'set') {
			status.text = config.kind === 'disconnected' ? '$(pine-computer) Pine · not connected' : '$(pine-computer) Pine environment · not set up';
			status.tooltip = notSetUpText(config).replace(/[*`]/g, '');
			status.command = config.kind === 'disconnected' ? CONNECTION_COMMAND : 'pineDrama.showPineSetup';
			status.show();
			return;
		}
		const items = waiting();
		const running = all.filter(c => c.state === 'running').length;
		status.text = `$(pine-computer) ${sessions?.scope() ? statusText(all.length, running, items.length) : 'Pine · No project open'}`;
		status.command = 'pineDrama.showWaiting';
		// What each waiting session waits for, so the count is not a riddle. No custom colour (VS Code UX guidelines,
		// Status Bar: don't "Add custom colors").
		status.tooltip = [`${all.length} Pine session(s) on ${endpointHost(config.pine.endpoint)}. Click to ${items.length ? 'go to what waits for you' : 'show them'}.`, ...items.map(item => `Waiting for you: ${item.reason}.`)].join('\n');
		status.show();
	};
	updateStatus();
	context.subscriptions.push(status);
	onChanged = updateStatus;

	// The one developer command, palette only: simulates Pine's idle stop for testing. It records nothing locally;
	// Output says what Pine confirmed for each Computer, and the Studio finds the stop the next time it asks Pine.
	context.subscriptions.push(vscode.commands.registerCommand('pineDrama.stopAllComputers', async () => {
		const asked = await service.stopAll();
		for (const a of asked) {
			log(`developer stop (simulated idle stop): Computer ${a.computerId} of ${a.key}: Pine ${a.pine ?? (a.outcome === 'gone' ? 'has no record' : 'could not be read')}, ${a.outcome}${a.detail ? ` (${a.detail})` : ''}`);
		}
		void vscode.window.showInformationMessage(`Stop All Computers: ${stopAllSummary(asked)} Nothing was recorded locally; the Studio finds each stop the next time it asks Pine. See Output › Pine Drama Studio.`);
		output.show(true);
	}));
}

export function deactivate(): void {
	store?.close();
	// The project window lock is not released here: the OS releases it when this process exits.
}

// Production reads only SecretStorage. An Extension Development Host may use the launcher's explicit file.
async function loadPine(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<PineConfig> {
	// A packaged extension never reads an endpoint/key override or legacy environment file.
	const developerFile = developerConnectionFile(context.extensionMode === vscode.ExtensionMode.Development, process.env.PINE_DRAMA_ENV_FILE);
	if (!developerFile) {
		try {
			const pine = savedConnection(await context.secrets.get(PINE_KEY_SECRET));
			const config: PineConfig = pine ? { kind: 'set', saved: true, file: 'system credential store', pine } : { kind: 'disconnected' };
			output.appendLine(configLine(config));
			return config;
		} catch {
			output.appendLine('Pine: could not read a valid project key from the system credential store.');
			void vscode.window.showErrorMessage('Could not read a valid Pine key from the system credential store. Open Accounts → Pine Computer… to reconnect.');
			return { kind: 'disconnected' };
		}
	}
	let config: PineConfig;
	try { config = pineConfig(developerFile, { text: await readFile(developerFile, 'utf8') }); }
	catch (error) { config = pineConfig(developerFile, { error: error as NodeJS.ErrnoException }); }
	output.appendLine(configLine(config));
	return config;
}
