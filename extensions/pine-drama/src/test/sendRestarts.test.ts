import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { CHANGED_TARGET_NOTE } from '../core/instructions';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { idleStopAndDiscover } from './idleStop';
import { testProtocol } from './protocolFixture';
import { reviewPlan, withoutTask } from './protocolFixture';

// The person, 2026-11-05 (a tester's report on v0.1.4-b1: "Your message was not sent, and is kept as a draft: the session
// it was for has ended … Start the agent again"): a message sent to a session Pine reports ended starts the agent again
// and is sent there, in the same send. Only a restart that does not happen gives it back, quoted in its line.

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const all: Update[] = []; for await (const update of updates) { all.push(update); } return all;
}

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-send-restarts-')));
	const root = join(dir, 'project'); mkdirSync(root);
	const store = new Store(join(dir, 'studio.sqlite'));
	const pine = new FakePine();
	const options = { holdsProject: () => true, store, port: pine, vault: new MemoryVault(), pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
		files: { libraryRoot: join(dir, 'library'), projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir) };
	const service = new ChatService(options);
	const sent = (text: string) => (store.db.prepare("select count(*) as n from saved_sends where text like ? and state = 'sent'").get(`pine-drama-turn %\n${text}%`) as { n: number }).n;
	return { root, store, pine, service, options, sent };
}

test('a send to an ended session starts one new session and sends the message there once, with no "not sent"', async () => {
	const f = fixture();
	try {
		await drain(f.service.submit('main', 'first', 'Project Chat', f.root));
		await idleStopAndDiscover(f.pine, f.store, () => new ChatService(f.options), 'main', f.root);
		const updates = await drain(f.service.submit('main', 'Keep the cast small, please.', 'Project Chat', f.root));
		const said = updates.map(u => u.text).join('\n');
		assert.equal(f.pine.calls.createSession, 2, 'one new session');
		assert.equal(f.sent('Keep the cast small, please.'), 1, 'the message sent once, in it');
		assert.doesNotMatch(said, /not sent/);
		assert.ok(updates.every(u => u.kind !== 'sessionEnded'), 'no ended part, no restart button');
		assert.equal(f.store.chat('main')!.pine_session_state, 'open');
	} finally { f.store.close(); }
});

test('a restart that fails gives the message back and says what failed, in one line', async () => {
	const f = fixture();
	try {
		await drain(f.service.submit('main', 'first', 'Project Chat', f.root));
		await idleStopAndDiscover(f.pine, f.store, () => new ChatService(f.options), 'main', f.root);
		f.pine.fail('ensureComputer', new Error('OFFLINE: no Computer free'));
		const updates = await drain(f.service.submit('main', 'Keep the cast small, please.', 'Project Chat', f.root));
		const lines = updates.filter(u => u.kind !== 'progress');
		assert.equal(lines.length, 1, lines.map(u => u.text).join(' | '));
		assert.match(lines[0].text, /was not sent: the agent could not be started again: OFFLINE: no Computer free[^]*```text\nKeep the cast small, please\.\n```/);
		assert.equal(f.sent('Keep the cast small, please.'), 0);
		assert.equal(f.pine.calls.createSession, 1, 'no new session');
	} finally { f.store.close(); }
});

// A tester's 412 "binding revision conflict" on v0.1.4-b1 came from two restarts racing on one Computer (the old button
// clicked twice). Two quick sends after the session ended start one restart: the second waits in the Chat's send queue
// behind the first, whose restart it then finds done, and goes as its own turn.
test('two quick sends after the session ended start one restart; the second goes as its own turn in the new session', async () => {
	const f = fixture();
	try {
		await drain(f.service.submit('main', 'first', 'Project Chat', f.root));
		await idleStopAndDiscover(f.pine, f.store, () => new ChatService(f.options), 'main', f.root);
		const starts = f.pine.calls.ensureComputer ?? 0;
		const [a, b] = await Promise.all([
			drain(f.service.submit('main', 'Keep the cast small.', 'Project Chat', f.root)),
			drain(f.service.submit('main', 'And make it rain.', 'Project Chat', f.root)),
		]);
		assert.equal((f.pine.calls.ensureComputer ?? 0) - starts, 1, 'the Computer was started once');
		assert.equal(f.pine.calls.createSession, 2, 'one new session, not two');
		assert.equal(f.sent('Keep the cast small.'), 1);
		assert.equal(f.sent('And make it rain.'), 1, 'its own turn');
		assert.equal(f.pine.calls.run, 3, 'the first message, then one turn each');
		assert.equal([...a, ...b].filter(u => /does not remember earlier turns/.test(u.text)).length, 1, 'one restart said');
	} finally { f.store.close(); }
});

