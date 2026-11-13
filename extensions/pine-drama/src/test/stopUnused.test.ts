import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, stopAllSummary, type Update } from '../core/chats';
import type { PineConnection } from '../core/pinePort';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';

// Explicit developer shutdown and a lost remote session can stop a Computer.
// Native archive is tested at the provider boundary; it never calls this shutdown path. On pine-dev on 2026-11-03 six sessions no one used held
// the whole pool for up to three hours each.

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/local-1';
const OTHER = 'pine-computer:/local-2';

function setup() {
	const path = join(mkdtempSync(join(tmpdir(), 'pine-stop-')), 'studio.sqlite');
	const pine = new FakePine();
	const vault = new MemoryVault();
	const window = (pineEnv: PineConnection = ENV) => {
		const store = new Store(path);
		return { store, service: new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault, pine: pineEnv }) };
	};
	return { pine, window };
}

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const out: Update[] = [];
	for await (const update of updates) {
		out.push(update);
	}
	return out;
}
const send = (service: ChatService, text: string, key = KEY) => drain(service.submit(key, text, text));
const markdown = (updates: Update[]) => updates.filter(u => u.kind !== 'progress').map(u => u.text).join('\n');
const computerOf = (pine: FakePine, store: Store, key: string) => pine.computers.get(store.chat(key)!.computer_id!)!;
const notices = (store: Store, key: string) => store.messages(key).filter(m => m.kind === 'notice').map(m => m.text);

// The one developer command simulates Pine's idle stop, for testing the path where the Studio finds a Computer
// stopped. It asks Pine to stop each running Computer and records nothing; the Studio learns of the stop the next time it
// asks Pine, on Pine's evidence.
test("developer Stop All stops the Computer at Pine and records nothing; the next send finds the stop through the port", async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	await send(service, 'hello');
	const before = store.chat(KEY)!;
	assert.deepEqual((await service.stopAll()).map(a => [a.key, a.outcome]), [[KEY, 'confirmed']]);
	assert.equal(computerOf(pine, store, KEY).state, 'stopped');
	const after = store.chat(KEY)!;
	assert.deepEqual([after.computer_state, after.pine_session_state, after.pine_session_name], [before.computer_state, before.pine_session_state, before.pine_session_name], 'nothing recorded');
	assert.deepEqual(notices(store, KEY), []);
	const updates = await send(service, 'again');
	assert.ok(updates.every(u => u.kind !== 'sessionEnded'));
	assert.equal(notices(store, KEY)[0], 'The original session ended: the Computer is stopped; Pine does not keep a session across a stop.');
	// As after a real idle stop: the message starts the agent again on the same Computer and is sent there.
	assert.equal(computerOf(pine, store, KEY).state, 'running');
	assert.equal(store.chat(KEY)!.pine_session_state, 'open');
});

test('a session Pine no longer has stops its still-running Computer; the next message starts it again and is sent', async () => {
	const { pine, window } = setup();
	const first = window();
	await send(first.service, 'hello');
	computerOf(pine, first.store, KEY).sessions.clear(); // Pine lost the session; the Computer runs on
	first.store.close();
	const { store, service } = window(); // a restart checks the session again
	const updates = await send(service, 'are you there?');
	assert.ok(updates.every(u => u.kind !== 'sessionEnded'));
	assert.equal(notices(store, KEY)[0], 'The original session ended: Pine no longer has this session; the Studio stopped its Computer.');
	assert.equal(computerOf(pine, store, KEY).state, 'running', 'started again for the message');
	assert.equal(store.chat(KEY)!.pine_session_state, 'open');
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text like 'are you there?%' and state = 'sent'").get()!.n, 1);
});

test('a stop that fails is logged and said; the session still ends, and the restart confirms its own stop before the new session', async () => {
	const { pine, window } = setup();
	const first = window();
	await send(first.service, 'hello');
	computerOf(pine, first.store, KEY).sessions.clear();
	first.store.close();
	const { store, service } = window();
	pine.fail('stopComputer', new Error('gateway down'));
	await send(service, 'are you there?');
	assert.equal(notices(store, KEY)[0], 'The original session ended: Pine no longer has this session; its Computer could not be stopped (gateway down), so it stops after its idle timeout.');
	assert.equal(store.chat(KEY)!.pine_session_state, 'open', 'the restart stopped the old Computer itself, then began a new session');
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text like 'are you there?%' and state = 'sent'").get()!.n, 1);
});

