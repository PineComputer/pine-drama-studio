import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import type { ChatService } from '../core/chats';
import type { ReviewFile, ReviewView } from '../core/reviews';
import { REVIEW_CARD_NOT_ISSUED, REVIEW_CARD_OTHER_PROJECT } from '../core/reviewCardProtocol';
import { card } from './reviewCardPage';

let renderer: vscode.ChatOutputRenderer;
const calls: string[] = [];
const logged: string[] = [];
/** What the next submit waits for; resolved at once unless a test holds it. */
let submitting: Promise<void> = Promise.resolve();
/** What the Review index says of the continuation (reviewView.ts, continuing). */
let continuingNow = false;
const disposable = () => ({ dispose() {} });
/** A URI that keeps its scheme, as vscode.Uri does: joinPath keeps the base's, file() is file:. */
type FakeUri = { scheme: string; path: string; fsPath: string; toString(): string };
const uri = (scheme: string, path: string): FakeUri => ({ scheme, path, fsPath: path, toString: () => `${scheme}://${path}` });
const native = {
	chat: { registerChatOutputRenderer: (_name: string, value: vscode.ChatOutputRenderer) => { renderer = value; return disposable(); } },
	Uri: { joinPath: (base: FakeUri, ...parts: string[]) => uri(base.scheme, [base.path, ...parts].join('/')), file: (path: string) => uri('file', path) },
	commands: { executeCommand: async (name: string) => { calls.push(name); } },
};
const symbol = Symbol.for('pine.review.card.host.test');
const globals = globalThis as unknown as Record<symbol, unknown>;
globals[symbol] = native;
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-card-test:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-card-test:vscode' ? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.review.card.host.test")]', shortCircuit: true } : next(url, context),
});
let cardModule: typeof import('../reviewCard');
try { cardModule = require('../reviewCard') as typeof import('../reviewCard'); }
finally { hook.deregister(); delete globals[symbol]; }

async function fixture(started: boolean, belongs: (key: string) => boolean = () => true, failure?: Error, files: ReviewFile[] = []) {
	calls.length = 0; logged.length = 0;
	const messages: { error?: string; thumbnails?: Record<string, (string | undefined)[]> }[] = [];
	const review: ReviewView = { id: 'r', turnId: 't', createdAt: '2026-11-06T00:00:00.000Z', kind: 'files', subject: 'files', question: '', state: 'open', submitted: false,
		items: [{ key: 'one', label: 'One', files }], verdicts: { one: { verdict: 'revise', reason: 'Saved reason' } } };
	const service = { review: () => review, projectRoot: () => '/fixture', savedReviewWords: () => started ? 'saved consent' : undefined,
		decideItem: () => { if (started) { throw new Error('submission has started'); } calls.push('save-note'); },
		approveAll: () => { calls.push('approve-all'); },
		reviewFileSha: (file: ReviewFile) => file.sha,
		preview: (sha: string, relPath: string, folder: string) => join(folder, `${sha}${relPath.slice(relPath.lastIndexOf('.'))}`),
	} as unknown as ChatService;
	// On desktop the extension's global storage is a vscode-userdata: URI (Code-OSS userDataProfile.ts:353).
	const context = { subscriptions: [], extensionUri: uri('file', '/offline/extension'),
		globalStorageUri: uri('vscode-userdata', '/offline/user-data/User/globalStorage/pine.pine-drama') };
	cardModule.registerReviewCards(context as unknown as vscode.ExtensionContext, service,
		{ appendLine: (line: string) => { logged.push(line); } } as unknown as vscode.OutputChannel, belongs,
		async () => { calls.push('submit'); await submitting; if (failure) { throw failure; } }, () => continuingNow);
	let receive!: (value: unknown) => Promise<void>;
	const target = { onDidDispose: disposable, webview: { cspSource: 'offline:', asWebviewUri: (value: unknown) => value,
		onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return disposable(); },
		postMessage: (value: { error?: string; thumbnails?: Record<string, (string | undefined)[]> }) => { messages.push(value); return Promise.resolve(true); },
	} } as unknown as vscode.ChatOutputWebview;
	const payload = cardModule.reviewCardMarkdown('conversation', 'r').split('\n').find(line => line.startsWith('{'))!;
	if (belongs('conversation')) { await renderer.renderChatOutput({ mime: 'text/plain', value: Buffer.from(payload) }, target, {}, {} as vscode.CancellationToken); }
	return { receive, messages, target, payload };
}