// A start Pine did not confirm (another start overtook it, 412) is never retried (the SDK's model).
// In a send's restart it gives the message back, in one line, sends
// nothing and leaves the Computer reserved; the person's next send reconciles that Computer and is sent there.
test('a send whose restart Pine did not confirm gives the message back, retries nothing, and the next send goes', async () => {
	const f = fixture();
	try {
		await drain(f.service.submit('main', 'first', 'Project Chat', f.root));
		await idleStopAndDiscover(f.pine, f.store, () => new ChatService(f.options), 'main', f.root);
		const starts = f.pine.calls.ensureComputer ?? 0;
		const runs = f.pine.calls.run ?? 0;
		const release = f.pine.hold('ensureComputer');
		const send = drain(f.service.submit('main', 'Keep the cast small, please.', 'Project Chat', f.root));
		for (let i = 0; (f.pine.calls.ensureComputer ?? 0) === starts && i < 500; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
		// Another start of this Computer is accepted first: the binding revision moves on.
		const computer = f.pine.computers.get(f.store.chat('main')!.computer_id!)!;
		computer.state = 'running'; computer.revision += 1; computer.binding = `bind-${computer.id}-winner`; computer.sessions.clear();
		release();
		const lines = (await send).filter(u => u.kind !== 'progress');
		assert.equal(lines.length, 1, lines.map(u => u.text).join(' | '));
		assert.match(lines[0].text, /was not sent: the agent could not be started again: Pine did not confirm this start of the Computer[^]*```text\nKeep the cast small, please\.\n```/);
		assert.doesNotMatch(lines[0].text, /Start the agent again/, 'no such button any more: sending again is the retry');
		assert.equal((f.pine.calls.ensureComputer ?? 0) - starts, 1, 'no automatic retry');
		assert.equal((f.pine.calls.run ?? 0) - runs, 0, 'nothing was sent');
		assert.equal(f.pine.calls.createSession, 1, 'no new session');
		assert.equal(f.store.chat('main')!.computer_state, 'creating', 'the unconfirmed start stays reserved');
		// The person sends it again (copied from the line): the same Computer is reconciled and it goes.
		const again = await drain(f.service.submit('main', 'Keep the cast small, please.', 'Project Chat', f.root));
		assert.doesNotMatch(again.map(u => u.text).join('\n'), /not sent/);
		assert.equal(f.sent('Keep the cast small, please.'), 1);
		assert.equal(f.pine.calls.createSession, 2);
		assert.equal(f.store.chat('main')!.pine_session_state, 'open');
	} finally { f.store.close(); }
});

// The live case behind the two quick sends: the session ended while it waited for an answer, and Pine's stop is found
// only by the first send. The second message was written against that question, which ended with its session; it goes
// as the first does, against what the new session starts from (replacePineSessionAndSend), not refused as "moved on".
test('two quick sends to a session that ended waiting for an answer: one restart, and both messages go', async () => {
	const f = fixture();
	try {
		f.pine.plans.push({ state: 'needs_input', text: 'Which episode?' });
		await drain(f.service.submit('main', 'first', 'Project Chat', f.root));
		assert.equal(f.store.chat('main')!.state, 'needs_input');
		// Pine's idle stop, not yet seen by the Studio.
		const computer = f.pine.computers.get(f.store.chat('main')!.computer_id!)!;
		computer.state = 'stopped'; computer.sessions.clear();
		const starts = f.pine.calls.ensureComputer ?? 0;
		const [a, b] = await Promise.all([
			drain(f.service.submit('main', 'Keep the cast small.', 'Project Chat', f.root)),
			drain(f.service.submit('main', 'And make it rain.', 'Project Chat', f.root)),
		]);
		const said = [...a, ...b].map(u => u.text).join('\n');
		assert.doesNotMatch(said, /not sent/);
		assert.equal((f.pine.calls.ensureComputer ?? 0) - starts, 1, 'the Computer was started once');
		assert.equal(f.pine.calls.createSession, 2, 'one new session');
		assert.equal(f.sent('Keep the cast small.'), 1);
		assert.equal(f.sent('And make it rain.'), 1);
	} finally { f.store.close(); }
});

// A live run: the message that found the session ended at Pine (its run refused, the
// stop not yet seen) was shown twice in the Chat, with its Review decision twice: once for the attempt that never reached
// Pine, once for the resend. The person sent it once; the resend carries that attempt's prompt and decision.
test('a message whose run finds the session ended is shown once, with its Review decision once, after the restart', async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-send-restarts-review-')));
	const root = join(dir, 'project'); mkdirSync(root);
	const store = new Store(join(dir, 'studio.sqlite'));
	const pine = new FakePine();
	const service = new ChatService({ holdsProject: () => true, store, port: pine, vault: new MemoryVault(), pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
		files: { libraryRoot: join(dir, 'library'), projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir) });
	try {
		pine.plans = [reviewPlan([{ object: 'screenplay', version: 'v1' }])];
		await drain(service.submit('main', 'make the screenplay', 'Project Chat', root));
		const review = service.openReview('main')!.review;
		service.approveAll('main', review.id);
		await service.recordReviewDecisionsLocally('main', review.id);
		// Pine's idle stop, not yet seen by this window: the run is what finds it.
		const computer = pine.computers.get(store.chat('main')!.computer_id!)!;
		computer.state = 'stopped'; computer.sessions.clear();
		pine.plans = [{ state: 'completed', text: 'Carried on, with a small cast.' }];
		await drain(service.submit('main', 'Keep the cast small, please.', 'Project Chat', root));
		const history = store.messages('main');
		assert.equal(history.filter(m => m.kind === 'prompt' && m.text === 'Keep the cast small, please.').length, 1, 'one message');
		const decisions = history.filter(m => m.kind === 'decision');
		assert.equal(decisions.length, 1, 'its decision once');
		const prompt = history.find(m => m.kind === 'prompt' && m.text === 'Keep the cast small, please.')!;
		const sent = store.savedSend(prompt.saved_send_id!)!;
		assert.equal(sent.state, 'sent', 'shown with the operation that reached Pine');
		assert.equal(decisions[0].saved_send_id, sent.id);
		const starts = history.findIndex(m => /^The agent starts again/.test(m.text));
		assert.ok(history.indexOf(prompt) < starts, 'the message as the person sent it, then the restart');
	} finally { store.close(); }
});

