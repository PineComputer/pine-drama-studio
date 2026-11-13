import { registerReviewCards, reviewCardMarkdown } from './reviewCard';
import { NEW_PROJECT_COMMAND } from './projectCommands';
import * as vscode from 'vscode';
import { activityRow } from './core/activityRow';
import { withoutRepeatedQuestion } from './core/askedOnce';
import { linkFiles } from './core/chatLinks';
import { stopLine, type ReviewView } from './core/reviews';
import { BusyElsewhereError, type ChatFile, type ChatService, type Update } from './core/chats';
import { NoPineError, OtherPineError } from './core/pinePort';
import type { Chat, Message } from './core/store';
import { endpointHost, notSetUpText, PINE_MODEL, sendGate, type PineConfig } from './pineConfig';
import { OPEN_REVIEW_COMMAND, VIEW_ID } from './reviewView';
import { chatRows, NOT_LISTED_YET } from './core/chatPick';
import { sessionTitles } from './core/sessionTitle';
import { itemTiming } from './core/sessionTiming';
import { chatLine, enabledCommands, refusalOf, type Refusal, type RefusalCommands, type Situation } from './core/refusal';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

// Pine Computer Chats in upstream's native Chat (spike S10; section 3).
// The Studio connects to one Pine environment; each session still runs on its own Computer. Upstream resolves a model for every request, accepting
// only the `copilot` vendor as default (extHostLanguageModels.ts, getDefaultLanguageModel), so the extension registers
// one model, "Pine", for its session type. The session type declares neither `requiresCustomModels` nor
// `supportsAutoModel`, so the chat input shows no model picker (chatInputPart.ts, chatSessionHasTargetedModels;
// chatExecuteActions.ts, the picker's `when`), and the input still sends with that model, the only one targeting the
// session type (chatInputModelUtils.ts, filterModelsForSession). The agent on the Computer chooses its own LLM.
// The Chat state lives in core/ (SQLite + the keychain); this file only maps it to the chat.

import { assertProjectRoot } from './core/projectPlace';
import { projectSessions, sessionProjectRoot, type ProjectSessions } from './core/projectSessions';
import { sessionEpisodes, type RowEpisodes } from './core/sessionEpisodes';

const SESSION_TYPE = 'pine-computer';
/** Said once when a reply's view ends: the person cannot cancel the turn, and where its result will be. */
const CANCELLATION_UNAVAILABLE = 'Cancellation is unavailable in this release: the agent keeps working, and its result comes in this conversation.';
/** The tool name of an agent step's row; the row's words are the step's own title (core/activityRow.ts). */
const ACTIVITY_TOOL = 'pine_activity';
const MODEL_VENDOR = 'pine';
const ATTACH_FILES_COMMAND = 'pineDrama.attachFiles';
const OPEN_FOLDER_COMMAND = 'pineDrama.openFolderForDrama';
const NEW_FOLDER_COMMAND = 'pineDrama.newFolderForDrama';
const OPEN_GIVEN_FOLDER_COMMAND = 'pineDrama.openSessionFolder';
const REFUSAL_COMMANDS: RefusalCommands = { openFolder: OPEN_FOLDER_COMMAND, newFolder: NEW_FOLDER_COMMAND, openGivenFolder: OPEN_GIVEN_FOLDER_COMMAND };

/** The window's folders on this computer. */
export function windowFileFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
}

