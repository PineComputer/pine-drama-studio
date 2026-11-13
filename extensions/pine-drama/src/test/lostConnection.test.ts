// F4 (worker-06's run): the Mac lost its network for 35 minutes under a running turn. The follow ended at the
// first ConnectionError, the turn stayed "running" with nobody following it, Stop All's SandboxGoneError on the event
// stream was shown as a Pine error, and the next message was queued behind a turn whose Computer was gone. A follower now
// re-attaches to the same turn with VS Code's reconnection schedule, a gone Computer ends the session as a reload does,
// and nothing is queued behind it. Fake Pine and short waits: no network, no money (AGENTS.md, tests).

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { ConnectionLostError, MissingError, type PineConnection } from '../core/pinePort';
import { Store } from '../core/store';
import { SdkPort } from '../sdkPort';
import { FakePine, MemoryVault } from './fakePine';

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/lost-connection';
const FOLDER = '/Users/x/Pine Drama Studio/Bone Veil';

function setup(options: { reconnectLimitMs?: number } = {}) {
	const path = join(mkdtempSync(join(tmpdir(), 'pine-lost-')), 'studio.sqlite');
	const pine = new FakePine();
	const vault = new MemoryVault();
	const logs: string[] = [];
	const window = () => {
		const store = new Store(path);
		const service = new ChatService({
			holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault, pine: ENV, log: line => logs.push(line),
			reconnectWaitsMs: [0, 20], ...options,
		});
		return { store, service };
	};
	return { pine, window, logs };
}

const text = (updates: readonly Update[]) => updates.filter(u => u.kind !== 'progress').map(u => u.text).join('\n');

/** Runs `updates` until `until` holds of what it said, then hands back the generator and what it said so far. */
async function runUntil(updates: AsyncGenerator<Update>, until: (said: readonly Update[]) => boolean): Promise<Update[]> {
	const said: Update[] = [];
	const end = Date.now() + 10_000;
	while (!until(said)) {
		assert.ok(Date.now() < end, `not reached; said so far: ${text(said)}`);
		const next = await updates.next();
		assert.ok(!next.done, `ended first; said: ${text(said)}`);
		said.push(next.value);
	}
	return said;
}

async function drain(updates: AsyncGenerator<Update>, said: Update[] = []): Promise<Update[]> {
	for await (const update of updates) { said.push(update); }
	return said;
}

/** A turn that runs, followed by the reply of the message that started it. */
async function running(service: ChatService, store: Store): Promise<AsyncGenerator<Update>> {
	const reply = service.submit(KEY, 'make the drama', 'make the drama', FOLDER);
	const end = Date.now() + 10_000;
	while (store.chat(KEY)?.state !== 'running') {
		assert.ok(Date.now() < end, 'the turn runs');
		await reply.next();
	}
	return reply;
}

test('a lost connection under a running turn is said once and re-attaches to the same turn when it returns, with its results (F4)', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(service, store);
	const turnId = store.chat(KEY)!.current_turn_id!;
	pine.offline = true;
	const said = await runUntil(reply, s => /Connection to Pine lost at \d\d:\d\d:\d\dZ; retrying…/.test(text(s)));
	// The reply is read on while the network is down, as the chat reads it: the follower keeps trying, and says it once.
	const tries = pine.calls.events ?? 0;
	const rest = drain(reply, said);
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.ok((pine.calls.events ?? 0) >= tries + 3, `it tried again while offline: ${(pine.calls.events ?? 0) - tries} more attempts`);
	pine.finish(turnId, { state: 'completed', text: 'The drama is made.' }); // it ended on the Computer meanwhile
	pine.offline = false;
	await rest;
	assert.equal(text(said).match(/Connection to Pine lost/g)?.length, 1, text(said));
	assert.match(text(said), /Reconnected to Pine at \d\d:\d\d:\d\dZ\. The turn ended while the connection was lost; its results are fetched now\.[^]*The drama is made\./);
	assert.equal(pine.calls.run, 1, 'no turn is started again');
	assert.equal(store.chat(KEY)!.state, 'idle');
});

test('a lost connection that outlasts the limit ends the wait with Reload Window; a reload attaches to the same turn (F4: every wait has an exit)', async () => {
	const { pine, window } = setup({ reconnectLimitMs: 80 });
	const first = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(first.service, first.store);
	const turnId = first.store.chat(KEY)!.current_turn_id!;
	pine.offline = true;
	const said = await drain(reply);
	const unreachable = said.filter(u => u.kind === 'unreachable');
	assert.equal(unreachable.length, 1, text(said));
	assert.match(unreachable[0].text, /Pine could not be reached since \d\d:\d\d:\d\dZ\.[^]*may still be running/);
	// The turn was not given up on Pine's side: it is still this Chat's running turn, for the reload to follow.
	assert.equal(first.store.chat(KEY)!.state, 'running');
	// The window reloads (a new window on the same store: the crash and restart case alike) once the network is back.
	pine.offline = false;
	pine.finish(turnId, { state: 'completed', text: 'The drama is made.' });
	const second = window();
	const again = await drain(second.service.attachChatToPineTurn(KEY));
	assert.match(text(again), /The drama is made\./);
	assert.equal(pine.calls.run, 1, 'the reload starts no turn');
	assert.equal(second.store.chat(KEY)!.state, 'idle');
});

