import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { ChatService, type Update } from '../core/chats';
import type { PineConfig } from '../pineConfig';
import { Store } from '../core/store';
import { associateProject } from './storeFixture';

// Native API stand-in exercises the actual provider, including filtered replacement and direct-resource history.
const disposable = () => ({ dispose() {} });
class Uri {
	constructor(readonly value: string, readonly fsPath = '', readonly scheme = 'pine-computer') {}
	static parse(value: string) { return new Uri(value); }
	static file(path: string) { return new Uri(`file://${path}`, path, 'file'); }
	static from(value: { scheme: string; path: string; query?: string }) { return new Uri(`${value.scheme}:${value.path}${value.query ? `?${encodeURIComponent(value.query)}` : ''}`, '', value.scheme); }
	toString() { return this.value; }
}
let folders: { uri: Uri }[] = [];
let workspaceChanged: () => void;
let refreshList: () => void;
let controller: vscode.ChatSessionItemController;
let content: vscode.ChatSessionContentProvider;
let handler: vscode.ChatRequestHandler;
const archiveListeners = new Set<(item: vscode.ChatSessionItem) => void>();
const listed = new Map<string, vscode.ChatSessionItem>();
const calls: unknown[][] = [];
const commands = new Map<string, (...args: string[]) => Promise<void>>();
const native = {
	Uri, Location: class {}, ThemeIcon: class { constructor(readonly id: string) {} },
	EventEmitter: class { event = disposable; fire() {} dispose() {} }, Disposable: { from: disposable },
	ChatSessionStatus: { InProgress: 1, NeedsInput: 2, Failed: 3, Completed: 0 },
	MarkdownString: class { value: string; isTrusted: unknown; constructor(value = '') { this.value = value; } appendMarkdown(value: string) { this.value += value; return this; } },
	ChatResponseMarkdownPart: class { constructor(readonly value: unknown) {} },
	ChatResponseCommandButtonPart: class { constructor(readonly value: unknown) {} },
	ChatResponseWarningPart: class { constructor(readonly warning: unknown) {} },
	ProgressLocation: { Notification: 15 },
	ChatResponseTurn2: class { constructor(readonly response: unknown[], readonly result: unknown) {} },
	ChatRequestTurn2: class { constructor(readonly prompt: string) {} },
	commands: { registerCommand: (id: string, command: (...args: string[]) => Promise<void>) => { commands.set(id, command); return disposable(); }, executeCommand: async (...args: unknown[]) => { calls.push(['command', ...args]); } },
	lm: { registerLanguageModelChatProvider: disposable },
	workspace: {
		get workspaceFolders() { return folders; },
		onDidChangeWorkspaceFolders: (listener: () => void) => { workspaceChanged = listener; return disposable(); },
		getConfiguration: () => ({ get: () => false }),
	},
	window: {
		withProgress: async (options: unknown, task: (progress: { report(update: unknown): void }) => Promise<void>) => {
			calls.push(['progress-start', options]);
			try { await task({ report: update => { calls.push(['progress', update]); } }); }
			finally { calls.push(['progress-end']); }
		},
		showInformationMessage: async (...args: unknown[]) => { calls.push(['info', ...args]); },
		showErrorMessage: async (...args: unknown[]) => { calls.push(['error', ...args]); },
		showWarningMessage: async (...args: unknown[]) => { calls.push(['warning', ...args]); },
	},
	chat: {
		registerChatOutputRenderer: disposable,
		createChatParticipant: (_id: string, requestHandler: vscode.ChatRequestHandler) => { handler = requestHandler; return disposable(); },
		registerChatSessionContentProvider: (_id: string, provider: vscode.ChatSessionContentProvider) => { content = provider; return disposable(); },
		createChatSessionItemController: (_id: string, refresh: () => void) => {
			refreshList = refresh;
			controller = {
				...disposable(), onDidChangeChatSessionItemState: (listener: (item: vscode.ChatSessionItem) => void) => { archiveListeners.add(listener); return { dispose: () => archiveListeners.delete(listener) }; },
				createChatSessionItem: (resource: vscode.Uri, label: string) => ({ resource, label }),
				items: {
					add: (item: vscode.ChatSessionItem) => { listed.set(item.resource.toString(), item); },
					replace: (items: vscode.ChatSessionItem[]) => { listed.clear(); items.forEach(item => listed.set(item.resource.toString(), item)); },
				},
			} as unknown as vscode.ChatSessionItemController;
			return controller;
		},
	},
};
const symbol = Symbol.for('pine.sessions.native.test');
const globals = globalThis as unknown as Record<symbol, unknown>; globals[symbol] = native;
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-session-test:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-session-test:vscode' ? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.sessions.native.test")]', shortCircuit: true } : next(url, context),
});
let registerPineSessions: typeof import('../pineSessions').registerPineSessions;
try { ({ registerPineSessions } = require('../pineSessions') as typeof import('../pineSessions')); }
finally { hook.deregister(); delete globals[symbol]; }

