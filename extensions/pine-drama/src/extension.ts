import { registerProjectCommands } from './projectCommands';
import * as vscode from 'vscode';
import { savedConnection, connectionScope, disconnectProblem, developerConnectionFile, PINE_KEY_SECRET } from './core/pineConnection';
import { registerPineConnection, CONNECTION_COMMAND } from './pineConnection';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatService, stopAllSummary } from './core/chats';
import { commitFilesFoundOnDisk } from './core/projectHistory';
import { endpointHost, type SecretVault } from './core/pinePort';
import { setAsideNotice, Store } from './core/store';
import { lockProjectWindow, type ProjectWindowLock } from './core/projectWindowLock';
import { sessionProjectRoot } from './core/projectSessions';
import { configLine, notSetUpText, pineConfig, type PineConfig } from './pineConfig';
import { registerPineSessions, windowFileFolders } from './pineSessions';
import { registerEpisodeCanvas } from './episodeCanvas';
import { cardActions } from './cardActions';
import { registerGalleries } from './galleries';
import { registerSegEditor } from './segEditor';

/** Two views refreshed as one. */
const both = (a: { refresh(): void }, b: { refresh(): void }) => ({ refresh: () => { a.refresh(); b.refresh(); } });
import { registerProjectViews, type ProjectViews } from './projectViews';
import { SdkPort } from './sdkPort';
import { showInChatView } from './chatView';
import { statusText, waitingItems, type WaitingItem } from './core/attention';
import { openProjectChat, projectWindowRestorer, type RestoredProjectChat } from './projectChatNavigation';
import { CHAT_REVEAL_MAX_AGE_MS, FOLDER_REFRESH_MS } from './core/tuning';

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
		// Production says so too, in place of the welcome for a window with no project (package.json, viewsWelcome).
		void vscode.commands.executeCommand('setContext', 'pineDrama.projectElsewhere', true);
		return;
	}
	if (windowLock) { log(`project window lock: ${lockedRoot} (${windowLock.file})`); }
	const held = windowLock?.kind === 'held' ? lockedRoot : undefined;

	// The project views read files only: they register first, whatever happens to the Chat store below.
	// The project may arrive later: a session bound to an empty folder receives its config at the first publication
	// (core/projectFinder.ts). The parts that read it register once, when it first appears.
	let opened: { views: ProjectViews; canvas: { refresh(): void }; galleries: ReturnType<typeof registerGalleries> } | undefined;
	let protocolStorage: string | undefined;
	const projects = await registerProjectViews(context, output, views => {
		const root = views.project.root;
		// Every view reads the folder's files, so a change of them refreshes the tree, the galleries and the canvases a
		// moment after the last one (FOLDER_REFRESH_MS).
		let timer: NodeJS.Timeout | undefined;
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
		const changed = () => {
			clearTimeout(timer);
			timer = setTimeout(() => { views.refresh(); opened?.galleries.refresh(); opened?.canvas.refresh(); }, FOLDER_REFRESH_MS);
		};
		context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed), { dispose: () => clearTimeout(timer) });
		opened = {
			views,
			// An episode's two views of one model: its seg editor and its canvas, refreshed together.
			// The record panel on the canvas runs the grid's card actions (cardActions.ts).
			canvas: both(registerEpisodeCanvas(context, views, output, cardActions(context, root)), registerSegEditor(context, views, output)),
			galleries: registerGalleries(context, views, output),
		};
		// Whatever the folder holds that no commit records, changed by hand or by a Studio stopped mid-change, is committed
		// once as client-found-changes-on-disk (core/projectHistory.ts): from here on, each change the Studio makes is its own commit.
		void commitFilesFoundOnDisk(root, 'Changes found on disk when the project opened')
			.catch(error => log(`project: committing the changes found on disk in ${root}: ${(error as Error).message}`));
	});

	registerProjectCommands(context, output, held);

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
	// The protocol client's storage: each drama's record of its turns (turn.ts TurnRecord), outside the drama's folder.
	protocolStorage = join(connectionRoot, 'protocol');
	opened?.views.refresh();
	const dbPath = join(connectionRoot, 'studio.sqlite');
	try {
		store = new Store(dbPath);
		if (store.setAside) {
			const notice = setAsideNotice(store.setAside);
			log(`conversation store: schema ${store.setAside.schema} database copied aside: ${notice}`);
			void vscode.window.showInformationMessage(`Pine: ${notice}`);
		}
	} catch (error) {
		// A store that cannot be opened (a newer Studio's, or a migration that failed and rolled back) is said once; only Pine's part stops.
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
	let onChanged: (() => void) | undefined;
	const service = new ChatService({
		store,
		port: new SdkPort(),
		vault,
		pine: config.kind === 'set' ? config.pine : undefined,
		connectionCurrent: () => connectionCurrent,
		holdsProject: root => root === held,
		files: {
			projectsRoot: join(connectionRoot, 'projects'),
		},
		protocol: { storage: protocolStorage },
		log,
		onChange: key => {
			sessions?.refresh(key);
			onChanged?.();
			// A stop this window settled may have initialized the project's root; the watcher sees it too, later.
			projects.possibleChange();
		},
	});
	registerPineConnection(context, config, vault, log, () => { connectionCurrent = false; }, () => connectionCurrent, () => disconnectProblem(service.chats()));
	log(`conversation store ${dbPath}`);
	// One title per session wherever it is named: the sessions list, the pickers, the status bar: its first message.
	const titleOf = (key: string) => service.chat(key)?.label;
	sessions = registerPineSessions(context, output, config, service);

	const titled = (conv: { key: string; label: string }) => titleOf(conv.key) ?? conv.label;
	const tabs = {
		active: () => vscode.window.tabGroups.activeTabGroup.activeTab,
		isOpen: (tab: vscode.Tab) => vscode.window.tabGroups.all.some(group => group.tabs.includes(tab)),
		close: (tab: vscode.Tab) => vscode.window.tabGroups.close(tab),
	};
	const showInChat = (key: string) => showInChatView((command, ...args) => vscode.commands.executeCommand(command, ...args), tabs, vscode.Uri.parse(key));

	const openProjectWindow = (key: string) => openProjectChat(key, {
		scope: () => sessions?.scope(),
		chat: key => service.chat(key),
		show: showInChat,
		request: key => studioStore.requestChatReveal(key),
		clear: token => studioStore.clearChatReveal(token),
		open: async root => { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true }); },
	});
	// A named row opens its own project first; the palette opens a project. Neither dispatches work.
	context.subscriptions.push(vscode.commands.registerCommand('pineDrama.openSessionProject', async (row?: vscode.ChatSessionItem | string) => {
		const key = typeof row === 'string' ? row : row?.resource?.toString();
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
	// What waits for the person, and where a click takes them: its session's Chat, or a pick of them (core/attention.ts).
	const waiting = (): WaitingItem[] => waitingItems((sessions?.scope()?.chats ?? []), conv => `${titled(conv)}: the agent asks you something`, titled);
	const goTo = (item: WaitingItem) => openProjectWindow(item.key);
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
	const restoreWindow = projectWindowRestorer({
		scope: () => sessions?.scope(),
		// The private window API reports Local only; L2 awaits native extension-session restoration. No Chat is named, so none is pinned.
		prepare: () => Promise.resolve(vscode.commands.executeCommand<RestoredProjectChat | undefined>('pine.workbench.prepareProjectChat', '')),
		// Code-OSS's Chat: New Chat (chatActions.ts, ACTION_ID_NEW_CHAT).
		fresh: () => Promise.resolve(vscode.commands.executeCommand('workbench.action.chat.newChat')),
		takeRequested: root => studioStore.takeChatReveal(root, CHAT_REVEAL_MAX_AGE_MS),
		show: showInChat,
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
