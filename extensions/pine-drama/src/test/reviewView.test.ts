import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store';
import { resolveReturned } from '../core/resolve';
import { hash } from './protocolFixture';
import type * as vscode from 'vscode';
import { ChatService } from '../core/chats';
import type { ReviewView } from '../core/reviews';

// Exercise the actual workbench glue. This host supplies native APIs only; it never implements acceptance.
const commands = new Map<string, (...args: unknown[]) => unknown>();
const calls: unknown[][] = [];
let provider: vscode.TreeDataProvider<unknown>;

const disposable = () => ({ dispose() {} });
const view = { visible: true, message: undefined as string | undefined, badge: undefined,
	onDidChangeVisibility: disposable, dispose() {}, reveal: async (node: unknown, options: unknown) => { calls.push(['reveal', node, options]); } };
const native = {
	EventEmitter: class { event = disposable; fire() {} dispose() {} },
	TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class { constructor(public id: string) {} }, ThemeColor: class { constructor(public id: string) {} },
	MarkdownString: class {
		value = ''; isTrusted: unknown;
		appendMarkdown(text: string) { this.value += text; return this; }
	},
	Uri: { file: (path: string) => ({ fsPath: path }), from: ({ scheme, path, query }: { scheme: string; path: string; query: string }) => {
		const url = new URL(`${scheme}:${path}`); url.search = encodeURIComponent(query); return { toString: () => url.href };
	} },
	commands: {
		registerCommand: (name: string, command: (...args: unknown[]) => unknown) => { commands.set(name, command); return disposable(); },
		executeCommand: async (...args: unknown[]) => { calls.push(['command', ...args]); },
	},
	window: {
		createTreeView: (_id: string, options: { treeDataProvider: vscode.TreeDataProvider<unknown> }) => { provider = options.treeDataProvider; return view; },
		onDidChangeWindowState: disposable,
		showInputBox: async (options: unknown) => { calls.push(['input', options]); return undefined; },
		showWarningMessage: async (text: string) => { calls.push(['warning', text]); },
		showErrorMessage: async (text: string) => { calls.push(['error', text]); },
	},
};
const symbol = Symbol.for('pine.review.native.test');
const globals = globalThis as unknown as Record<symbol, unknown>;
globals[symbol] = native;
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-test:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-test:vscode'
		? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.review.native.test")]', shortCircuit: true } : next(url, context),
});
let reviewModule: typeof import('../reviewView');
let reviewSubmissionMarkdown: typeof import('../pineSessions').reviewSubmissionMarkdown;
try {
	reviewModule = require('../reviewView') as typeof import('../reviewView');
	({ reviewSubmissionMarkdown } = require('../pineSessions') as typeof import('../pineSessions'));
} finally { hook.deregister(); delete globals[symbol]; }

function setup(verdict: 'approve' | 'revise' | null = 'approve') {
	calls.length = 0; commands.clear();
	let committing: () => Promise<void> = async () => {};
	let current: ReviewView | undefined = { id: 'review-a', turnId: 'turn-a', createdAt: '2026-11-06T00:00:00.000Z', kind: 'screenplay', subject: 'the screenplay',
		question: 'OFFLINE: review this fixture.', state: 'open', items: [{ key: 'screenplay/v3', label: 'screenplay v3', files: [] }],
		withdrawn: [], verdicts: verdict ? { 'screenplay/v3': { verdict, reason: '' } } : {} };
	const service = {
		projectRoot: (key: string) => key === 'a' ? '/fixture' : '/elsewhere',
		reviews: (key: string) => key === 'a' && current ? [current] : [],
		chats: () => [{ key: 'a', folder: '/fixture' }], chat: () => ({ label: 'OFFLINE' }),
		openReview: (key: string) => key === 'a' && current ? { review: current, folder: '/fixture' } : undefined,
		savedReviewWords: () => undefined,
		recordReviewDecisionsLocally: async (...args: unknown[]) => { calls.push(['commit', ...args]); await committing(); if (current) { current.submitted = true; } return 'Exact recorded feedback.'; },
	} as unknown as ChatService;
	const api = reviewModule.registerReviewView({ subscriptions: [] } as unknown as vscode.ExtensionContext,
		{ appendLine: (text: string) => calls.push(['log', text]) } as unknown as vscode.OutputChannel,
		service, () => 'OFFLINE');
	api.scope('/fixture');
	return { api, service, hold: (work: () => Promise<void>) => { committing = work; }, setReview: (review: ReviewView | undefined) => { current = review; }, review: () => current! };
}
const submit = async (...args: unknown[]) => commands.get(reviewModule.SUBMIT_COMMAND)!(...args);
/** The index's first group and its first review row ("Review index grouped by episode"). */
const firstReview = async () => { const [group] = (await provider.getChildren())!; return (await provider.getChildren(group))![0]; };
const shownErrors = () => calls.filter(c => c[0] === 'error').map(c => c[1]);


