// A Chat's turns end to end over the fake Pine, protocol major 2 (doc/protocol.md section 4): the request and its message
// go up, the turn's changes land in the project as they are stored, its return resolves it, and a session's next turn
// goes only after its last is resolved, from that return's private state.
import { git } from '../core/git';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import type { Request } from '../core/protocol';
import { sha256 } from '../core/sha256';
import { Store } from '../core/store';
import { changeKey, fileKey, paidCallsPrefix } from '../core/taskArtifacts';
import { FakePine, MemoryVault } from './fakePine';
import { testProtocol } from './protocolFixture';

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const all: Update[] = []; for await (const update of updates) { all.push(update); } return all;
}

/** A turn that draws `object`'s picture: one file under drama/, one change (fakePine.ts returnTask). */
const made = (object: string, picture: string) => ({ [`drama/${object}/picture.png`]: picture });

function fixture(more: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-protocol-flow-')));
	const root = join(dir, 'drama'); mkdirSync(root);
	const store = new Store(join(dir, 'studio.sqlite'));
	const pine = new FakePine();
	// `failArtifacts`: the next read of a Computer's artifacts after this many more fails, as storage that is down.
	const control = { failArtifacts: -1 };
	const port = new Proxy(pine, { get: (target, name) => {
		if (name === 'artifacts') {
			return (...args: Parameters<FakePine['artifacts']>) => control.failArtifacts-- === 0 ? Promise.reject(new Error('storage unavailable')) : target.artifacts(...args);
		}
		const value = Reflect.get(target, name, target) as unknown;
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
	} });
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port, vault: new MemoryVault(), pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
		files: { projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir), ...more });
	const send = (text: string, key = 'main') => drain(service.submit(key, text, key === 'main' ? 'Project Chat' : 'Session', root));
	const request = (n: number) => {
		// Every Computer's requests, in the order they were written there, the first Computer's first.
		const requests = [...pine.artifactFiles.values()].flatMap(files => [...files].filter(([k]) => k.endsWith('/request.json')).map(([, bytes]) => bytes));
		return JSON.parse(requests[n].toString('utf8')) as Request;
	};
	const said = (updates: Update[]) => updates.map(u => u.text).join('\n');
	return { root, store, pine, service, send, request, said, control };
}

test('a turn goes up with its message, its changes land as pine-computer commits, and the next seed carries them', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/umbrella', 'umbrella') }];
		await f.send('draw the umbrella');
		const first = f.request(0);
		assert.deepEqual([first.schema, first.seed_files, first.session_private_state, first.notes_for_pine_computer], [2, {}, null, []]);
		assert.match(f.store.savedSend(first.turn_id)!.text, new RegExp(`^pine-drama-turn ${first.turn_id}\\ndraw the umbrella`));
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella');
		assert.match((await git(['log', '-1', '--format=%an|%(trailers:key=Pine-Turn-Id,valueonly)'], f.root)).stdout.trim(), new RegExp(`^pine-computer\\|${first.turn_id}$`));
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		const second = f.request(1);
		assert.deepEqual(second.seed_files, { 'assets/props/umbrella/picture.png': sha256('umbrella') }, 'the next seed is the folder as recorded');
		assert.equal(second.session_private_state, sha256(`private state of ${first.turn_id}`), 'from the session\'s latest resolved return');
	} finally { f.store.close(); }
});

test('a turn that ends with no return keeps what it stored and says it may have spent money; a refused one is said and changes nothing', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'cut off', files: made('assets/props/a', 'a'), noReturn: true }];
		assert.match(f.said(await f.send('draw a')), /ended before it returned: what it finished is in your project, and it may have spent money/);
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a');
		const head = (await git(['rev-parse', 'HEAD'], f.root)).stdout;
		f.pine.plans = [{ state: 'completed', text: 'no', refused: 'the project has no screenplay' }];
		assert.match(f.said(await f.send('draw b')), /refused this turn before running it: the project has no screenplay/);
		assert.equal((await git(['rev-parse', 'HEAD'], f.root)).stdout, head);
	} finally { f.store.close(); }
});