export function registerPineSessions(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	config: PineConfig,
	service: ChatService,
	/** The Review index's submit, and its record of a continuation in flight (reviewView.ts), which the Chat cards show. */
	review: { submitReviewDecisions(key: string, id: string, words?: string): Promise<void>; continuing(id: string): boolean; readonly onDidChangeContinuing: vscode.Event<void> },
): { refresh(key: string): void; scope(): ProjectSessions | undefined } {
	const titleOf = sessionTitles(key => service.projectRoot(key), line => output.appendLine(`${new Date().toISOString()} ${line}`), key => service.chat(key));

	const openFolder = (folder: vscode.Uri) => vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: false });

	/** A file the agent names as `drama/x`, as its place in the drama's mirror when this turn's own file has arrived (core/chatLinks.ts). */
	const filesOf = (key: string) => (turnId: string | undefined) => (relPath: string) => service.projectFile(key, turnId, relPath);
	const toStream = (stream: vscode.ChatResponseStream, key: string, update: Update) => {
		switch (update.kind) {
			case 'progress':
				stream.progress(update.text);
				break;
			case 'activity': {
				const row = activityRow(update);
				const part = new vscode.ChatToolInvocationPart(ACTIVITY_TOOL, row.toolCallId);
				part.invocationMessage = row.invocationMessage;
				part.pastTenseMessage = row.pastTenseMessage;
				part.isComplete = row.isComplete;
				part.enablePartialUpdate = true;
				stream.push(part);
				break;
			}
			case 'markdown':
				// A reply drawn while its turn runs has no evidence yet that its files have arrived: names only, and the
				// plumbing links dropped; the history links what has arrived (core/chatLinks.ts).
				stream.markdown(linkFiles(update.text, filesOf(key)(undefined)));
				break;
			case 'unsent':
				// The person's own words, as typed: no link of theirs is rewritten.
				stream.markdown(update.text);
				break;
			case 'reviewRequired':
				stream.markdown(reviewSubmissionMarkdown(key, update.reviewId, update.text));
				break;
			case 'usage':
				if (showTurnCost()) {
					stream.markdown(update.text);
				}
				break;
			case 'review':
				renderReview(stream, key, update.review);
				break;
			case 'unused':
				// Native Chat's warning part: a result that is not used, with its reason; its detail is in Output.
				stream.warning(update.text);
				break;
			case 'notStarted':
				stream.markdown(`**${update.text}.**`);
				break;
			case 'sessionEnded':
				// The person's next message starts the agent again (ChatService.replacePineSessionAndSend): no button.
				stream.markdown(update.text);
				break;
			case 'unreachable': {
				// VS Code's own end of a lost remote, "Cannot reconnect. Please reload the window." with Reload Window
				// (src/vs/workbench/contrib/remote/browser/remote.ts:1011 at 235ceeb5): a reload attaches to the turn again.
				const line = new vscode.MarkdownString(`\n\n${update.text} [Reload Window](command:${RELOAD_WINDOW})`);
				line.isTrusted = { enabledCommands: [RELOAD_WINDOW] };
				stream.markdown(line);
				break;
			}
		}
	};

	// ---- v1 has no cancellation: the one place a reply's end in Code-OSS lands ----

	/**
	 * A reply's view ended in Code-OSS: it offers no cancel for these chats (chat.requestCancellation.enabled) and no Send to
	 * New Chat (chat.sendToNewChat.enabled), so this is navigation (archiving, the chat closed, a reload). The turn goes on on Pine. This reply stops
	 * reading, so at most one follower of the turn exists; whoever comes next follows it and shows its end: a reopened
	 * chat, the next message's wait, or the resume at start. Said once, by notification: the
	 * ended reply's stream is closed.
	 */
	const replyEnded = (key: string, updates: AsyncGenerator<Update>) => {
		output.appendLine(`${new Date().toISOString()} ${key}: a reply's view ended; the turn goes on, followed by the next reply or at start (D25)`);
		void vscode.window.showInformationMessage(CANCELLATION_UNAVAILABLE);
		void updates.return(undefined);
	};
	/** A reply's updates into its stream, until its view ends (replyEnded). */
	const reply = async (key: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, updates: AsyncGenerator<Update>) => {
		const ended = token.onCancellationRequested(() => replyEnded(key, updates));
		try {
			for await (const update of updates) {
				if (token.isCancellationRequested) {
					break;
				}
				toStream(stream, key, update);
			}
		} catch (error) {
			output.appendLine(`${new Date().toISOString()} error in ${key}: ${(error as Error).stack ?? error}`);
			if (!token.isCancellationRequested) {
				stream.markdown(errorText(error, config));
			}
		} finally {
			ended.dispose();
			refresh(key);
		}
	};

	const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
		const key = chatContext.chatSessionContext?.chatSessionItem.resource.toString();
		if (!key) {
			stream.markdown('**This chat has no Pine session.** Start one from the session target picker.');
			return {};
		}
		// What a send meets first: no Pine environment set up is said before any folder problem, as a window with neither
		// can do nothing about its folder until a Pine environment is set up (sendGate, pineConfig.ts). A session needs
		// exactly one folder, so nothing of a message sent without one reaches Pine.
		// Either is told by one line in the chat with the actions as links (core/refusal.ts; 4.1): no
		// modal over it, which only said the same again, and no stream buttons.
		const tell = (refusal: Refusal) => {
			const line = new vscode.MarkdownString(chatLine(refusal));
			line.isTrusted = { enabledCommands: enabledCommands(refusal) };
			stream.markdown(line);
		};
		const gate = sendGate(config, windowFileFolders());
		if (gate.kind === 'pine') {
			tell(refusalOf({ kind: 'pine', text: gate.text }, REFUSAL_COMMANDS));
			return {};
		}
		// The message comes back in the refusal's line, quoted, with the names of the files it carried.
		const refuse = async (situation: Situation, why: string) => {
			const attached = request.references.map(chatFile).map(file => (file.kind === 'file' ? basename(file.path) : file.name));
			output.appendLine(`${new Date().toISOString()} ${key}: not sent, ${why}; given back with ${attached.length} attachment(s)`);
			tell(refusalOf(situation, REFUSAL_COMMANDS, request.prompt, attached));
			return {};
		};
		const entry = gate.entry;
		if (entry.kind !== 'one') {
			return refuse(entry.kind === 'none' ? { kind: 'none' } : { kind: 'several', count: entry.count }, entry.kind === 'none' ? 'the window has no folder' : `the window has ${entry.count} folders`);
		}
		try { if (root) { assertProjectRoot(entry.folder, root); } }
		catch (error) { return refuse({ kind: 'rootChanged' }, (error as Error).message); }
		// The folder must be one the Studio can bind this session to (core/binding.ts; 4.1; 4.6).
		const binding = service.entry(key, entry.folder);
		switch (binding.kind) {
			case 'unassigned':
				return refuse(binding, 'the project has no admitted executor');
			case 'elsewhere':
				return refuse({ kind: 'elsewhere', folder: binding.folder }, `the session is bound to ${binding.folder}`);
			case 'moved':
				return refuse({ kind: 'rootChanged' }, `the session's project folder is missing or moved: ${binding.folder}`);
			case 'inside':
				return refuse(binding, `the folder holds the drama-cli project ${binding.project}`);
			case 'go':
			case 'adopt':
				break;
			default: {
				const unreachable: never = binding;
				throw new Error(`Unknown project admission: ${JSON.stringify(unreachable)}`);
			}
		}
		// Files added with the chat input's own Add Context go up with the message (core/chats.ts, submitWithFiles).
		await reply(key, stream, token, service.submitWithFiles(key, request.prompt, firstLine(request.prompt), request.references.map(chatFile), entry.folder));
		const review = service.openReview(key)?.review;
		return review ? { metadata: { pineReviewId: review.id } } : {};
	};
	const participant = vscode.chat.createChatParticipant(SESSION_TYPE, handler);

	const contentProvider: vscode.ChatSessionContentProvider = {
		provideChatSessionContent(resource) {
			const key = resource.toString();
			const conv = service.chat(key);
			const project = scope();
			const reservedUnbound = conv?.folder === null && project?.mainKey === key;
			if (conv && (!project || conv.folder !== project.root) && !reservedUnbound) {
				// Native direct resources can bypass the filtered list. Never display/follow foreign history here.
				const message = new vscode.MarkdownString('Open this conversation’s project to read it.');
				if (conv.folder) {
					const destination = vscode.Uri.from({ scheme: 'command', path: 'pineDrama.openSessionProject', query: JSON.stringify([key]) });
					message.appendMarkdown(` [Open Session’s Project](${destination.toString()})`);
					message.isTrusted = { enabledCommands: ['pineDrama.openSessionProject'] };
				}
				return { title: 'Open Session’s Project', history: [new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(message)], {}, SESSION_TYPE)], requestHandler: handler };
			}
			// A reserved, interrupted first-send row is not yet this project's saved history or runtime.
			const visible = conv?.folder === project?.root ? conv : undefined;
			const reviews = visible ? service.reviews(key) : [];
			const history = visible ? toHistory(service.history(key), showTurnCost(), filesOf(key), reviews, key) : [];
			return {
				...(visible ? { title: titleOf(visible.key) ?? visible.label } : project?.mainKey === key ? { title: 'New Session' } : {}),
				history,
				requestHandler: handler,
				// A Chat that ended but still owes the library some files is followed too: attachChatToPineTurn() settles them and
				// sends nothing to the agent.
				...(visible && (visible.state === 'running' || service.hasUnfinishedTurnFollowUp(key)) ? {
					// The reviews this history shows: the follow ends with the card of one that waits and is not among them.
					activeResponseCallback: (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => reply(key, stream, token, service.attachChatToPineTurn(key, new Set(reviews.map(r => r.id)))),
				} : {}),
			};
		},
	};

	let root = sessionProjectRoot(windowFileFolders());
	const scope = (): ProjectSessions | undefined => root ? projectSessions(root, service.chats()) : undefined;
	const reviewCards = registerReviewCards(context, service, output, key => scope()?.chats.some(c => c.key === key) ?? false, (key, id, words) => review.submitReviewDecisions(key, id, words), id => review.continuing(id));
	context.subscriptions.push(review.onDidChangeContinuing(() => reviewCards.refresh()));
	const controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => refresh());
	controller.newChatSessionItemHandler = async () => {
		const project = scope();
		if (!project) {
			// A current unsent request is not global history. The folder refusal gives its message back.
			const item = controller.createChatSessionItem(vscode.Uri.from({ scheme: SESSION_TYPE, path: `/draft-${randomUUID()}` }), 'Choose a project');
			item.timing = itemTiming(undefined, undefined, Date.now());
			controller.items.add(item);
			return item;
		}
		// New Session is a new peer Chat, which its first send binds to the project (entryFor, bindFolder). Until the
		// project has its Project Chat, the new session is that entry.
		const item = project.main ? controller.createChatSessionItem(vscode.Uri.from({ scheme: SESSION_TYPE, path: `/session-${randomUUID()}` }), 'New Session') : mainEntry(project);
		if (project.main) {
			item.metadata = { workingDirectoryPath: project.root };
			item.timing = itemTiming(undefined, undefined, Date.now());
		}
		controller.items.add(item);
		return item;
	};
	const entryCreatedAt = Date.now();
	const mainEntry = (project: ProjectSessions): vscode.ChatSessionItem => {
		const item = controller.createChatSessionItem(vscode.Uri.parse(project.mainKey), 'New Session');
		item.iconPath = new vscode.ThemeIcon('comment-discussion');
		item.description = 'No messages yet';
		item.tooltip = 'This project’s main conversation. Opening it starts no Computer.';
		item.metadata = { workingDirectoryPath: project.root };
		item.timing = itemTiming(undefined, undefined, entryCreatedAt); // Entry creation time, not invented message history.
		return item;
	};
	const toItem = (conv: Chat, rows?: ReadonlyMap<string, RowEpisodes>): vscode.ChatSessionItem => {
		// The row names the work once its project has come back (the brief's Title:), else the first message. It has no
		// description while its Pine is the one the Studio connects to; a session of another Pine says which. An ended Pine session is not the person's to act on, so the row does not say it.
		const item = controller.createChatSessionItem(vscode.Uri.parse(conv.key), titleOf(conv.key) ?? conv.label);
		item.iconPath = new vscode.ThemeIcon(conv.project_role === 'main' ? 'comment-discussion' : 'pine-computer');
		item.metadata = conv.folder ? { workingDirectoryPath: conv.folder } : undefined;
		// The row's episodes in its description, which Code-OSS renders as Markdown with codicons, and an episode another
		// running session also makes with $(warning) and its tooltip (chatSessionsProvider.d.ts:315, :330;
		// agentSessionsViewer.ts:596-598, agentSessionHoverWidget.ts:262).
		const row = rows?.get(conv.key);
		const host = config.kind === 'set' && conv.endpoint === config.pine.endpoint ? undefined : `on ${endpointHost(conv.endpoint)}`;
		const episodes = row?.episodes.map(e => row.shared.has(e) ? `$(warning) ${e}` : e).join(', ');
		item.description = episodes ? new vscode.MarkdownString([episodes, conv.state === 'running' ? 'working' : undefined, host].filter(Boolean).join(' · '), true) : host;
		item.tooltip = row?.shared.size ? [...row.shared].map(([e, others]) => `${e} is also being made in ${others.map(k => titleOf(k) ?? k).join(', ')}`).join('\n') : undefined;
		item.timing = itemTiming(conv.created_at, conv.updated_at, Date.now());
		// A session that waits for the person shows Code-OSS's NeedsInput: a question, or a Review waiting for its decision,
		// unsubmitted with items to decide.
		const waiting = service.openReview(conv.key)?.review;
		const reviewWaits = !!waiting && waiting.items.length > 0 && !waiting.submitted;
		item.status = conv.state === 'running' ? vscode.ChatSessionStatus.InProgress
			: conv.state === 'needs_input' || reviewWaits ? vscode.ChatSessionStatus.NeedsInput
				: conv.state === 'failed' ? vscode.ChatSessionStatus.Failed
					: vscode.ChatSessionStatus.Completed;
		return item;
	};
	const refresh = (_key?: string) => {
		reviewCards.refresh();
		const project = scope();
		const episodes = project && sessionEpisodes(project.chats, key => service.latestTurnFiles(key));
		controller.items.replace(project ? [
			...(project.main ? [] : [mainEntry(project)]),
			...project.chats.map(conv => toItem(conv, episodes)),
		] : []);
	};
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
		root = sessionProjectRoot(windowFileFolders());
		refresh();
	}));


	context.subscriptions.push(
		participant,
		vscode.chat.registerChatSessionContentProvider(SESSION_TYPE, contentProvider, participant),
		controller,
		registerPineModel(),
		vscode.commands.registerCommand(ATTACH_FILES_COMMAND, async () => {
			const chosen = await pickChat(service, 'Attach files to which session?', titleOf);
			if (!chosen) {
				return;
			}
			const { key, label } = chosen;
			const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Attach', title: 'Files for the agent' });
			if (!picked?.length) {
				return;
			}
			try {
				const { added, unread } = await service.attachFiles(key, picked.map(uri => uri.fsPath));
				if (added.length) {
					void vscode.window.showInformationMessage(`Pine: placed in the drama's folder, for the agent of "${label}" with your next message there: ${added.join(', ')}.`);
				}
				if (unread.length) {
					// The file goes as it is; its text, which drama-cli would read, could not be (core/extract.ts).
					void vscode.window.showWarningMessage(`Pine: the text of ${unread.map(u => `${u.name} was not read: ${u.why}`).join('; ')}. The file itself will go as it is.`);
				}
			} catch (error) {
				output.appendLine(`${new Date().toISOString()} attach error in ${key}: ${(error as Error).stack ?? error}`);
				void vscode.window.showErrorMessage(`Pine: could not attach the files: ${(error as Error).message}`);
			}
		}),
		vscode.commands.registerCommand(OPEN_FOLDER_COMMAND, async () => {
			const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Open', title: 'A folder for this drama' });
			if (picked?.length) {
				await openFolder(picked[0]);
			}
		}),
		vscode.commands.registerCommand(OPEN_GIVEN_FOLDER_COMMAND, async (folder: string) => {
			await openFolder(vscode.Uri.file(folder));
		}),
		vscode.commands.registerCommand(NEW_FOLDER_COMMAND, () => vscode.commands.executeCommand(NEW_PROJECT_COMMAND)),
	);
	// Ended turns whose files were not all kept (the Studio stopped, or a read failed) are settled now, with no message sent.
	void service.resumeUnfinishedTurnFollowUps().then(() => {
		for (const conv of service.chats()) {
			refresh(conv.key);
		}
	});
	output.appendLine(`${new Date().toISOString()} chat session type "${SESSION_TYPE}" on ${config.kind === 'set' ? endpointHost(config.pine.endpoint) : 'no Pine environment (not set up)'}; ${service.chats().length} saved conversation(s)`);
	return { refresh, scope };
}

