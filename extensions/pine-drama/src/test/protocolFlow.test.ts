// A Chat's turns end to end over the fake Pine, whose sessions' working directories are real folders where the Studio's
// commands run in bash: the project goes up before the message, what the agent changed lands at the Pine turn's end
// however it ended, and a session's next turn goes only after its last is settled.
import { git } from '../core/git';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { UnconfirmedError, type PinePort } from '../core/pinePort';
import { MIGRATIONS, Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { testProtocol } from './protocolFixture';
import { IDLE_WORKING_SECONDS } from '../core/tuning';


async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const all: Update[] = []; for await (const update of updates) { all.push(update); } return all;
}

/** A turn that draws `object`'s picture: one file the agent writes in the drama's folder. */
const made = (object: string, picture: string) => ({ [`drama/${object}/picture.png`]: picture });

function fixture(more: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-protocol-flow-')));
	const root = join(dir, 'drama'); mkdirSync(root);
	const path = join(dir, 'studio.sqlite');
	const store = new Store(path);
	const pine = new FakePine();
	// `failTurnEnd`: the first capture of the drama's folder after a turn started fails, as a Computer that does not answer.
	const control = { failTurnEnd: false };
	const port = new Proxy(pine, { get: (target, name) => {
		if (name === 'exec') {
			return (...args: Parameters<FakePine['exec']>) => {
				if (control.failTurnEnd && (target.calls.run ?? 0) > 0 && args[2].includes(' add -A')) { control.failTurnEnd = false; return Promise.reject(new Error('the Computer did not answer')); }
				return target.exec(...args);
			};
		}
		const value = Reflect.get(target, name, target) as unknown;
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
	} });
	const options = { holdsProject: () => true, turnEndGraceMs: 0, store, port, vault: new MemoryVault(), pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
		files: { projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir), ...more };
	const service = new ChatService(options);
	/** The Studio started again on the same vault, as after a crash, on `opened` (the same store unless it was reopened); `calls` replace some of its Pine's. */
	const restarted = (calls: Partial<PinePort> = {}, opened: Store = store) => new ChatService({ ...options, store: opened, port: new Proxy(port, {
		get: (target, name) => name in calls ? calls[name as keyof PinePort] : Reflect.get(target, name, target),
	}) });
	const send = (text: string, key = 'main') => drain(service.submit(key, text, key === 'main' ? 'Project Chat' : 'Session', [], root));
	/** The drama's folder on the Computer of a Chat's session. */
	const drama = (key = 'main') => join(pine.workdirOf(store.chat(key)!.pine_session_name!), 'drama');
	const said = (updates: Update[]) => updates.map(u => u.text).join('\n');
	return { root, path, store, pine, service, send, drama, said, control, restarted };
}

test('a turn\'s message is the person\'s words, what its agent changed lands as a pine-computer commit, and the next turn starts from it', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/umbrella', 'umbrella') }];
		const updates = await f.send('draw the umbrella');
		// While the turn's last results come in, the Chat says so, before the turn's last words.
		const bringing = updates.findIndex(u => u.kind === 'progress' && /^Bringing the turn's last results into your project/.test(u.text));
		assert.ok(bringing >= 0 && bringing < updates.findIndex(u => u.kind === 'markdown' && /drawn/.test(u.text)), JSON.stringify(updates.map(u => [u.kind, u.text])));
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella');
		const [author, turn] = (await git(['log', '-1', '--format=%an|%(trailers:key=Pine-Turn-Id,valueonly,separator=)'], f.root)).stdout.trim().split('|');
		assert.equal(author, 'pine-computer');
		assert.ok(f.store.savedSendsOfTurn('main', turn)[0].text.startsWith('draw the umbrella'), 'the trailer names Pine\'s turn, whose message is the person\'s words, first');
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		assert.equal(f.pine.calls.writeFile, 2, 'one bundle part a put: the second holds only what the Computer lacks');
		assert.equal(readFileSync(join(f.drama(), 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella');
	} finally { f.store.close(); }
});

test('a turn Pine ended failed keeps what its agent changed, and the Chat says the work broke off', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'failed', files: made('assets/props/a', 'a') }];
		assert.match(f.said(await f.send('draw a and b')), /\*\*The work broke off\.\*\*/);
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a', 'what it finished is in the project');
		assert.equal(f.store.chat('main')?.state, 'failed');
	} finally { f.store.close(); }
});