test('Review is a compact index: an approved draft keeps an empty circle and opens its exact Chat message', async () => {
	setup();
	const entry = await firstReview();
	const row = await provider.getTreeItem(entry);
	assert.equal((row.iconPath as vscode.ThemeIcon).id, 'circle-large-outline');
	assert.deepEqual(await provider.getChildren(entry), []);
	await commands.get(row.command!.command)!(...row.command!.arguments!);
	assert.deepEqual(calls.filter(c => c[0] === 'chat' || c[0] === 'command'), [
		['command', 'pine.workbench.revealReview', 'a', 'review-a', calls.find(c => c[1] === 'pine.workbench.revealReview')?.[4]],
	]);
	const token = calls.find(c => c[1] === 'pine.workbench.revealReview')?.[4];
	assert.equal(typeof token, 'string');
	await commands.get(row.command!.command)!(...row.command!.arguments!);
	assert.equal(calls.at(-1)?.[4], token);
	assert.equal(calls.some(c => c[0] === 'chat' || c[0] === 'input' || c[0] === 'commit'), false);
});

test('the index is grouped: a project-wide review under Project, which says how many batches wait, a whole draft counting', async () => {
	setup('approve'); // every item decided, not submitted
	const groups = (await provider.getChildren())!;
	assert.equal(groups.length, 1);
	const group = await provider.getTreeItem(groups[0]);
	assert.equal(group.label, 'Project');
	assert.equal(group.collapsibleState, native.TreeItemCollapsibleState.Expanded);
	assert.equal(group.description, '1 waiting', 'a draft with every item decided waits until its Submit records');
	assert.equal(group.accessibilityInformation?.label, 'Project, 1 review waiting');
	assert.equal((await provider.getChildren(groups[0]))!.length, 1);
});

test('explicit Submit records before continuation, preserves the Chat draft, and only then shows a circled check', async () => {
	setup(); await submit('a', 'review-a');
	// The command (banner, Review index) has no Anything else field: it records with no words of the person's.
	assert.deepEqual(calls.filter(c => c[0] === 'commit' || c[0] === 'chat'), [['commit', 'a', 'review-a', '']]);
	assert.ok(calls.some(c => c[1] === 'pine.workbench.openReviewChat' && c[2] === 'a'));
	assert.ok(calls.some(c => c[0] === 'command' && c[1] === 'workbench.action.chat.open' &&
		(c[2] as { preserveInput: boolean }).preserveInput));
	assert.equal(calls.some(c => c[0] === 'input'), false);
	const row = await provider.getTreeItem(await firstReview());
	assert.equal((row.iconPath as vscode.ThemeIcon).id, 'pass');
	const group = await provider.getTreeItem((await provider.getChildren())![0]);
	assert.equal(group.description, undefined, 'a recorded batch no longer waits');
});

test('stale and foreign links cannot submit another review or open an approval input', async () => {
	setup();
	await submit('a', 'old-review'); await submit('b', 'review-a');
	assert.deepEqual(shownErrors(), ['Pine: This review is no longer waiting in this project.', 'Pine: This review is no longer waiting in this project.']);
	assert.equal(calls.some(c => ['input', 'commit', 'chat'].includes(String(c[0]))), false);
});

test('an incomplete review cannot commit or continue', async () => {
	setup(null);
	await submit('a', 'review-a');
	assert.deepEqual(shownErrors(), ['Pine: Choose Approve or Change for every item before submitting.']);
	assert.equal(calls.some(c => ['input', 'commit', 'chat'].includes(String(c[0]))), false);
});

test('repeated clicks share one commit; changing window scope refuses a later submission', async () => {
	const f = setup(); let finish!: () => void;
	f.hold(() => new Promise(resolve => { finish = resolve; }));
	const first = submit('a', 'review-a'); await submit('a', 'review-a');
	assert.equal(calls.filter(c => c[0] === 'commit').length, 1);
	finish(); await first;
	const g = setup(); g.api.scope('/elsewhere');
	await submit('a', 'review-a');
	assert.deepEqual(shownErrors(), ['Pine: This review is no longer waiting in this project.']);
	assert.equal(calls.some(c => c[0] === 'commit'), false);
});