test('a partially recorded mixed review retries without trying to edit its locked notes', async () => {
	const f = await fixture(true);
	await f.receive({ version: 1, action: 'submit', notes: { one: 'Saved reason' }, words: '' });
	assert.deepEqual(calls, ['submit']);
	assert.equal(f.messages.some(m => m.error), false);
});

test('a fresh submission flushes its current note before committing', async () => {
	const f = await fixture(false);
	await f.receive({ version: 1, action: 'submit', notes: { one: 'Newest unblurred reason' }, words: '' });
	assert.deepEqual(calls, ['save-note', 'submit']);
});

test('a card Submit that fails shows its reason in the card', async () => {
	const f = await fixture(true, () => true, new Error('choices.json could not be written: disk full'));
	await f.receive({ version: 1, action: 'submit', notes: {}, words: '' });
	assert.deepEqual(f.messages.filter(m => m.error).map(m => m.error), ['choices.json could not be written: disk full']);
});

test('model-authored review identities cannot create an actionable card', async () => {
	const f = await fixture(false);
	await assert.rejects(async () => renderer.renderChatOutput({ mime: 'text/plain', value: Buffer.from(JSON.stringify({ version: 1, token: 'invented', key: 'conversation', id: 'r' })) },
		f.target, {}, {} as vscode.CancellationToken), { message: REVIEW_CARD_NOT_ISSUED });
});

test('a card issued for another project says so, not that it was never issued', async () => {
	const f = await fixture(false, key => key !== 'conversation');
	await assert.rejects(async () => renderer.renderChatOutput({ mime: 'text/plain', value: Buffer.from(f.payload) },
		f.target, {}, {} as vscode.CancellationToken), { message: REVIEW_CARD_OTHER_PROJECT });
});


test('history rendering keeps the same locally issued navigation capability for the exact review', () => {
 const first = cardModule.reviewCardMarkdown('owner', 'review');
 assert.equal(cardModule.reviewCardMarkdown('owner', 'review'), first);
 assert.notEqual(cardModule.reviewCardMarkdown('other-owner', 'review'), first);
 assert.notEqual(cardModule.reviewCardMarkdown('owner', 'other-review'), first);
});

test('a review action sent while a submission is saving waits for it, and ready does not', async () => {
	const f = await fixture(false);
	let release!: () => void;
	submitting = new Promise(resolve => { release = resolve; });
	try {
		const first = f.receive({ version: 1, action: 'submit', notes: {}, words: '' });
		const second = f.receive({ version: 1, action: 'submit', notes: {}, words: '' });
		const third = f.receive({ version: 1, action: 'approveAll' });
		const shown = f.messages.length;
		await f.receive({ version: 1, action: 'ready' });
		// `ensureLivePineSession` renders at once, behind no queue.
		assert.equal(f.messages.length, shown + 1);
		await new Promise(resolve => setImmediate(resolve));
		// Approve all has not run: the submission's verdicts are those of the click.
		assert.deepEqual(calls, ['submit']);
		release();
		await Promise.all([first, second, third]);
		assert.deepEqual(calls, ['submit', 'submit', 'approve-all']);
		assert.equal(f.messages.some(m => m.error), false);
	} finally { submitting = Promise.resolve(); }
});