test('a session\'s next turn waits until its last one is settled, and then starts from it', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failTurnEnd = true;
		const end = f.said(await f.send('draw a'));
		assert.match(end, /could not be brought into your project[^]*tried again at your next message/);
		assert.equal(existsSync(join(f.root, 'assets/props/a/picture.png')), false);
		f.pine.plans = [{ state: 'completed', text: 'ok', files: made('assets/props/b', 'b') }];
		await f.send('next');
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a', 'the earlier turn is settled first');
		const turns = (await git(['log', '--format=%(trailers:key=Pine-Turn-Id,valueonly,separator=)', '--author=pine-computer'], f.root)).stdout.trim().split('\n');
		assert.equal(turns.length, 2, 'each turn its own commit');
		assert.deepEqual(turns.map(turn => f.store.savedSendsOfTurn('main', turn)[0].text.split('\n')[0]), ['next', 'draw a']);
	} finally { f.store.close(); }
});

test('while a turn runs its files come into the project folder on a timer, each collection its own commit with the turn\'s trailer', async () => {
	const f = fixture({ collectEveryMs: 20 });
	try {
		f.pine.plans = [{ state: 'running', files: made('assets/props/a', 'a, being drawn') }];
		const reply = f.service.submit('main', 'draw a', 'Project Chat', [], f.root);
		const pumping = drain(reply);
		await until(() => existsSync(join(f.root, 'assets/props/a/picture.png')), 'the file comes in while the turn runs');
		assert.equal(f.store.chat('main')?.state, 'running');
		const turnId = f.store.chat('main')!.current_turn_id!;
		const commits = async () => (await git(['log', '--format=%(trailers:key=Pine-Turn-Id,valueonly,separator=)', '--author=pine-computer'], f.root)).stdout.trim();
		await until(async () => await commits() === turnId, 'the collection is a commit while the turn runs');
		f.pine.finish(turnId, { state: 'completed', text: 'drawn', files: made('assets/props/a', 'a, drawn') });
		await pumping;
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a, drawn');
		assert.equal(await commits(), `${turnId}\n${turnId}`, 'and the end\'s collection one more');
	} finally { f.store.close(); }
});

test('a turn that ended is settled and its changes land even though its event stream never recovers', async () => {
	const f = fixture({ reconnectWaitsMs: [0, 20] });
	try {
		f.pine.plans = [{ state: 'running' }];
		const said: Update[] = [];
		const reply = f.service.submit('main', 'draw the umbrella', 'Project Chat', [], f.root);
		const end = Date.now() + 20_000;
		while (f.store.chat('main')?.state !== 'running') {
			assert.ok(Date.now() < end, 'the turn runs');
			const next = await reply.next();
			assert.ok(!next.done);
			said.push(next.value);
		}
		const turnId = f.store.chat('main')!.current_turn_id!;
		// The network drops while the turn ends on the Computer; then turn reads answer again, but every stream reconnect runs out.
		f.pine.streamDown = true;
		f.pine.offline = true;
		while (!/Connection to Pine lost/.test(f.said(said))) {
			assert.ok(Date.now() < end, `the loss is said; said: ${f.said(said)}`);
			const next = await reply.next();
			assert.ok(!next.done, f.said(said));
			said.push(next.value);
		}
		f.pine.finish(turnId, { state: 'completed', text: 'drawn', files: made('assets/props/umbrella', 'umbrella') });
		f.pine.offline = false;
		const rest = (async () => { for await (const update of reply) { said.push(update); } })();
		let timer: NodeJS.Timeout | undefined;
		let done: boolean;
		try {
			done = await Promise.race([rest.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 15_000); })]);
		} finally {
			clearTimeout(timer);
			f.pine.streamDown = false;
			await rest;
		}
		assert.equal(done, true, `the reply ends; said: ${f.said(said)}`);
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella', 'its changes land');
		assert.equal(f.service.hasUnfinishedTurnFollowUp('main'), false);
		assert.equal(f.pine.calls.run, 1, 'nothing is sent again');
	} finally { f.store.close(); }
});