/** Native output-renderer cards update from local state; pure questions retain ordinary Chat. */
function reviewMarkdown(key: string, review: ReviewView): vscode.MarkdownString {
	return review.items.length ? new vscode.MarkdownString(reviewCardMarkdown(key, review.id)) : reviewSubmissionMarkdown(key, review.id, stopLine(review, `command:${VIEW_ID}.focus`));
}

/** The same version-bound submission command from live refusals and reopened pending reviews, never a free-text approval. */
export function reviewSubmissionMarkdown(key: string, reviewId: string, text: string): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	const submit = vscode.Uri.from({ scheme: 'command', path: OPEN_REVIEW_COMMAND, query: JSON.stringify([key, reviewId]) });
	md.isTrusted = { enabledCommands: [OPEN_REVIEW_COMMAND] };
	md.appendMarkdown(`\n\n${text}\n\n[Open review in Chat](${submit.toString()}) to choose Approve or Change, then submit.\n`);
	return md;
}

function renderReview(stream: vscode.ChatResponseStream, key: string, review: ReviewView): void {
	stream.markdown(reviewMarkdown(key, review));
}

/** The Chat a file or project goes to, chosen by the person; the most recently active first (core/chatPick.ts). */
async function pickChat(service: ChatService, title: string, titleOf: (key: string) => string | undefined): Promise<{ key: string; label: string } | undefined> {
	const root = sessionProjectRoot(windowFileFolders());
	const rows = chatRows(root ? projectSessions(root, service.chats()).chats : [], titleOf);
	if (rows.length === 0) {
		void vscode.window.showWarningMessage(`Pine: start a session first, then attach files to it. ${NOT_LISTED_YET}`);
		return undefined;
	}
	return vscode.window.showQuickPick(rows, { title, placeHolder: NOT_LISTED_YET });
}