test("a picture's thumbnail lies under one of the card's local resource roots, so the webview may load it", async () => {
	const sha = 'a'.repeat(64);
	const f = await fixture(false, () => true, undefined, [{ relPath: 'assets/characters/ann/v1/image-1.jpg', sha, here: true } as ReviewFile]);
	await f.receive({ version: 1, action: 'ready' });
	const thumbnail = f.messages.at(-1)?.thumbnails?.one?.[0];
	assert.ok(thumbnail, 'the card is sent a thumbnail for the picture');
	// The webview's own check: same scheme and a path under the root (Code-OSS resourceLoading.ts:136-159).
	const roots = (f.target.webview.options.localResourceRoots ?? []).map(String);
	assert.ok(roots.some(root => thumbnail.startsWith(`${root}/`)), `${thumbnail} is under none of ${roots.join(', ')}`);
});

// After Chat is hidden and shown, upstream reloads the card's page in the SAME webview: the
// host's webview object and its message subscription stay (mainThreadWebviews.ts:75-90 hooks them once, until dispose;
// webviewElement.ts:660-667 only reloads the page). So the reloaded page must be fully live: its ready answered, its
// actions answered, its Submit reaching the host. The real host renderer (reviewCard.ts) and the real page script
// (media/reviewCard.js) are joined here, through a reload.
test('a reloaded card is live: its ready is answered, its actions are answered, and Submit reaches the host', async () => {
	const f = await fixture(false);
	const inFlight: Promise<void>[] = [];
	const connect = (state?: unknown) => card({ state, onPost: message => { inFlight.push(f.receive(message)); } });
	let delivered = 0;
	/** Lets the host answer what the page sent, then hands the page every host message it has not seen. */
	const settle = async (page: ReturnType<typeof card>) => {
		while (inFlight.length) { await Promise.all(inFlight.splice(0)); }
		for (const message of f.messages.slice(delivered)) { page.render(message); }
		delivered = f.messages.length;
	};
	const text = (page: ReturnType<typeof card>) => page.root.all().map(n => n.textContent).join(' ');
	const first = connect();
	await settle(first);
	assert.match(text(first), /Review · files · 1 item/, 'the first load is answered');
	// Upstream's reinitialize: a new page in the same webview, its state given back.
	const answeredBefore = f.messages.length;
	const again = connect(first.state());
	assert.match(text(again), /Review · files · 1 item/, 'first frame: the cached card, never an empty frame');
	await settle(again);
	assert.ok(f.messages.length > answeredBefore, 'the reloaded page\'s ready is answered by the host');
	// An action from the reloaded page is answered.
	const approve = again.root.all().find(n => n.tag === 'button' && n.dataset.verdict === 'approve')!;
	const answered = f.messages.length;
	approve.onclick!();
	await settle(again);
	assert.ok(f.messages.length > answered, 'its action is answered');
	// Submit from the reloaded page reaches the host.
	const submit = again.root.all().find(n => n.tag === 'button' && /Submit and continue|Retry continuation/.test(n.textContent))!;
	assert.equal(submit.disabled, false);
	submit.onclick!();
	await settle(again);
	assert.ok(calls.includes('submit'), 'Submit reaches the host');
});

test('the card says whether the review\'s continuation is being sent, as the Review index records it', async () => {
	continuingNow = true;
	try {
		const f = await fixture(true);
		await f.receive({ version: 1, action: 'ready' });
		assert.equal((f.messages.at(-1) as { continuing?: boolean }).continuing, true);
		continuingNow = false;
		await f.receive({ version: 1, action: 'ready' });
		assert.equal((f.messages.at(-1) as { continuing?: boolean }).continuing, false);
	} finally { continuingNow = false; }
});

test('a card logs its rendering, and what its webview reports, with the session and review id', async () => {
	const f = await fixture(false);
	assert.match(logged[0], /review card r in session conversation, project \/fixture: rendering/);
	await f.receive({ version: 1, action: 'report', message: 'render failed: TypeError' });
	assert.match(logged.at(-1)!, /review card r in session conversation, project \/fixture: webview reported: render failed: TypeError/);
	assert.deepEqual(calls, [], 'a report changes nothing');
});