// Audit item 12: a message whose question changed while it waited is sent with the note; when the
// session it goes to has ended, the Studio starts the agent again and sends it there, and the note goes with it.
test('a message whose question changed, sent to a session that then ended, goes to the new session with its note', async () => {
	const f = fixture();
	try {
		f.pine.plans.push({ state: 'needs_input', text: 'Which episode?' }, { state: 'needs_input', text: 'Which scene?' });
		await drain(f.service.submit('main', 'draw the storyboard', 'Project Chat', f.root));
		const release = f.pine.hold('run');
		const first = drain(f.service.submit('main', 'EP001', 'Project Chat', f.root));
		for (let i = 0; (f.pine.calls.run ?? 0) < 2 && i < 500; i++) { await new Promise(r => setTimeout(r, 10)); }
		// Written for "Which episode?", which EP001 is answering: it waits behind it in the window's queue.
		const second = drain(f.service.submit('main', 'EP002 instead', 'Project Chat', f.root));
		await new Promise(resolve => setImmediate(resolve));
		// Its keychain read waits, and meanwhile Pine stops the Computer: the send finds the session ended.
		(f.options.vault as MemoryVault).getDelay = 200;
		release();
		await first;
		assert.equal(f.store.chat('main')!.state, 'needs_input', 'EP001 was answered with "Which scene?"');
		const computer = f.pine.computers.get(f.store.chat('main')!.computer_id!)!;
		computer.state = 'stopped'; computer.sessions.clear();
		const said = (await second).map(u => u.text).join('\n');
		assert.match(said, /What your message was written for changed while it waited/);
		assert.doesNotMatch(said, /not sent/);
		assert.equal(f.pine.calls.createSession, 2, 'one new session');
		assert.equal(f.sent('EP002 instead'), 1, 'sent once, in the new session');
		const op = f.store.db.prepare("select id, text from saved_sends where text like 'pine-drama-turn %' || char(10) || 'EP002 instead%' and state = 'sent'").get() as { id: string; text: string };
		assert.ok(withoutTask(op.text).startsWith(`EP002 instead\n\n${CHANGED_TARGET_NOTE}`), op.text);
		assert.ok(f.store.messages('main').some(m => m.kind === 'instructions' && m.text === CHANGED_TARGET_NOTE && m.saved_send_id === op.id), 'the note is recorded with the send that went');
	} finally { f.store.close(); }
});
