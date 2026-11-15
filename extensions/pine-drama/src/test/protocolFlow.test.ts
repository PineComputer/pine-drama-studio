// A Chat's turns end to end over the fake Pine, protocol major 2 (doc/protocol.md section 4): the request and its message
// go up, the turn's changes land in the project as they are stored, the Pine turn's end settles it, and a session's
// next turn goes only after its last is settled.
import { git } from '../core/git';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { sha256 } from '../core/sha256';
import { Store } from '../core/store';
import { changeKey, fileKey } from '../core/taskArtifacts';
import { readProjectFromFolder } from '../core/project';
import { PAID_CALLS_FOLDER, REQUEST_ATTACHMENT, STUDIO_RELEASES_URL, TURN_RECORDS_FOLDER, type Request } from '../core/protocol';
import { FakePine, MemoryVault } from './fakePine';
import { testProtocol } from './protocolFixture';

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const all: Update[] = []; for await (const update of updates) { all.push(update); } return all;
}

/** A turn that draws `object`'s picture: one file under drama/, one change (fakePine.ts storeTurnChanges). */
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
		// Every request put into a session (doc/protocol.md 4.1), in the order the Studio wrote them.
		const requests = pine.written.filter(w => w.name === REQUEST_ATTACHMENT).map(w => w.content);
		return JSON.parse(Buffer.from(requests[n]).toString('utf8')) as Request;
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
		assert.deepEqual([first.schema, first.seed_files, first.notes_for_pine_computer], [2, {}, []]);
		assert.match(f.store.savedSend(first.turn_id)!.text, new RegExp(`^pine-drama-turn ${first.turn_id}\\ndraw the umbrella`));
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella');
		assert.match((await git(['log', '-1', '--format=%an|%(trailers:key=Pine-Turn-Id,valueonly)'], f.root)).stdout.trim(), new RegExp(`^pine-computer\\|${first.turn_id}$`));
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		const second = f.request(1);
		assert.deepEqual(second.seed_files, { 'assets/props/umbrella/picture.png': sha256('umbrella') }, 'the next seed is the folder as recorded');
	} finally { f.store.close(); }
});

test('a turn Pine ended failed keeps what it stored, and the Chat says the work broke off', async () => {
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
		f.control.failArtifacts = 1; // the send's own store succeeds; the turn end's read fails
		const end = f.said(await f.send('draw a'));
		assert.match(end, /could not be brought into your project[^]*tried again at your next message/);
		assert.equal(existsSync(join(f.root, 'assets/props/a/picture.png')), false);
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		assert.equal(readFileSync(join(f.root, 'assets/props/a/picture.png'), 'utf8'), 'a', 'the earlier turn is settled first');
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

test('a running turn\'s changes land as they are stored, Pine Computer\'s records with them, and what its paid calls make shows as being made until each call settles', async () => {
	const f = fixture({ changePollMs: 10 });
	try {
		f.pine.plans = [{ state: 'running' }];
		const reply = f.service.submit('main', 'draw the umbrella', 'Project Chat', f.root);
		const until = async (what: string, done: () => boolean) => {
			for (const end = Date.now() + 10_000; !done(); await new Promise(resolve => setTimeout(resolve, 10))) { assert.ok(Date.now() < end, what); }
		};
		const said: Update[] = [];
		const pumping = (async () => { for await (const update of reply) { said.push(update); } })();
		await until('the turn runs', () => f.store.chat('main')?.state === 'running');
		const turn = f.request(0).turn_id;
		const store = [...f.pine.artifactFiles.values()][0];
		// The Computer side's changes, each after the one before it: its files and Pine Computer's records alike (doc/protocol.md 2.4, 4.3).
		let previous: Buffer | undefined;
		let number = 0;
		const change = (files: Record<string, string>) => {
			for (const text of Object.values(files)) { store.set(fileKey(sha256(text)), Buffer.from(text)); }
			const bytes = Buffer.from(JSON.stringify({ schema: 2, turn_id: turn, change_number: ++number, previous_change_sha256: previous ? sha256(previous) : null,
				files_after_change: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(text)])) }));
			store.set(changeKey(turn, number), bytes);
			previous = bytes;
		};
		const object = (type: string, name: string) => JSON.stringify({ schema: 2, type, name, shown_file: null });
		const call = (id: string, object: string, state: string) => ({ [`${PAID_CALLS_FOLDER}/${id}/${state}.json`]:
			JSON.stringify({ schema: 2, paid_call_id: id, object_id: object, state, state_written_at: '2026-11-14T10:00:00Z' }) });
		const making = async () => [...(await readProjectFromFolder(f.root)).objects.values()].filter(o => o.makingNow).map(o => o.id);
		change({ 'assets/props/umbrella/picture.png': 'umbrella', 'assets/characters/lin/object.json': object('character', 'Lin'), 'assets/scenes/street/object.json': object('scene', 'Street'),
			...call('call-1', 'assets/characters/lin', 'pine_computer_sent_request_to_provider') });
		await until('the change lands while the turn runs', () => existsSync(join(f.root, 'assets/props/umbrella/picture.png')));
		for (const end = Date.now() + 10_000; (await making()).join() !== 'assets/characters/lin'; await new Promise(resolve => setTimeout(resolve, 10))) {
			assert.ok(Date.now() < end, `Lin shows as being made: ${(await making()).join()}`);
		}
		change({ ...call('call-1', 'assets/characters/lin', 'provider_returned_output_to_pine_computer'),
			...call('call-2', 'assets/scenes/street', 'pine_computer_sent_request_to_provider'), ...call('call-2', 'assets/scenes/street', 'pine_computer_cannot_learn_call_outcome'),
			[`${TURN_RECORDS_FOLDER}/${turn}.json`]: JSON.stringify({ schema: 2, turn_id: turn, pine_computer_could_not_do: [{ object_or_file: 'assets/props/kettle', error: { code: 'pine_computer_broke_off_the_work', message: 'the image model refused the prompt' } }] }) });
		f.pine.finish(f.store.chat('main')!.current_turn_id!, { state: 'completed', text: 'drawn' });
		await pumping;
		assert.deepEqual(await making(), ['assets/scenes/street'], 'a call whose outcome is not learned is still making after its turn (4.5)');
		assert.match(f.said(said), /assets\/props\/kettle: the image model refused the prompt/, 'what Pine Computer could not do, from its record of the turn (2.4)');
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/picture.png'), 'utf8'), 'umbrella');
	} finally { f.store.close(); }
});