test('files added in the chat input go into the drama\'s folder as the person\'s commit and up to the Computer: a picture to person-attachments/, a document to inputs/', async () => {
	const f = fixture();
	try {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pine-added-')));
		const picture = join(outside, 'office.JPG'); writeFileSync(picture, 'jpeg');
		const brief = join(outside, 'brief.md'); writeFileSync(brief, 'BRIEF');
		mkdirSync(join(outside, 'a folder'));
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		const said = await drain(f.service.submit('main', 'use these', 'Project Chat', [
			{ kind: 'file', path: picture }, { kind: 'file', path: brief }, { kind: 'file', path: join(outside, 'a folder') }], f.root));
		assert.match(f.said(said), /Not sent to the agent: a folder \(a folder\)/);
		assert.equal(readFileSync(join(f.root, 'inputs/brief.md'), 'utf8'), 'BRIEF');
		const imported = readdirSync(join(f.root, 'person-attachments'));
		assert.equal(imported.length, 1);
		assert.match(imported[0], /^[0-9a-f-]{36}\.jpg$/, 'a picture is person-attachments/<id>.<ext>');
		assert.deepEqual([readFileSync(join(f.drama(), 'inputs/brief.md'), 'utf8'), readFileSync(join(f.drama(), 'person-attachments', imported[0]), 'utf8')], ['BRIEF', 'jpeg']);
		assert.ok(f.store.messages('main').some(m => m.kind === 'instructions' && m.text === `Pine Drama Studio: the person added to the drama's folder: person-attachments/${imported[0]}, inputs/brief.md.`));
		const log = await git(['log', '--format=%an', '--name-only'], f.root);
		assert.deepEqual(log.stdout.trim().split('\n').filter(Boolean).sort(), ['inputs/brief.md', 'person', `person-attachments/${imported[0]}`].sort(), 'one person commit of what was placed');
	} finally { f.store.close(); }
});

test('at start, a turn not settled yet is settled with no message sent', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failTurnEnd = true;
		assert.match(f.said(await f.send('draw a')), /could not be brought into your project/);
		const runs = f.pine.calls.run;
		await f.service.resumeUnfinishedTurnFollowUps();
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a');
		assert.equal(f.pine.calls.run, runs, 'no run was sent');
		assert.equal(f.service.hasUnfinishedTurnFollowUp('main'), false);
	} finally { f.store.close(); }
});

// Codex's production review, item A5: startup attached only Chats owing an ended turn, so a Chat still running when the
// Studio stopped had no collector unless the workbench happened to reopen it, and its results were never brought in.
test('at start, a Chat whose turn still runs is followed and collected though nothing reopens it', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running' }];
		const reply = f.service.submit('main', 'draw a', 'Project Chat', [], f.root);
		while (f.store.chat('main')?.state !== 'running') { assert.ok(!(await reply.next()).done, 'the turn runs'); }
		const turnId = f.store.chat('main')!.current_turn_id!;
		// The Studio stops here: nothing reads `reply` again. Started again, nothing in the workbench opens the Chat.
		const resumed = f.restarted().resumeUnfinishedTurnFollowUps();
		f.pine.finish(turnId, { state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') });
		await resumed;
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a');
		assert.equal((await git(['log', '-1', '--format=%an'], f.root)).stdout.trim(), 'pine-computer');
	} finally { f.store.close(); }
});

// The Chat store migrates in place (store.ts MIGRATIONS): a Studio updated across a schema step finds the Chat whose turn
// still runs, follows that turn to its end and brings its results in. A fresh store in its place found no Chat at all.
test('a Chat whose turn still runs across a schema step is followed after the step, and its results land', async () => {
	const f = fixture();
	let reopened: Store | undefined;
	try {
		f.pine.plans = [{ state: 'running' }];
		const reply = f.service.submit('main', 'draw b', 'Project Chat', [], f.root);
		while (f.store.chat('main')?.state !== 'running') { assert.ok(!(await reply.next()).done, 'the turn runs'); }
		const turnId = f.store.chat('main')!.current_turn_id!;
		const runs = f.pine.calls.run;
		// The Studio stops here and its update adds a schema step.
		f.store.close();
		const probe = MIGRATIONS.at(-1)!.version + 1;
		reopened = new Store(f.path, Date.now, [...MIGRATIONS, { version: probe, sql: 'alter table chats add column probe text' }]);
		assert.equal(reopened.setAside, undefined, 'nothing is set aside');
		assert.equal((reopened.db.prepare('pragma user_version').get() as { user_version: number }).user_version, probe);
		assert.equal(reopened.chat('main')?.state, 'running');
		assert.equal(reopened.chat('main')?.current_turn_id, turnId);
		const resumed = f.restarted({}, reopened).resumeUnfinishedTurnFollowUps();
		f.pine.finish(turnId, { state: 'completed', text: 'drawn after the update', files: made('assets/props/b', 'b') });
		await resumed;
		assert.equal(readFileSync(join(f.root, 'assets/props/b/picture.png'), 'utf8'), 'b', 'the turn\'s file is in the project');
		assert.ok(reopened.messages('main').some(m => m.turn_id === turnId && m.kind === 'result' && m.text.includes('drawn after the update')),
			JSON.stringify(reopened.messages('main').map(m => [m.kind, m.text])));
		assert.equal(f.pine.calls.run, runs, 'no run was sent again');
	} finally {
		if (reopened) { reopened.close(); } else if (f.store.db.isOpen) { f.store.close(); }
	}
});