test('all-send-back submission needs no approval input', async () => {
	setup('revise'); await submit('a', 'review-a');
	assert.equal(calls.some(c => c[0] === 'input'), false);
	assert.deepEqual(calls.find(c => c[0] === 'commit'), ['commit', 'a', 'review-a', '']);
});

// Upstream's banner sends a rejection to the console only (chatReadOnlyBanner.ts:50), so the commands it
// runs show their own failures and resolve.
test('a banner Submit whose recording fails shows its reason, logs the stack, and resolves', async () => {
	const f = setup();
	(f.service as unknown as { recordReviewDecisionsLocally(): Promise<string> }).recordReviewDecisionsLocally = async () => {
		throw new Error('choices.json could not be written: disk full');
	};
	assert.equal(await submit('a', 'review-a'), undefined);
	assert.deepEqual(shownErrors(), ['Pine: choices.json could not be written: disk full']);
	const log = calls.find(c => c[0] === 'log' && String(c[1]).includes('submitting a review failed'));
	assert.match(String(log?.[1]), /session a, project \/fixture: Error: choices\.json could not be written: disk full\n\s+at /);
	assert.equal(calls.some(c => c[1] === 'workbench.action.chat.open'), false, 'nothing continues after a failed recording');
});

test('the Card keeps the rejecting submit: its failure is shown in the card, not twice', async () => {
	const f = setup(null);
	await assert.rejects(f.api.submitReviewDecisions('a', 'review-a'), /every item/);
	assert.deepEqual(shownErrors(), []);
});

test('a banner "Review items" for a review no longer here shows why and resolves', async () => {
	setup();
	assert.equal(await commands.get(reviewModule.OPEN_REVIEW_COMMAND)!('a', 'gone'), undefined);
	assert.deepEqual(shownErrors(), ['Pine: This review is unavailable in the current project.']);
	assert.equal(calls.some(c => c[1] === 'pine.workbench.revealReview'), false);
});

test('the Chat recovery link navigates exact IDs without granting submission', () => {
	const key = 'pine-computer:/a?x="\u4e2d\u6587"'; const id = 'review/#"quoted"';
	const md = reviewSubmissionMarkdown(key, id, '**Not sent:** review required.');
	const uri = new URL(md.value.match(/\[Open review in Chat\]\(([^)]+)\)/)![1]);
	assert.equal(uri.pathname, reviewModule.OPEN_REVIEW_COMMAND);
	assert.deepEqual(JSON.parse(decodeURIComponent(uri.search.slice(1))), [key, id]);
	assert.deepEqual(md.isTrusted, { enabledCommands: [reviewModule.OPEN_REVIEW_COMMAND] });
	assert.doesNotMatch(md.value, /input at the top|own words/);
});


test('Review file command opens hash-matching local input bytes and refuses changed, missing or escaping files', async () => {
	const f = setup();
	const root = mkdtempSync(join(tmpdir(), 'pine-review-open-'));
	const store = new Store(join(root, 'studio.sqlite'));
	const path = join(root, 'bible.md');
	const sha = hash('existing Bible');
	f.service.resolveReturned = (_key, remote, expected) => resolveReturned({ store, root, boundary: root, key: 'a', has: () => false }, remote, expected, true);
	const open = () => commands.get('pineDrama.review.openFile')!('a', 'drama/bible.md', sha);
	try {
		writeFileSync(path, 'existing Bible');
		await open();
		assert.ok(calls.some(c => c[1] === 'vscode.open' && (c[2] as { fsPath: string }).fsPath === path));
		for (const alteration of ['changed', 'missing', 'escaping']) {
			calls.length = 0;
			if (alteration === 'changed') { writeFileSync(path, 'different bytes'); }
			if (alteration === 'missing') { rmSync(path); }
			if (alteration === 'escaping') {
				const outside = join(mkdtempSync(join(tmpdir(), 'pine-review-outside-')), 'bible.md');
				writeFileSync(outside, 'existing Bible'); symlinkSync(outside, path);
			}
			await open();
			assert.equal(calls.some(c => c[1] === 'vscode.open'), false, alteration);
			assert.ok(calls.some(c => c[0] === 'warning'), alteration);
		}
	} finally { store.close(); }
});