// Restart's confirmed stop is unchanged by removing stopHeld's session-ending branch, which
// restart never used. A session already ended on Pine's evidence, its Computer still running: the restart a send performs
// stops it, and only after Pine confirms the stop does it create the new session.
test('restart creates the new session only after Pine confirms the stop of the old Computer', async () => {
	const { pine, window } = setup();
	const first = window();
	await send(first.service, 'hello');
	computerOf(pine, first.store, KEY).sessions.clear(); // Pine lost the session; the Computer runs on
	first.store.close();
	const { store, service } = window();
	pine.fail('stopComputer', new Error('gateway down')); // the stop when the loss is found fails; the restart's must succeed
	const order: string[] = [];
	const stop = pine.stopComputer.bind(pine); const create = pine.createSession.bind(pine);
	pine.stopComputer = async (...args) => { await stop(...args); order.push('stop confirmed'); };
	pine.createSession = async (...args) => { order.push('new session'); return create(...args); };
	await send(service, 'are you there?');
	assert.deepEqual(order, ['stop confirmed', 'new session']);
	assert.equal(store.chat(KEY)!.pine_session_state, 'open');
});

test('Stop All stops every running Computer of this connection, a working one too; its follower finds the stop', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	await send(service, 'one');
	pine.plans = [{ state: 'running' }];
	const reply = send(service, 'draw', OTHER);
	await new Promise(resolve => setTimeout(resolve, 100));
	// A whole-Computer stop can interrupt running work; it never calls agent.cancel.
	assert.deepEqual((await service.stopAll()).map(a => a.outcome).sort(), ['confirmed', 'confirmed']);
	assert.equal(computerOf(pine, store, KEY).state, 'stopped');
	assert.equal(computerOf(pine, store, OTHER).state, 'stopped');
	const said = await reply;
	assert.equal(said.filter(u => u.kind === 'sessionEnded').length, 1, markdown(said));
	assert.equal(store.chat(OTHER)!.pine_session_state, 'ended', 'the follower found it on Pine\'s evidence');
	assert.equal(pine.calls.cancel ?? 0, 0);
});

// The list is local, and a Computer Pine already ended stays 'running' here (the developer command writes nothing back). Stop All
// asks Pine each Computer's state first, stops only those Pine reports running, and says what happened.
test('Stop All asks Pine first: it stops only the Computers Pine has not shut down and counts the ended ones apart', async () => {
	const { pine, window } = setup();
	const { store, service } = window();
	await send(service, 'one');
	await send(service, 'two', OTHER);
	// KEY's Computer ended at Pine (an idle stop, a release): Pine no longer has it. OTHER's runs.
	pine.computers.delete(store.chat(KEY)!.computer_id!);
	const stops = pine.calls.stopComputer ?? 0;
	const asked = await service.stopAll();
	assert.deepEqual(asked.map(a => [a.key, a.pine, a.outcome]), [[KEY, null, 'gone'], [OTHER, 'running', 'confirmed']]);
	assert.equal((pine.calls.stopComputer ?? 0) - stops, 1, 'only the running Computer is asked to stop');
	assert.equal(computerOf(pine, store, OTHER).state, 'stopped');
	assert.equal(stopAllSummary(asked), 'Pine still had 1 up and stopped 1; 1 recorded here had already ended.');
	assert.equal(store.chat(KEY)!.computer_state, 'running', 'nothing recorded locally (D44)');
	// One Pine reports stopped is not stopped again either.
	const again = await service.stopAll();
	assert.deepEqual(again.map(a => [a.key, a.pine, a.outcome]), [[KEY, null, 'gone'], [OTHER, 'stopped', 'ended']]);
	assert.equal((pine.calls.stopComputer ?? 0) - stops, 1);
	assert.equal(stopAllSummary(again), 'Pine still had 0 up and stopped 0; 2 recorded here had already ended.');
	// A Computer on its way (saving, stopping, starting) still holds compute: it is asked to stop, never counted ended.
	for (const state of ['saving', 'stopping', 'pending']) {
		// FakePine's type lists the states it reaches itself; Pine's SDK reports these too (computer-ts-v0.3.5 status()).
		(computerOf(pine, store, OTHER) as { state: string }).state = state;
		const before = pine.calls.stopComputer ?? 0;
		assert.deepEqual((await service.stopAll()).map(a => [a.key, a.pine, a.outcome]), [[KEY, null, 'gone'], [OTHER, state, 'confirmed']], state);
		assert.equal((pine.calls.stopComputer ?? 0) - before, 1, `${state} is asked to stop`);
	}
});

test('a session of another Pine environment is left alone', async () => {
	const { pine, window } = setup();
	const first = window();
	await send(first.service, 'hello');
	first.store.close();
	const { store, service } = window({ ...ENV, endpoint: 'https://pinesandbox.io' });
	assert.deepEqual(await service.stopAll(), []);
	assert.equal(computerOf(pine, store, KEY).state, 'running');
});