/** A window that sends `text` and dies while its turn runs, having read only the turn's first event; the turn's id. */
async function diesWhileRunning(f: ReturnType<typeof fixture>, text: string): Promise<string> {
	const reply = f.restarted({ events: async function* (env, session, after, _task, signal) {
		for await (const event of f.pine.events(env, session, after)) { yield event; break; }
		await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
	} }).submit('main', text, 'Project Chat', [], f.root);
	while (f.store.chat('main')?.state !== 'running') { assert.ok(!(await reply.next()).done, 'the turn runs'); }
	await reply.return(undefined);
	return f.store.chat('main')!.current_turn_id!;
}

// Codex on #239, P2: a Chat's turn has one follower in a window. The workbench opening the Chat reads the follower the
// start began, from its first update, so what that follower read before is not lost to the Chat.
test('a Chat opened while the start follows its turn shows that turn\'s activity and cost from the turn\'s start', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running', steps: [{ id: 'a1', title: 'Drawing a', state: 'running' }] }];
		const turnId = await diesWhileRunning(f, 'draw a');
		const window = f.restarted();
		const resumed = window.resumeUnfinishedTurnFollowUps();
		const events = [...f.pine.computers.values()].flatMap(c => [...c.sessions.values()]).flatMap(s => s.events);
		await until(() => f.store.chat('main')!.last_applied_event_id === events.at(-1)!.eventId, 'the start\'s follower read every event of the turn');
		const opened = drain(window.attachChatToPineTurn('main'));
		f.pine.finish(turnId, { state: 'completed', text: 'drawn a' });
		await resumed;
		const seen = await opened;
		assert.ok(seen.some(u => u.kind === 'activity' && u.text === 'Drawing a'), f.said(seen));
		assert.ok(seen.some(u => u.kind === 'usage'), f.said(seen));
	} finally { f.store.close(); }
});

// Codex on #239, P1: the follower ends its turn in the Chat's line, as a send does, so a message sent meanwhile goes
// after that ending, and the ending never lands on the newer turn.
test('a turn the start\'s follower ends late is settled before the next message goes, and its ending never replaces the newer turn', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running' }];
		const first = await diesWhileRunning(f, 'draw a');
		// Started again, the first read of the turn is slow.
		let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
		let release!: () => void; const slow = new Promise<void>(resolve => { release = resolve; });
		let held = false;
		const window = f.restarted({ turn: async (env, session, turnId) => {
			if (!held) { held = true; entered(); await slow; }
			return f.pine.turn(env, session, turnId);
		} });
		const resumed = window.resumeUnfinishedTurnFollowUps();
		await reading;
		const opened = drain(window.attachChatToPineTurn('main'));
		f.pine.finish(first, { state: 'completed', text: 'drawn a' });
		f.pine.plans = [{ state: 'running' }];
		const next = drain(window.submit('main', 'draw b', 'Project Chat', [], f.root));
		// With two followers the next message went while the slow read waited: given up to 2 s to start its turn, it ends
		// that read only then. With one follower in the Chat's line, the message waits for it, and the read ends after 2 s.
		for (const end = Date.now() + 2000; (f.pine.calls.run ?? 0) < 2 && Date.now() < end;) { await new Promise(resolve => setTimeout(resolve, 5)); }
		release();
		await resumed;
		await opened;
		await until(() => f.store.chat('main')!.state === 'running' && f.store.chat('main')!.current_turn_id !== first, `the next message's turn runs, unreplaced: ${JSON.stringify(f.store.chat('main'))}`);
		f.pine.finish(f.store.chat('main')!.current_turn_id!, { state: 'completed', text: 'drawn b' });
		assert.match(f.said(await next), /drawn b/);
	} finally { f.store.close(); }
});