// The person's run, 2026-11-06: one Submit sent the answer as a turn, and the same text sat in Chat's Queued list to be
// sent again. chat.open returns once its request is dispatched unless asked to wait (blockOnResponse,
// chatActions.ts:420); the guard ended there, the card offered Retry continuation while the continuation was still
// being sent, and a second submit went to upstream's queue behind the first (chatWidget.ts:3997-3999). This host's
// chat.open behaves as upstream's: it returns at once, or, with blockOnResponse, when the response completes.
test('one continuation at a time: a Retry while the continuation runs sends no second copy; after it ends, Retry sends again', async () => {
	setup();
	const executeCommand = native.commands.executeCommand;
	let endTurn!: () => void;
	native.commands.executeCommand = async (...args: unknown[]) => {
		calls.push(['command', ...args]);
		if (args[0] === 'workbench.action.chat.open' && (args[1] as { blockOnResponse?: boolean }).blockOnResponse) {
			await new Promise<void>(resolve => { endTurn = resolve; });
		}
	};
	try {
		const opens = () => calls.filter(c => c[1] === 'workbench.action.chat.open').length;
		await submit('a', 'review-a');
		assert.equal(opens(), 1, 'the continuation is sent');
		// The card offers Retry continuation (the review is submitted, still open until the continuation is recorded).
		await submit('a', 'review-a');
		assert.equal(opens(), 1, 'a Retry while it runs sends no second copy');
		assert.deepEqual(shownErrors(), []);
		endTurn();
		await new Promise(resolve => setImmediate(resolve));
		await submit('a', 'review-a');
		assert.equal(opens(), 2, 'once it has ended, Retry continuation sends it again');
		endTurn();
	} finally { native.commands.executeCommand = executeCommand; }
});

// The record the card reads (reviewCard.ts, continuing): a continuation is in flight from Submit until its response
// completes, and every change is announced so the Chat cards update.
test('a continuation is recorded in flight from Submit until its response completes, and each change is announced', async () => {
	const { api } = setup();
	const executeCommand = native.commands.executeCommand;
	let endTurn!: () => void;
	native.commands.executeCommand = async (...args: unknown[]) => {
		calls.push(['command', ...args]);
		if (args[0] === 'workbench.action.chat.open' && (args[1] as { blockOnResponse?: boolean }).blockOnResponse) {
			await new Promise<void>(resolve => { endTurn = resolve; });
		}
	};
	try {
		assert.equal(api.continuing('review-a'), false);
		await submit('a', 'review-a');
		assert.equal(api.continuing('review-a'), true, 'while its continuation is sent and runs');
		endTurn();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(api.continuing('review-a'), false, 'once its response completes');
	} finally { native.commands.executeCommand = executeCommand; }
});

// The person still saw the blue button briefly. Every step of Submit, from the moment the submission is recorded (the
// review then reads as submitted and still open) until the continuation's response completes, holds the record the card
// reads, so no card drawn meanwhile offers Retry (media/reviewCard.js: Retry only when submitted, open and not continuing).
test('no step of Submit leaves a submitted, open review not continuing: no card drawn meanwhile offers Retry', async () => {
	const f = setup();
	const executeCommand = native.commands.executeCommand;
	let endTurn!: () => void;
	const offersRetry: string[] = [];
	const look = (step: string) => {
		const review = f.review();
		if (review.submitted && review.state === 'open' && !f.api.continuing(review.id)) { offersRetry.push(step); }
	};
	native.commands.executeCommand = async (...args: unknown[]) => {
		calls.push(['command', ...args]);
		look(`before ${String(args[0])}`);
		if (args[0] === 'workbench.action.chat.open' && (args[1] as { blockOnResponse?: boolean }).blockOnResponse) {
			await new Promise<void>(resolve => { endTurn = resolve; });
		}
		look(`after ${String(args[0])}`);
	};
	// The moment the submission is recorded, inside recordReviewDecisionsLocally: the store's write announces the change and the Chat
	// cards repaint then (extension.ts onChange → reviewCards.refresh), before recordReviewDecisionsLocally returns.
	f.hold(async () => { f.review().submitted = true; look('the submission recorded'); });
	try {
		await submit('a', 'review-a');
		look('after Submit returned');
		assert.deepEqual(offersRetry, [], 'no intermediate state offers Retry');
		// Once the response completes and nothing sends the continuation, Retry is the recovery again.
		endTurn();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.api.continuing('review-a'), false);
	} finally { native.commands.executeCommand = executeCommand; }
});