/**
 * A chat-input reference as a file to send (`ChatPromptReference.value`, vscode.d.ts: a string, a Uri or a Location).
 * A Uri or a Location on a local file sends that file whole; anything else is named as not sent.
 */
function chatFile(reference: vscode.ChatPromptReference): ChatFile {
	const value = reference.value;
	const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
	if (uri?.scheme === 'file') {
		return { kind: 'file', path: uri.fsPath };
	}
	return { kind: 'other', name: uri ? uri.toString() : reference.id, why: uri ? 'not a file on this computer' : 'not a file' };
}

/** The saved messages as chat history: a prompt opens a request; what follows is its response. */
/** `pineDrama.chat.showTurnCost` (package.json): the cost line at the end of a turn in Chat, off by default. */
function showTurnCost(): boolean {
	return vscode.workspace.getConfiguration('pineDrama').get<boolean>('chat.showTurnCost', false);
}

function toHistory(all: readonly Message[], showCost: boolean, files: (turnId: string | undefined) => (relPath: string) => string | undefined, reviews: readonly ReviewView[] = [], key = ''): (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] {
	const messages = withoutRepeatedQuestion(all);
	const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [];
	let parts: (string | vscode.ChatResponseWarningPart)[] = [];
	let turn: string | undefined;
	const rendered = new Set<string>();
	const flush = () => {
		if (parts.length > 0) {
			const review = reviews.find(r => r.turnId === turn && !rendered.has(r.id));
			if (review) { parts.push(reviewCardMarkdown(key, review.id)); rendered.add(review.id); }
			// Consecutive text is one markdown part, as before; an unused result keeps its own native warning part.
			const response: vscode.ChatResponseMarkdownPart[] = [];
			let text: string[] = [];
			const markdown = () => { if (text.length) { response.push(new vscode.ChatResponseMarkdownPart(text.join('\n\n'))); text = []; } };
			for (const part of parts) {
				if (typeof part === 'string') { text.push(part); continue; }
				markdown();
				// Contributed history converts a warning part like a streamed one (extHostTypeConverters.ts, ChatResponsePart.from,
				// `ChatResponseWarningPart`); the proposed d.ts omits it from ChatResponseTurn2.response, hence the cast.
				response.push(part as unknown as vscode.ChatResponseMarkdownPart);
			}
			markdown();
			history.push(new vscode.ChatResponseTurn2(response, review ? { metadata: { pineReviewId: review.id } } : {}, SESSION_TYPE));
			parts = [];
		}
	};
	for (const m of messages) {
		switch (m.kind) {
			case 'prompt':
				flush();
				turn = m.turn_id ?? undefined;
				history.push(new vscode.ChatRequestTurn2(m.text, undefined, [], SESSION_TYPE, [], undefined, undefined, undefined, undefined) as unknown as vscode.ChatRequestTurn);
				break;
			case 'result':
				turn = m.turn_id ?? turn;
				parts.push(linkFiles(m.text, files(m.turn_id ?? undefined)));
				break;
			case 'question':
				turn = m.turn_id ?? turn;
				parts.push(`**The agent asks:** ${linkFiles(m.text, files(m.turn_id ?? undefined))}`);
				break;
			case 'failed':
				parts.push(`**${m.text}**`);
				break;
			case 'unused':
				parts.push(new vscode.ChatResponseWarningPart(m.text));
				break;
			case 'notice':
				// Locally recovered reviews have a task-source notice, without a fabricated Pine result/question.
				if (m.turn_id && m.turn_id !== turn && reviews.some(r => r.turnId === m.turn_id)) {
					flush();
					turn = m.turn_id;
				}
				parts.push(`_${m.text}_`);
				break;
			case 'decision':
				parts.push(`**Your review, as sent to the agent:**\n\n${m.text.split('\n').map(line => `> ${line}`).join('\n')}`);
				break;
			case 'usage':
				if (showCost) {
					parts.push(`_cost of this turn: ${m.cost === null ? 'not priced' : `${m.cost} ${m.currency ?? ''}`}_`);
				}
				break;
		}
	}
	flush();
	// A saved review is actionable even if collection completed before its Chat anchor was recorded.
	// The persisted review row is the source; this does not invent a remote response or a new approval.
	for (const review of reviews.filter(r => r.items.length > 0 && !rendered.has(r.id))) {
		history.push(new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(
			`_Saved review: ${review.subject}._\n\n${reviewCardMarkdown(key, review.id)}`,
		)], { metadata: { pineReviewId: review.id } }, SESSION_TYPE));
	}
	return history;
}