test('a session\'s next turn waits until its last one is resolved, and then starts from it', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failArtifacts = 1; // the send's own store succeeds; the turn end's read fails
		const end = f.said(await f.send('draw a'));
		assert.match(end, /could not be brought into your project[^]*tried again at your next message/);
		assert.equal(existsSync(join(f.root, 'assets/props/a/picture.png')), false);
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a', 'the earlier turn is resolved first');
		assert.deepEqual(Object.keys(f.request(1).seed_files), ['assets/props/a/picture.png']);
	} finally { f.store.close(); }
});

// B5: a large return installed for minutes after the agent's reply, and the Chat said nothing meanwhile.
test('while a turn\'s last results come in, the Chat says so, before the turn\'s last words', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/cup', 'cup') }];
		const updates = await f.send('draw the cup');
		const bringing = updates.findIndex(u => u.kind === 'progress' && /^Bringing the turn's last results into your project/.test(u.text));
		assert.ok(bringing >= 0, JSON.stringify(updates.map(u => [u.kind, u.text])));
		assert.ok(bringing < updates.findIndex(u => u.kind === 'markdown' && /drawn/.test(u.text)), 'it comes before the last words');
	} finally { f.store.close(); }
});

test('a running turn\'s changes land as they are stored, and what its paid calls make shows as being made until each call settles', async () => {
	const f = fixture({ changePollMs: 10 });
	try {
		f.pine.plans = [{ state: 'running' }];
		const reply = f.service.submit('main', 'draw the umbrella', 'Project Chat', f.root);
		const until = async (what: string, done: () => boolean) => {
			for (const end = Date.now() + 10_000; !done(); await new Promise(resolve => setTimeout(resolve, 10))) { assert.ok(Date.now() < end, what); }
		};
		const pumping = (async () => { for await (const update of reply) { void update; } })();
		await until('the turn runs', () => f.store.chat('main')?.state === 'running');
		const turn = f.request(0).turn_id;
		const store = [...f.pine.artifactFiles.values()][0];
		store.set(fileKey(sha256('umbrella')), Buffer.from('umbrella'));
		store.set(changeKey(turn, 1), Buffer.from(JSON.stringify({ schema: 2, turn_id: turn, change_number: 1, previous_change_sha256: null, files_after_change: { 'assets/props/umbrella/picture.png': sha256('umbrella') } })));
		store.set(`${paidCallsPrefix(turn)}call-1/pine_computer_sent_request_to_provider.json`, Buffer.from(JSON.stringify({ schema: 2, paid_call_id: 'call-1', object_id: 'assets/characters/lin',
			state: 'pine_computer_sent_request_to_provider', state_written_at: '2026-11-14T10:00:00Z' })));
		await until('the change lands while the turn runs', () => existsSync(join(f.root, 'assets/props/umbrella/picture.png')));
		await until('Lin shows as being made', () => f.service.makingNow(f.root).has('assets/characters/lin'));
		const call = (id: string, object: string, state: string) => store.set(`${paidCallsPrefix(turn)}${id}/${state}.json`,
			Buffer.from(JSON.stringify({ schema: 2, paid_call_id: id, object_id: object, state, state_written_at: '2026-11-14T10:01:00Z' })));
		call('call-1', 'assets/characters/lin', 'provider_returned_output_to_pine_computer');
		call('call-2', 'assets/scenes/street', 'pine_computer_sent_request_to_provider');
		call('call-2', 'assets/scenes/street', 'pine_computer_cannot_learn_call_outcome');
		f.pine.finish(f.store.chat('main')!.current_turn_id!, { state: 'completed', text: 'drawn' });
		await pumping;
		assert.deepEqual([...f.service.makingNow(f.root)], ['assets/scenes/street'], 'a call whose outcome is not learned is still making after its turn (4.5)');
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella');
	} finally { f.store.close(); }
});