test('a session on another Computer starts from the whole project, what another session made in it included', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		await f.send('draw a');
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('break down EP001', 'pine-computer:/session-2');
		assert.equal(f.pine.computers.size, 2, 'the session runs on its own Computer');
		assert.equal(readFileSync(join(f.drama('pine-computer:/session-2'), 'assets/props/a/picture.png'), 'utf8'), 'a');
	} finally { f.store.close(); }
});

test('a turn whose Computer stopped before its files came in is said lost once, and does not hold up the next message', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failTurnEnd = true;
		assert.match(f.said(await f.send('draw a')), /could not be brought into your project/);
		f.pine.stop(f.store.chat('main')!.computer_id!);
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		const said = f.said(await f.send('next'));
		assert.match(said, /ok/, said);
		assert.equal(f.store.messages('main').filter(m => /^The Computer session of turn .* has ended, so what it wrote after its last collection could not be brought into your project[^]*Nothing is run again by itself/.test(m.text)).length, 1);
		assert.equal(existsSync(join(f.root, 'assets/props/a/picture.png')), false);
		assert.equal(f.service.hasUnfinishedTurnFollowUp('main'), false);
	} finally { f.store.close(); }
});

// The person's Stop, as pineSessions.ts runs it on the request's cancellation: the reply's signal aborts and the reply
// stops reading, while it is still waiting on its updates.
function stop(updates: AsyncGenerator<Update>, abort: AbortController): void {
	abort.abort();
	void updates.return(undefined);
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 10_000;
	while (!await done()) {
		assert.ok(Date.now() < end, what);
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

/** The state Pine holds for the Chat's last turn. */
const lastTurnState = (f: ReturnType<typeof fixture>) => f.pine.turnState(f.store.chat('main')!.current_turn_id!);

test('Stop while the Computer starts: nothing goes up, no turn starts, and nothing is left to resend', async () => {
	const f = fixture();
	try {
		const release = f.pine.hold('ensureComputer');
		const abort = new AbortController();
		const updates = f.service.submit('main', 'draw a', 'Project Chat', [], f.root, abort.signal);
		const reading = drain(updates);
		await until(() => f.pine.calls.ensureComputer === 1, 'the Computer starts');
		stop(updates, abort);
		release();
		await reading;
		assert.equal(f.pine.calls.run, undefined, 'no turn was started');
		assert.equal(f.pine.calls.exec, undefined, 'nothing went up');
		assert.deepEqual(f.store.unconfirmedSavedSends('main'), [], 'nothing waits to be resent');
		assert.equal(f.pine.calls.cancel, undefined, 'no turn to cancel');
	} finally { f.store.close(); }
});

test('Stop while a turn runs: Pine cancels it, what its agent changed lands with no message sent, the Chat says how Pine ended it, and the next message goes', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running', files: made('assets/props/a', 'half of a') }];
		const abort = new AbortController();
		const updates = f.service.submit('main', 'draw a', 'Project Chat', [], f.root, abort.signal);
		const reading = drain(updates);
		await until(() => f.store.chat('main')?.state === 'running', 'the turn runs');
		const turn = f.store.chat('main')!.current_turn_id!;
		stop(updates, abort);
		await reading;
		assert.equal(f.pine.turnState(turn), 'canceled', 'cancelled while the reply waited on the turn, which sends nothing');
		// The reply is closed, and nothing else is sent: the Stop's own pass follows the turn to its end and lands its files.
		await until(() => existsSync(join(f.root, 'assets/props/a/picture.png')) && !f.service.hasUnfinishedTurnFollowUp('main'), 'the stopped turn\'s files land');
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'half of a');
		assert.equal(f.pine.calls.run, 1, 'no message was sent for it');
		f.pine.plans = [{ state: 'completed', text: 'b is drawn' }];
		assert.match(f.said(await f.send('draw b')), /b is drawn/);
		assert.deepEqual(f.store.messages('main').filter(m => m.turn_id === turn && m.kind === 'result').map(m => m.text), ['You stopped this turn.'], 'how Pine ended the stopped turn, once');
		assert.notEqual(f.store.chat('main')?.state, 'failed', 'a Stop is no failure');
	} finally { f.store.close(); }
});