function fixture(windowRoot?: string) {
	calls.length = 0; listed.clear(); archiveListeners.clear();
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-native-sessions-')));
	const other = join(root, 'other'); mkdirSync(other);
	folders = windowRoot === 'empty' ? [] : [{ uri: Uri.file(windowRoot ?? root) }];
	const store = new Store(':memory:');
	// The version folders each Chat's latest return brought (ChatService.latestTurnFiles).
	const turnFiles = new Map<string, string[]>();
	const service = {
		stopComputer: async (...args: unknown[]) => { calls.push(['stopComputer', ...args]); return 'stopped'; },
		chats: () => store.chats(), chat: (key: string) => store.chat(key),
		projectRoot: (key: string) => store.chat(key)?.folder ?? undefined,
		latestTurnFiles: (key: string) => turnFiles.get(key) ?? [],
		reviews: () => [], resumeUnfinishedTurnFollowUps: async () => {}, hasUnfinishedTurnFollowUp: () => false, openReview: () => undefined,
		history: (key: string) => { calls.push(['history', key]); return []; },
		entry: (key: string, folder: string) => { calls.push(['entry', key, folder]); return { kind: 'go' }; },
		submitWithFiles: async function* (key: string, ...args: unknown[]): AsyncGenerator<Update> { calls.push(['send', key, ...args]); },
	} as unknown as ChatService;
	const config: PineConfig = { kind: 'set', file: 'offline', pine: { endpoint: 'https://pine.test', apiKey: 'offline-not-a-key' } };
	const api = registerPineSessions({ subscriptions: [] } as unknown as vscode.ExtensionContext, { appendLine() {} } as unknown as vscode.OutputChannel, config, service, { submitReviewDecisions: async () => { calls.push(['submit']); }, continuing: () => false, onDidChangeContinuing: () => ({ dispose() {} }) });
	const add = (key: string, folder: string, role: 'main' | 'episode') => {
		store.insertChat({ key, label: 'OFFLINE fixture', env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
		associateProject(store, key, folder, role === 'main' ? { kind: 'main' } : null);
	};
	return { root, other, store, service, api, add, turnFiles };
}
const request = async (key: string, prompt: string, files: string[] = []) => handler(
	{ prompt, references: files.map(path => ({ id: path, value: Uri.file(path) })) } as unknown as vscode.ChatRequest,
	{ chatSessionContext: { chatSessionItem: { resource: Uri.parse(key) } } } as unknown as vscode.ChatContext,
	{ markdown: (text: unknown) => { calls.push(['markdown', text]); } } as unknown as vscode.ChatResponseStream,
	{ isCancellationRequested: false, onCancellationRequested: disposable } as unknown as vscode.CancellationToken,
);
/** What the handler drew in the chat, as Markdown text. */
const said = () => calls.filter(c => c[0] === 'markdown').map(c => (c[1] as { value: string }).value).join('\n');

test('the actual native provider replaces its list with this project only; foreign refresh cannot reinsert a row', async () => {
	const f = fixture(); f.add('main', f.root, 'main'); f.add('episode', f.root, 'episode'); f.add('foreign', f.other, 'main');
	await refreshList();
	assert.deepEqual([...listed.keys()].sort(), ['episode', 'main']);
	assert.equal(listed.get('main')!.label, 'OFFLINE fixture', 'the pinned session is titled by its first message, as every session is');
	assert.equal(f.api.scope()!.mainKey, 'main', 'its role, which the native pin follows (prepareProjectChat), is unchanged');
	f.api.refresh('foreign'); assert.equal(listed.has('foreign'), false);
	folders = []; workspaceChanged(); assert.equal(listed.size, 0);
	assert.equal(f.store.chats().length, 3);
	assert.equal(calls.some(c => c[0] === 'send'), false);
	f.store.close();
});

test('opening/defaulting/new-chat selection uses one unsent main entry and neither persists history nor sends work', async () => {
	const f = fixture(); await refreshList();
	const key = f.api.scope()!.mainKey;
	const item = await controller.newChatSessionItemHandler!({} as Parameters<NonNullable<vscode.ChatSessionItemController['newChatSessionItemHandler']>>[0], {} as vscode.CancellationToken);
	assert.equal(item.resource.toString(), key);
	assert.equal(item.status, undefined);
	const session = await content.provideChatSessionContent(item.resource, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
	assert.equal(session!.title, 'New Session'); assert.deepEqual(session!.history, []);
	assert.equal(session!.activeResponseCallback, undefined);
	assert.equal(f.store.chats().length, 0);
	assert.equal(calls.some(c => ['send', 'entry'].includes(String(c[0]))), false);
	await request(key, 'OFFLINE explicit send'); assert.equal(calls.filter(c => c[0] === 'send').length, 1);
	f.store.close();
});

// In a project whose Project Chat exists, New Session is a new Chat. The
// handler names the real session the untitled one becomes, as upstream's materialization contract has it
// (chatServiceImpl.ts:1685-1698); its first send binds it to the project (entryFor, bindFolder). The person's live test on
// ffabe1b: the new session became the busy Project Chat and could not send.
test('New Session in a project with a Project Chat is a new Chat in that project; its send goes to it, not to Project Chat', async () => {
	const f = fixture(); f.add('main', f.root, 'main'); f.add('episode', f.root, 'episode');
	await refreshList();
	const before = f.store.chats().map(c => c.key).sort();
	const item = await controller.newChatSessionItemHandler!({} as Parameters<NonNullable<vscode.ChatSessionItemController['newChatSessionItemHandler']>>[0], {} as vscode.CancellationToken);
	const key = item.resource.toString();
	assert.ok(!before.includes(key), `${key} is a new Chat`);
	assert.deepEqual([item.label, item.metadata], ['New Session', { workingDirectoryPath: f.root }]);
	const again = await controller.newChatSessionItemHandler!({} as Parameters<NonNullable<vscode.ChatSessionItemController['newChatSessionItemHandler']>>[0], {} as vscode.CancellationToken);
	assert.notEqual(again.resource.toString(), key, 'each New Session is its own Chat');
	const session = await content.provideChatSessionContent(item.resource, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
	assert.deepEqual(session!.history, []);
	assert.deepEqual(f.store.chats().map(c => c.key).sort(), before, 'nothing is saved before its first send');
	await request(key, 'OFFLINE do episode 3');
	assert.deepEqual(calls.filter(c => c[0] === 'send').map(c => c[1]), [key]);
	f.store.close();
});

// The description names the turn's episodes; one another running session also makes is
// marked, with a tooltip naming it.
test('session rows name the episodes of their latest return, nothing before any, and mark an episode two running sessions make', async () => {
	const f = fixture(); f.add('main', f.root, 'main'); for (const key of ['a', 'b', 'c', 'quiet']) { f.add(key, f.root, 'episode'); }
	const read = (key: string, path: string) => { f.turnFiles.set(key, [...(f.turnFiles.get(key) ?? []), path]); };
	for (const key of ['a', 'b', 'c', 'quiet']) { f.store.updateChat(key, { state: 'running' }); }
	read('a', 'drama/episodes/EP004/breakdown/v1/breakdown.json');
	read('b', 'drama/episodes/EP004/storyboard/v1/shot-01.png');
	read('c', 'drama/episodes/EP005/notes.md');
	f.turnFiles.set('main', ['drama/episodes/EP003/notes', 'drama/episodes/EP004/notes']);
	await refreshList();
	const shown = (key: string) => { const d = listed.get(key)!.description; return typeof d === 'string' || d === undefined ? d : d.value; };
	assert.equal(shown('main'), 'EP003, EP004', 'an ended turn: what was imported, no warning');
	assert.equal(shown('a'), '$(warning) EP004 · working');
	assert.equal(shown('b'), '$(warning) EP004 · working');
	assert.equal(listed.get('a')!.tooltip, 'EP004 is also being made in OFFLINE fixture');
	assert.equal(shown('c'), 'EP005 · working'); assert.equal(listed.get('c')!.tooltip, undefined);
	assert.equal(shown('quiet'), undefined, 'nothing before any file: the native "Working..." stays');
	f.store.close();
});

test('direct foreign resources cannot display history or attach an active response in this project or an empty window', async () => {
	const f = fixture(); f.add('foreign', f.other, 'main'); f.store.updateChat('foreign', { state: 'running' });
	for (const empty of [false, true]) {
		if (empty) { folders = []; workspaceChanged(); }
		const session = await content.provideChatSessionContent(Uri.parse('foreign') as unknown as vscode.Uri, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
		assert.equal(session!.title, 'Open Session’s Project'); assert.equal(session!.activeResponseCallback, undefined);
		assert.equal(calls.some(c => c[0] === 'history'), false);
	}
	f.store.close();
});

test('a refused no-project send gives its text back and names its files, without creating a session or dispatching', async () => {
	const f = fixture('empty');
	const item = await controller.newChatSessionItemHandler!({} as Parameters<NonNullable<vscode.ChatSessionItemController['newChatSessionItemHandler']>>[0], {} as vscode.CancellationToken);
	await request(item.resource.toString(), 'OFFLINE give my message back', [join(f.root, 'script.fountain')]);
	assert.match(said(), /These attachments need adding again: `script\.fountain`\.[^]*```text\nOFFLINE give my message back\n```/);
	assert.equal(calls.some(c => ['send', 'entry'].includes(String(c[0]))), false);
	assert.equal(f.store.chats().length, 0);
	f.store.close();
});

test('an interrupted reserved main remains an empty entry, never exposes unbound history or follows its runtime', async () => {
	const f = fixture(); const key = f.api.scope()!.mainKey;
	f.store.insertChat({ key, env: 'offline', endpoint: 'https://pine.test', label: 'Interrupted', secret_ref: 'offline' });
	try {
		f.store.updateChat(key, { state: 'running', computer_id: 'unattributed-computer' });
		await refreshList();
		assert.equal(listed.get(key)!.description, 'No messages yet');
		const session = await content.provideChatSessionContent(Uri.parse(key) as unknown as vscode.Uri, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
		assert.equal(session!.title, 'New Session'); assert.deepEqual(session!.history, []);
		assert.equal(session!.activeResponseCallback, undefined);
		assert.equal(calls.some(c => ['send', 'history', 'entry'].includes(String(c[0]))), false);
		assert.equal(f.store.chat(key)!.folder, null, 'navigation never repairs or adopts execution evidence');
	} finally { f.store.close(); }
});

test('an alias retargeted before the first send gives the message back and never assigns its main entry to the new project', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-native-alias-')));
	const a = join(root, 'a'); const b = join(root, 'b'); mkdirSync(a); mkdirSync(b);
	const alias = join(root, 'alias'); symlinkSync(a, alias);
	const f = fixture(alias); const key = f.api.scope()!.mainKey;
	unlinkSync(alias); symlinkSync(b, alias);
	await request(key, 'OFFLINE keep the right project');
	assert.match(said(), /```text\nOFFLINE keep the right project\n```/);
	assert.equal(calls.some(c => ['send', 'entry'].includes(String(c[0]))), false);
	assert.equal(f.api.scope()!.root, a);
	f.store.close();
});


test('a question-only stop restores its review card and exact-message anchor', async () => {
	const f = fixture(); f.add('main', f.root, 'main');
	f.service.history = () => [
		{ kind: 'prompt', text: 'Make a screenplay', turn_id: null },
		{ kind: 'question', text: 'Review this version?', turn_id: 'turn-question' },
	] as ReturnType<ChatService['history']>;
	f.service.reviews = () => [{ id: 'review-question', turnId: 'turn-question', createdAt: '2026-11-06T00:00:00.000Z', kind: 'screenplay', subject: 'screenplay', question: 'Review?', state: 'open',
		items: [{ key: 'screenplay/v1', label: 'Screenplay v1', files: [] }], withdrawn: [], verdicts: {} }];
	const session = await content.provideChatSessionContent(Uri.parse('main') as unknown as vscode.Uri, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
	const responses = session.history as vscode.ChatResponseTurn2[];
	const response = responses.find(r => r.result?.metadata?.pineReviewId === 'review-question');
	assert.ok(response, 'the exact review has a durable response anchor');
	assert.match(JSON.stringify(response.response), /pine-review/);
});

for (const hasNotice of [false, true]) {
	test(`recovered review restores an actionable exact-message anchor ${hasNotice ? 'from its local notice' : 'when its old message is missing'}`, async () => {
		const f = fixture(); f.add('main', f.root, 'main');
		try {
			f.service.history = () => [
				{ kind: 'prompt', text: 'Make a screenplay', turn_id: null },
				{ kind: 'notice', text: 'The earlier session ended.', turn_id: null },
				...(hasNotice ? [{ kind: 'notice', text: 'Studio recovered a saved result. Review its files below.', turn_id: 'studio-task:saved-task' }] : []),
			] as ReturnType<ChatService['history']>;
			f.service.reviews = () => [{ id: 'recovered-review', turnId: 'studio-task:saved-task', createdAt: '2026-11-06T00:00:00.000Z', kind: 'screenplay', subject: 'screenplay', question: 'Recovered review', state: 'open',
				items: [{ key: 'screenplay/v1', label: 'Screenplay v1', files: [] }], withdrawn: [], verdicts: {} }];
			const session = await content.provideChatSessionContent(Uri.parse('main') as unknown as vscode.Uri, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
			const responses = (session.history as vscode.ChatResponseTurn2[]).filter(r => r.result?.metadata?.pineReviewId === 'recovered-review');
			assert.equal(responses.length, 1, 'Review index has one exact native Chat destination');
			assert.match(JSON.stringify(responses[0].response), /pine-review/);
			assert.match(JSON.stringify(responses[0].response), /recover|Recover|Saved review/);
		} finally { f.store.close(); }
	});
}

test('a result that is not used is a native warning part of its own in the history, between the notices around it', async () => {
	const f = fixture(); f.add('main', f.root, 'main');
	try {
		f.service.history = () => [
			{ kind: 'prompt', text: 'Draw Lin', turn_id: null },
			{ kind: 'notice', text: 'Before.', turn_id: null },
			{ kind: 'unused', text: 'This task\'s result was not used: x does not match its hash.', turn_id: null },
			{ kind: 'notice', text: 'After.', turn_id: null },
		] as ReturnType<ChatService['history']>;
		const session = await content.provideChatSessionContent(Uri.parse('main') as unknown as vscode.Uri, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
		const response = (session.history as vscode.ChatResponseTurn2[]).find(r => Array.isArray(r.response))!;
		const parts = response.response as unknown as { value?: unknown; warning?: unknown }[];
		assert.equal(parts.length, 3, 'text, the unused result, text');
		assert.ok(parts[1] instanceof native.ChatResponseWarningPart);
		assert.match(String(parts[1].warning), /result was not used: x does not match its hash/);
		assert.match(String(parts[0].value), /Before/); assert.match(String(parts[2].value), /After/);
	} finally { f.store.close(); }
});

test('reopening an ended Chat offers no restart button and sends nothing: the next message starts the agent again', async () => {
	const f = fixture(); f.add('main', f.root, 'main');
	try {
		f.store.updateChat('main', { pine_session_state: 'ended', computer_state: 'stopped' });
		const opened = await content.provideChatSessionContent(Uri.parse('main') as unknown as vscode.Uri, {} as vscode.CancellationToken, {} as Parameters<vscode.ChatSessionContentProvider['provideChatSessionContent']>[2]);
		assert.doesNotMatch(JSON.stringify(opened.history), /startNewSession|Start the agent again/);
		assert.equal(calls.some(c => c[0] === 'send'), false);
		assert.equal(commands.has('pineDrama.startNewSession'), false, 'no restart command remains');
	} finally { f.store.close(); }
});

test('native Archive and Unarchive never stop idle or running remote work or mutate its saved history', async () => {
	for (const state of ['idle', 'running'] as const) {
		const f = fixture(); f.add('main', f.root, 'main');
		f.store.updateChat('main', { state, computer_state: 'running', pine_session_state: 'open' });
		await refreshList();
		const before = f.store.chat('main');
		const history = f.store.messages('main');
		const item = listed.get('main')!;
		for (const archived of [true, false]) {
			item.archived = archived;
			for (const listener of archiveListeners) listener(item);
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(f.store.chat('main'), before);
			assert.deepEqual(f.store.messages('main'), history);
			assert.equal(calls.some(c => ['send', 'entry', 'stopComputer'].includes(String(c[0]))), false);
		}
		f.store.close();
	}
});

test('a session whose Review waits shows NeedsInput in the Sessions list, as a question does; a submitted one and a running one do not', async () => {
	const f = fixture(); f.add('main', f.root, 'main'); f.add('episode', f.root, 'episode');
	const { NeedsInput, Completed, InProgress } = native.ChatSessionStatus;
	// The waiting Reviews the service would return (ChatService.openReview), by Chat.
	const reviews = new Map<string, { id: string; items: unknown[]; withdrawn: unknown[]; submitted?: boolean }>();
	(f.service as unknown as { openReview: (key: string) => unknown }).openReview = key => {
		const review = reviews.get(key);
		return review && { review, folder: f.root };
	};
	const status = async (key: string) => { await refreshList(); return listed.get(key)!.status; };
	assert.equal(await status('episode'), Completed);
	reviews.set('episode', { id: 'r1', items: [{ key: 'bible' }], withdrawn: [] });
	assert.equal(await status('episode'), NeedsInput, 'a Review waits for the person');
	assert.equal(await status('main'), Completed, 'only its own Chat');
	reviews.set('episode', { id: 'r1', items: [{ key: 'bible' }], withdrawn: [], submitted: true });
	assert.equal(await status('episode'), Completed, 'submitted: its continuation runs, nothing waits for the person');
	f.store.updateChat('main', { state: 'needs_input' });
	assert.equal(await status('main'), NeedsInput, 'a question, as before');
	reviews.set('main', { id: 'r2', items: [{ key: 'cast' }], withdrawn: [] });
	f.store.updateChat('main', { state: 'running' });
	assert.equal(await status('main'), InProgress, 'running work shows as running');
	f.store.close();
});
