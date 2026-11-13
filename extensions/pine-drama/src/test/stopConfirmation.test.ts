import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SdkPort } from '../sdkPort';
import { ChatService } from '../core/chats';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';

const env = { endpoint: 'https://offline.invalid', apiKey: 'offline' };
const key = 'pine-computer:/stop-confirmation';

for (const outcome of [false, true, new Error('offline stop timeout')]) {
	test(`SDK Stop ${String(outcome)} never invents completion`, async () => {
		const sdk = new SdkPort();
		sdk['computer'] = async () => ({ stop: async () => {
			if (outcome instanceof Error) { throw outcome; }
			return outcome;
		} }) as never;
		if (outcome === true) { await sdk.stopComputer(env, 'offline', 'offline'); }
		else { await assert.rejects(sdk.stopComputer(env, 'offline', 'offline')); }
	});
}

test('an unconfirmed SDK Stop keeps the existing session and Computer active (developer Stop All, D44)', async () => {
	const store = new Store(join(mkdtempSync(join(tmpdir(), 'pine-stop-confirmation-')), 'studio.sqlite'));
	const pine = new FakePine();
	const logs: string[] = [];
	const service = new ChatService({ holdsProject: () => true, store, port: pine, vault: new MemoryVault(), pine: env, log: s => logs.push(s) });
	try {
		for await (const _ of service.submit(key, 'offline fixture', 'offline fixture')) { /* drain */ }
		const before = store.chat(key)!;
		const sdk = new SdkPort();
		sdk['computer'] = async () => ({ stop: async () => false }) as never;
		pine.stopComputer = (connection, credentials) => sdk.stopComputer(connection, credentials, 'offline');
		const asked = await service.stopAll();
		assert.deepEqual(asked.map(a => a.outcome), ['unconfirmed']);
		const after = store.chat(key)!;
		assert.equal(after.computer_state, 'running');
		assert.equal(after.pine_session_state, 'open');
		assert.equal(after.pine_session_name, before.pine_session_name);
		assert.match(asked[0].detail ?? '', /not confirmed/);
	} finally { store.close(); }
});

test('restarting a lost session cannot create a successor while its Computer Stop is unconfirmed', async () => {
	const store = new Store(join(mkdtempSync(join(tmpdir(), 'pine-stop-restart-')), 'studio.sqlite'));
	const pine = new FakePine();
	const service = new ChatService({ holdsProject: () => true, store, port: pine, vault: new MemoryVault(), pine: env });
	try {
		for await (const _ of service.submit(key, 'offline fixture', 'offline fixture')) { /* drain */ }
		store.updateChat(key, { pine_session_state: 'ended' }); // independently confirmed session loss
		const creates = pine.calls.createSession;
		const confirmedStop = pine.stopComputer.bind(pine);
		const sdk = new SdkPort();
		sdk['computer'] = async () => ({ stop: async () => false }) as never;
		pine.stopComputer = (connection, credentials) => sdk.stopComputer(connection, credentials, 'offline');
		const updates = [];
		for await (const update of service.startNewSession(key)) { updates.push(update); }
		assert.equal(pine.calls.createSession, creates);
		assert.equal(store.chat(key)!.pine_session_state, 'ended');
		assert.equal(store.chat(key)!.computer_state, 'creating', 'unconfirmed restart keeps serial admission reserved');
		assert.ok(updates.some(update => update.text.includes('not confirmed')));
		pine.stopComputer = confirmedStop;
		for await (const _ of service.startNewSession(key)) { /* explicit retry after confirmed Stop */ }
		assert.equal(pine.calls.createSession, creates + 1);
		assert.equal(store.chat(key)!.pine_session_state, 'open');
	} finally { store.close(); }
});