test('a Stop that reaches the run on its way: the turn Pine started for it is cancelled, the reply ends, and what it changed lands', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running', files: made('assets/props/a', 'a, cut short') }];
		const abort = new AbortController();
		const run = f.pine.run.bind(f.pine);
		f.pine.run = async (...args: Parameters<FakePine['run']>) => { abort.abort(); return run(...args); };
		await drain(f.service.submit('main', 'draw a', 'Project Chat', [], f.root, abort.signal));
		assert.equal(lastTurnState(f), 'canceled');
		await until(() => existsSync(join(f.root, 'assets/props/a/picture.png')) && !f.service.hasUnfinishedTurnFollowUp('main'), 'the stopped turn\'s files land');
		assert.equal(f.store.chat('main')?.state, 'idle', 'the Chat is idle, as after any Stop');
	} finally { f.store.close(); }
});

test('a Stop whose cancel Pine took but whose answer was lost still lands what the turn changed', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running', files: made('assets/props/a', 'a, cut short') }];
		const cancel = f.pine.cancel.bind(f.pine);
		f.pine.cancel = async (...args: Parameters<FakePine['cancel']>) => { await cancel(...args); throw new UnconfirmedError('cancel: response lost'); };
		const abort = new AbortController();
		const updates = f.service.submit('main', 'draw a', 'Project Chat', [], f.root, abort.signal);
		const reading = drain(updates);
		await until(() => f.store.chat('main')?.state === 'running', 'the turn runs');
		stop(updates, abort);
		await reading;
		await until(() => existsSync(join(f.root, 'assets/props/a/picture.png')) && !f.service.hasUnfinishedTurnFollowUp('main'), 'the stopped turn\'s files land');
		assert.equal(lastTurnState(f), 'canceled');
	} finally { f.store.close(); }
});

/**
 * The follower's read of a turn that has just asked, held until `release`: the window in which Pine has ended the turn
 * and the Studio has not yet recorded it, where the person's Stop landed in the monkey test (A10, turn _173: Pine's end
 * at 10:13:51.420, Stop at 10:13:52.354).
 */
function holdQuestionRead(f: ReturnType<typeof fixture>, state = 'needs_input'): { taken: () => boolean; release: () => void } {
	const read = f.pine.turn.bind(f.pine);
	let taken = false;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.pine.turn = async (...args: Parameters<FakePine['turn']>) => {
		const turn = await read(...args);
		if (!taken && turn.state === state) { taken = true; await gate; }
		return turn;
	};
	return { taken: () => taken, release };
}

/** A running turn, its Stop admitted and its cancel held while Pine has already ended the turn on a question. */
async function stopAfterTheQuestion(f: ReturnType<typeof fixture>) {
	f.pine.plans = [{ state: 'running' }];
	// Before the turn starts, so that the follower's read in flight when the agent asks is the one held.
	const read = holdQuestionRead(f);
	const abort = new AbortController();
	const reading = drain(f.service.submit('main', 'draw her', 'Project Chat', [], f.root, abort.signal));
	await until(() => f.store.chat('main')?.state === 'running', 'the turn runs');
	const turn = f.store.chat('main')!.current_turn_id!;
	const cancel = f.pine.hold('cancel');
	f.pine.finish(turn, { state: 'needs_input', text: 'May I recreate her under a new id?' });
	await until(read.taken, 'the follower read the question');
	// The person's Stop while the Chat still records the turn running. The reply reads on, so its own follower
	// records what it read, as in A10.
	abort.abort();
	await until(() => f.pine.calls.cancel === 1, 'the Stop sent its cancel');
	return { turn, reading, read, cancel };
}