test('a turn that ended is resolved and its changes land even though its event stream never recovers', async () => {
	const f = fixture({ reconnectWaitsMs: [0, 20] });
	try {
		f.pine.plans = [{ state: 'running' }];
		const said: Update[] = [];
		const reply = f.service.submit('main', 'draw the umbrella', 'Project Chat', f.root);
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

test('files added in the chat input go into the drama\'s folder as the person\'s commit and travel in the seed: a picture to person-attachments/, a document to inputs/', async () => {
	const f = fixture();
	try {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pine-added-')));
		const picture = join(outside, 'office.JPG'); writeFileSync(picture, 'jpeg');
		const brief = join(outside, 'brief.md'); writeFileSync(brief, 'BRIEF');
		mkdirSync(join(outside, 'a folder'));
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		const said = await drain(f.service.submitWithFiles('main', 'use these', 'Project Chat', [
			{ kind: 'file', path: picture }, { kind: 'file', path: brief }, { kind: 'file', path: join(outside, 'a folder') }], f.root));
		assert.match(f.said(said), /Not sent to the agent: a folder \(a folder\)/);
		assert.equal(readFileSync(join(f.root, 'inputs/brief.md'), 'utf8'), 'BRIEF');
		const imported = readdirSync(join(f.root, 'person-attachments'));
		assert.equal(imported.length, 1);
		assert.match(imported[0], /^[0-9a-f-]{36}\.jpg$/, 'a picture is person-attachments/<id>.<ext>');
		assert.deepEqual(Object.keys(f.request(0).seed_files).sort(), ['inputs/brief.md', `person-attachments/${imported[0]}`]);
		assert.ok(f.store.messages('main').some(m => m.kind === 'instructions' && m.text === `Pine Drama Studio: the person added to the drama's folder: person-attachments/${imported[0]}, inputs/brief.md.`));
		const log = await git(['log', '--format=%an', '--name-only'], f.root);
		assert.deepEqual(log.stdout.trim().split('\n').filter(Boolean).sort(), ['inputs/brief.md', 'person', `person-attachments/${imported[0]}`].sort(), 'one person commit of what was placed');
	} finally { f.store.close(); }
});

test('at start, a turn not resolved yet is resolved with no message sent', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failArtifacts = 1; // the send's own listing succeeds; the turn end's read fails
		assert.match(f.said(await f.send('draw a')), /could not be brought into your project/);
		const runs = f.pine.calls.run;
		await f.service.resumeUnfinishedTurnFollowUps();
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a');
		assert.equal(f.pine.calls.run, runs, 'no run was sent');
		assert.equal(f.service.hasUnfinishedTurnFollowUp('main'), false);
	} finally { f.store.close(); }
});

test('a turn that broke off keeps what it finished and says why', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'stopped early', files: made('assets/props/a', 'a'), failed: 'the image model refused a picture' }];
		assert.match(f.said(await f.send('draw a and b')), /The turn broke off: the image model refused a picture[^]*What it finished is in your project/);
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a');
	} finally { f.store.close(); }
});

test('a turn that broke off before finishing anything says nothing new is in the project, and how to go on', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'not finished', failed: 'only episode 1 has a draft' }];
		const said = f.said(await f.send('convert the screenplay'));
		assert.match(said, /The turn broke off: only episode 1 has a draft[^]*Nothing new was added to your project\. To go on, ask it to continue in a new message\./);
		assert.doesNotMatch(said, /What it finished is in your project/);
	} finally { f.store.close(); }
});

test('a session on another Computer gets the project\'s files by Pine\'s copy from the Computer that stored them, not by upload', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		await f.send('draw a');
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('break down EP001', 'pine-computer:/session-2');
		const computers = [...f.pine.artifactFiles.keys()];
		assert.equal(computers.length, 2, 'the session runs on its own Computer');
		const hash = f.request(1).seed_files['assets/props/a/picture.png'];
		assert.ok(f.pine.artifactFiles.get(computers[1])!.get(fileKey(hash)), 'the file is on the second Computer');
		assert.equal(f.pine.calls.copy, 1, 'copied inside Pine\'s storage');
	} finally { f.store.close(); }
});

// The person's Stop, as pineSessions.ts runs it on the request's cancellation: the reply's signal aborts and the reply
// stops reading, while it is still waiting on its updates.
function stop(updates: AsyncGenerator<Update>, abort: AbortController): void {
	abort.abort();
	void updates.return(undefined);
}