test('a turn whose changes hold one of a newer major is said once with the download, and never read again', async () => {
	const f = fixture({ changePollMs: 10 });
	try {
		f.pine.plans = [{ state: 'running' }];
		const reply = f.service.submit('main', 'draw lin', 'Project Chat', f.root);
		const until = async (what: string, done: () => boolean) => {
			for (const end = Date.now() + 10_000; !done(); await new Promise(resolve => setTimeout(resolve, 10))) { assert.ok(Date.now() < end, what); }
		};
		const updates: Update[] = [];
		const pumping = (async () => { for await (const update of reply) { updates.push(update); } })();
		await until('the turn runs', () => f.store.chat('main')?.state === 'running');
		const turn = f.request(0).turn_id;
		[...f.pine.artifactFiles.values()][0].set(changeKey(turn, 1), Buffer.from(JSON.stringify({ schema: 3, turn_id: turn, change_number: 1, previous_change_sha256: null, files_after_change: {} })));
		f.pine.finish(f.store.chat('main')!.current_turn_id!, { state: 'completed', text: 'drawn' });
		await pumping;
		assert.match(f.said(updates), /newer Pine Computer side/);
		assert.ok(f.said(updates).includes(`[Download Pine Drama Studio](${STUDIO_RELEASES_URL})`), f.said(updates));
		assert.doesNotMatch(f.said(updates), /tried again/, 'settled: never read again');
	} finally { f.store.close(); }
});

test('a turn that ended is settled and its changes land even though its event stream never recovers', async () => {
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

test('at start, a turn not settled yet is settled with no message sent', async () => {
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

const requestsUp = (f: ReturnType<typeof fixture>) => f.pine.written.filter(w => w.name === REQUEST_ATTACHMENT);
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

test('Stop while a turn runs: Pine cancels it, the Chat says how Pine ended it, and the next message goes', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running' }];
		const abort = new AbortController();
		const updates = f.service.submit('main', 'draw a', 'Project Chat', f.root, abort.signal);
		const reading = drain(updates);
		await until(() => f.store.chat('main')?.state === 'running', 'the turn runs');
		const turn = f.store.chat('main')!.current_turn_id!;
		stop(updates, abort);
		await reading;
		assert.equal(f.pine.turnState(turn), 'canceled', 'cancelled while the reply waited on the turn, which sends nothing');
		f.pine.plans = [{ state: 'completed', text: 'b is drawn' }];
		assert.match(f.said(await f.send('draw b')), /b is drawn/);
		assert.deepEqual(f.store.messages('main').filter(m => m.turn_id === turn && m.kind === 'result').map(m => m.text), ['You stopped this turn.'], 'how Pine ended the stopped turn, once (doc/protocol.md 4.6)');
		assert.notEqual(f.store.chat('main')?.state, 'failed', 'a Stop is no failure');
	} finally { f.store.close(); }
});

test('a Stop that reaches the run on its way: the turn Pine started for it is cancelled, and the reply ends', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'running' }];
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