function firstLine(text: string): string {
	return text.split('\n')[0].slice(0, 80);
}

/** Code-OSS's own Reload Window command (ReloadWindowAction.ID, src/vs/workbench/browser/actions/windowActions.ts:372 at 235ceeb5). */
const RELOAD_WINDOW = 'workbench.action.reloadWindow';

/** How an error reaches the chat: Pine's or the Studio's own words (AGENTS coding rule 1). */
function errorText(error: unknown, config: PineConfig): string {
	if (error instanceof NoPineError && config.kind !== 'set') {
		return notSetUpText(config);
	}
	if (error instanceof OtherPineError) {
		return error.message;
	}
	if (error instanceof BusyElsewhereError || error instanceof NoPineError) {
		return `**${error.message}**`;
	}
	return config.kind === 'set'
		? `**Pine error** (\`${endpointHost(config.pine.endpoint)}\`): ${(error as Error).message}`
		: `**Pine error:** ${(error as Error).message}`;
}

/**
 * The chat's one model, registered even when no Pine environment is set up, so a send reaches the handler, which says why nothing
 * was sent. It reports no context window, so the input invents no "Max" size
 * (modelPickerModelConfig.ts:221-225; change 3).
 */
function registerPineModel(): vscode.Disposable {
	const models: vscode.LanguageModelChatInformation[] = [{
		...PINE_MODEL, family: 'pine', version: '1', capabilities: {}, targetChatSessionType: SESSION_TYPE, isUserSelectable: true, isDefault: true,
	}];
	// The workbench caches a vendor's models across restarts; announcing a change makes it ask again, so a profile
	// that cached the environments of before 2026-11-02 shows the one model.
	const changed = new vscode.EventEmitter<void>();
	const registration = vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, {
		onDidChangeLanguageModelChatInformation: changed.event,
		provideLanguageModelChatInformation: () => models,
		async provideLanguageModelChatResponse(_model, _messages, _options, progress) {
			// Only reached if something other than our participant calls the model directly.
			progress.report(new vscode.LanguageModelTextPart('Pine is not a language model.'));
		},
		async provideTokenCount(_model, text) {
			return Math.ceil((typeof text === 'string' ? text : JSON.stringify(text)).length / 4);
		},
	});
	changed.fire();
	return vscode.Disposable.from(registration, changed);
}