async function until(done: () => boolean, what: string): Promise<void> {
	const end = Date.now() + 10_000;
	while (!done()) {
		assert.ok(Date.now() < end, what);
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

const requestsUp = (f: ReturnType<typeof fixture>) => [...f.pine.artifactFiles.values()].flatMap(files => [...files.keys()]).filter(k => k.endsWith('/request.json'));
/** The state Pine holds for the Chat's last turn. */
const lastTurnState = (f: ReturnType<typeof fixture>) => f.pine.turnState(f.store.chat('main')!.current_turn_id!);

test('Stop while the Computer starts: nothing goes up, no turn starts, and nothing is left to resend', async () => {
	const f = fixture();
	try {
		const release = f.pine.hold('ensureComputer');
		const abort = new AbortController();
		const updates = f.service.submit('main', 'draw a', 'Project Chat', f.root, abort.signal);
		const reading = drain(updates);
		await until(() => f.pine.calls.ensureComputer === 1, 'the Computer starts');
		stop(updates, abort);
		release();
		await reading;
		assert.equal(f.pine.calls.run, undefined, 'no turn was started');
		assert.deepEqual(requestsUp(f), [], 'no request went up');
		assert.deepEqual(f.store.unconfirmedSavedSends('main'), [], 'nothing waits to be resent');
		assert.equal(f.pine.calls.cancel, undefined, 'no turn to cancel');
	} finally { f.store.close(); }
});

test('Stop while a turn runs: Pine cancels it, what it stored lands, and the next message says it may have spent money, then goes', async () => {
	const f = fixture();
	try {
		// A run cut off before its return writes none (doc/protocol.md 4.7).
		f.pine.plans = [{ state: 'running', noReturn: true }];
		const abort = new AbortController();
		const updates = f.service.submit('main', 'draw a', 'Project Chat', f.root, abort.signal);
		const reading = drain(updates);
		await until(() => f.store.chat('main')?.state === 'running', 'the turn runs');
		const turn = f.store.chat('main')!.current_turn_id!;
		stop(updates, abort);
		await reading;
		assert.equal(f.pine.turnState(turn), 'canceled', 'cancelled while the reply waited on the turn, which sends nothing');
		f.pine.plans = [{ state: 'completed', text: 'b is drawn' }];
		assert.match(f.said(await f.send('draw b')), /ended before it returned[^]*may have spent money[^]*b is drawn/);
	} finally { f.store.close(); }
});

test('a Stop that reaches the run on its way: the turn Pine started for it is cancelled, and the reply ends', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running', noReturn: true }];
		const abort = new AbortController();
		const run = f.pine.run.bind(f.pine);
		f.pine.run = async (...args: Parameters<FakePine['run']>) => { abort.abort(); return run(...args); };
		await drain(f.service.submit('main', 'draw a', 'Project Chat', f.root, abort.signal));
		assert.equal(lastTurnState(f), 'canceled');
	} finally { f.store.close(); }
});

test('a Stop after the turn ended cancels nothing', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn' }];
		const abort = new AbortController();
		await drain(f.service.submit('main', 'draw a', 'Project Chat', f.root, abort.signal));
		abort.abort();
		assert.equal(f.pine.calls.cancel, undefined);
		assert.equal(lastTurnState(f), 'completed');
	} finally { f.store.close(); }
});

test('a return wins over how Pine ended its turn: a stop\'s question is asked, and the next message goes as a new run', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'failed', text: 'lost the stream', files: made('assets/props/a', 'a'), question: 'Draw the second episode too?' }];
		assert.match(f.said(await f.send('draw a')), /\*\*The agent asks:\*\* Draw the second episode too\?/);
		assert.deepEqual([f.store.chat('main')?.state, f.store.chat('main')?.question_turn_id], ['idle', null], 'Pine holds no question open: the next message is a run');
		f.pine.plans = [{ state: 'completed', text: 'both drawn' }];
		await f.send('yes');
		assert.equal(f.store.savedSend(f.request(1).turn_id)?.target_turn_id, null, 'the answer names no question Pine does not hold');
	} finally { f.store.close(); }
});

test('a return that finished the work leaves the Chat idle though Pine said its turn failed', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'failed', text: 'stream ended early', files: made('assets/props/a', 'a') }];
		await f.send('draw a');
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a');
		assert.equal(f.store.chat('main')?.state, 'idle', 'the return said finished');
	} finally { f.store.close(); }
});

test('a return\'s question that Pine\'s own words already say is said once', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'Approve episode two?', question: 'Approve episode two?' }];
		const said = f.said(await f.send('go on'));
		assert.equal(said.split('Approve episode two?').length - 1, 1, said);
	} finally { f.store.close(); }
});