test('a message queued behind a turn whose follow gave up is given back, never sent over the running turn: its wait has an exit (audit item 12)', async () => {
	const { pine, window } = setup({ reconnectLimitMs: 80 });
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(service, store);
	const queued = drain(service.submit(KEY, 'and the poster', 'and the poster', FOLDER));
	pine.offline = true;
	await drain(reply);
	// The follow of the turn the message waits for gives up with the turn still running: nothing is sent over it.
	const said = text(await queued);
	assert.match(said, /was not sent: a turn is still running[^]*```text\nand the poster\n```/);
	assert.equal(pine.calls.run, 1);
});

test('the reply whose view ends while it waits to retry stops there: the wait has an exit, and the next follower attaches (F4, D25)', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(service, store);
	const turnId = store.chat(KEY)!.current_turn_id!;
	pine.offline = true;
	await runUntil(reply, s => /Connection to Pine lost/.test(text(s)));
	const returned = await Promise.race([reply.return(undefined).then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2_000))]);
	assert.equal(returned, true, 'the retrying follower ends when its reply does');
	pine.offline = false;
	pine.finish(turnId, { state: 'completed', text: 'Done after all.' });
	assert.match(text(await drain(service.attachChatToPineTurn(KEY))), /Done after all\./);
	assert.equal(pine.calls.run, 1);
});

test('a Computer stopped under a followed turn ends the session as a reload does, even when the event stream failed first (F4: Stop All)', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(service, store);
	await reply.return(undefined); // the reply's view ended; the turn goes on
	const credentials = store.chat(KEY)!;
	// Stop All: the Computer stops; the stream's own error comes first, then the turn read finds the session gone.
	pine.fail('events', new Error('pinesandbox: the Computer can\'t be reached at its host (op=GET /v2/sessions/x/agent/events)'));
	pine.stop(`cred:${credentials.computer_id}`);
	const said = await drain(service.attachChatToPineTurn(KEY));
	assert.ok(said.some(u => u.kind === 'sessionEnded'), text(said));
	const after = store.chat(KEY)!;
	assert.equal(after.pine_session_state, 'ended');
	assert.equal(after.state, 'idle');
	assert.equal(after.current_turn_id, null);
});

test('a message is never queued behind a turn whose Computer is gone: it goes to the agent started again (F4)', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(service, store);
	await reply.return(undefined);
	pine.stop(`cred:${store.chat(KEY)!.computer_id}`);
	const said = await drain(service.submit(KEY, 'and the poster', 'and the poster', FOLDER));
	assert.doesNotMatch(text(said), /still running this turn/, text(said));
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text like 'and the poster%' and state = 'sent'").get()!.n, 1, text(said));
});

test('a lost reply on the turn read is a lost connection, not the turn\'s end: the follower reads the same turn again (F4)', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const reply = await running(service, store);
	const turnId = store.chat(KEY)!.current_turn_id!;
	pine.offline = true; // one read that gets no answer
	await runUntil(reply, s => /Connection to Pine lost/.test(text(s)));
	pine.offline = false;
	setTimeout(() => pine.finish(turnId, { state: 'needs_input', text: 'Which episode?' }), 50);
	const said = await drain(reply);
	assert.match(text(said), /Reconnected to Pine at [^]*following the turn again[^]*Which episode\?/);
	assert.equal(store.chat(KEY)!.state, 'needs_input');
	assert.equal(pine.calls.run, 1);
});

// The port maps exactly what @pinesandbox/computer 0.3.5 throws (sdkPort.ts, isGone and isLost).
test('the SDK port maps a gone Computer on the event stream to MissingError, and a lost stream or read to ConnectionLostError (F4)', async () => {
	// The SDK as sdkPort loads it, by import(): its ESM build. A static import here would load the CommonJS build, whose
	// error classes are other classes, so instanceof would not see them (the package ships both, package.json "exports").
	const { ApiError, ConnectionError, ProblemType, SandboxGoneError, StreamLostError, TimeoutError } = await import('@pinesandbox/computer');
	const session = { credentials: 'c', binding: 'b', name: 'noble-river', token: 't' } as never;
	const portWith = (agent: object) => {
		const sdk = new SdkPort();
		sdk['session'] = async () => ({ agent }) as never;
		return sdk;
	};
	const streaming = (error: Error) => portWith({ events: async function* () { throw error; } });
	const drainEvents = async (port: SdkPort) => { for await (const _ of port.events(ENV, session, undefined, undefined, new AbortController().signal)) { /* none */ } };
	const gone = new SandboxGoneError({ host: 'c36888a9.computer.lvh.me:18080', operation: 'GET /v2/sessions/noble-river/agent/events', requestId: 'req-1' } as never);
	await assert.rejects(drainEvents(streaming(gone)), MissingError);
	await assert.rejects(drainEvents(streaming(new StreamLostError('h', 'GET events', 'req-2', new Error('fetch failed')))), ConnectionLostError);
	const waiting = (error: Error) => portWith({ wait: async () => { throw error; } });
	await assert.rejects(waiting(new ConnectionError('h', 'GET turn', 'fetch failed')).turn(ENV, session, 'turn_1', 10_000), ConnectionLostError);
	await assert.rejects(waiting(new TimeoutError('h', 'GET turn', 'req-3', 'deadline exceeded')).turn(ENV, session, 'turn_1', 10_000), ConnectionLostError);
	// A session Pine no longer has is gone too, on a call and on the stream.
	const noSession = () => new ApiError({ status: 404, problemType: ProblemType.sessionNotFound, title: 'Not Found', detail: 'no such session', host: 'h', operation: 'GET /v2/sessions/noble-river/agent/events', requestId: 'req-4' } as never);
	await assert.rejects(drainEvents(streaming(noSession())), MissingError);
	await assert.rejects(waiting(noSession()).turn(ENV, session, 'turn_1', 10_000), MissingError);
});