test('a Stop just after the agent asked: Pine closed the question, and the Chat records the stopped turn, not a waiting one (A10)', async () => {
	const f = fixture();
	try {
		const { turn, reading, read, cancel } = await stopAfterTheQuestion(f);
		cancel();
		await until(() => f.pine.turnState(turn) === 'canceled', 'Pine closed the question');
		read.release();
		await reading;
		await until(() => f.store.chat('main')?.state === 'idle' && !f.service.hasUnfinishedTurnFollowUp('main'), 'the Chat records the turn Pine ended');
		assert.equal(f.store.chat('main')?.question_turn_id, null, 'nothing waits for the person');
		assert.equal(f.pine.calls.cancel, 1);
		assert.equal(f.store.chat('main')?.ending_event_id, f.pine.lastEventIdOf(turn), 'the ending Pine ordered last');
		const said = f.store.messages('main').filter(m => m.turn_id === turn && ['question', 'result'].includes(m.kind)).map(m => [m.kind, m.text]);
		assert.deepEqual(said.map(([kind]) => kind), ['question', 'result'], JSON.stringify(said));
		assert.match(said[1][1], /^You stopped this turn\./);
	} finally { f.store.close(); }
});

test('a Stop just after the agent asked leaves the working idle timeout, whatever the follower set while the turn waited', async () => {
	const f = fixture();
	try {
		const { turn, reading, read, cancel } = await stopAfterTheQuestion(f);
		const before = f.pine.calls.setIdleTimeout ?? 0;
		const idle = f.pine.hold('setIdleTimeout');
		read.release();
		await until(() => f.pine.calls.setIdleTimeout === before + 1, 'the follower asks for the waiting idle timeout');
		cancel();
		await until(() => f.pine.turnState(turn) === 'canceled', 'Pine closed the question');
		idle();
		await reading;
		await until(() => f.store.chat('main')?.state === 'idle' && f.pine.idleRequests.at(-1) === IDLE_WORKING_SECONDS, 'the stopped turn and the working idle timeout');
	} finally { f.store.close(); }
});

test('a Stop that came after Pine completed the turn: the same ending, read twice, is recorded once and said by each reader', async () => {
	const logs: string[] = [];
	const f = fixture({ log: line => logs.push(line) });
	try {
		f.pine.plans = [{ state: 'running' }];
		const read = holdQuestionRead(f, 'completed');
		const abort = new AbortController();
		const reading = drain(f.service.submit('main', 'draw her', 'Project Chat', [], f.root, abort.signal));
		await until(() => f.store.chat('main')?.state === 'running', 'the turn runs');
		const turn = f.store.chat('main')!.current_turn_id!;
		f.pine.finish(turn, { state: 'completed', text: 'She is drawn.' });
		await until(read.taken, 'the follower read the end');
		// The Stop's cancel finds the turn ended and answers with the same ending the follower read.
		abort.abort();
		await until(() => f.pine.calls.cancel === 1, 'the Stop sent its cancel');
		read.release();
		const said = f.said(await reading);
		await until(() => f.store.chat('main')?.ending_event_id === f.pine.lastEventIdOf(turn) && !f.service.hasUnfinishedTurnFollowUp('main'), 'the ending recorded');
		assert.match(said, /She is drawn\./, 'the reply says the ending');
		// The Stop's pass meets the ending the reply recorded (the same place in Pine's order): not written again, still said.
		await until(() => logs.some(line => line.includes('after Stop:') && line.includes('She is drawn.')), 'the Stop\'s pass says the ending it read');
		assert.equal(f.pine.turnState(turn), 'completed', 'the cancel came too late to change it');
		assert.equal(f.store.chat('main')?.state, 'idle');
		const finals = f.store.messages('main').filter(m => m.turn_id === turn && ['result', 'usage'].includes(m.kind)).map(m => m.kind);
		assert.deepEqual(finals.sort(), ['result', 'usage'], 'one result and one cost, though two read the ending');
	} finally { f.store.close(); }
});

test('a Stop once the Chat recorded the question asks Pine nothing: the turn ended before it', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'needs_input', text: 'Which episode?' }];
		await f.send('draw her');
		assert.equal(f.store.chat('main')?.state, 'needs_input');
		const abort = new AbortController();
		abort.abort();
		await drain(f.service.attachChatToPineTurn('main', abort.signal));
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(f.pine.calls.cancel, undefined, 'no cancel');
		assert.equal(f.store.chat('main')?.state, 'needs_input', 'the question still waits, as on Pine');
	} finally { f.store.close(); }
});

