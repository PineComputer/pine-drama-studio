import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connectKey, connectionFailure, connectionScope, developerConnectionFile, disconnectProblem, keyProblem, PINE_KEY_SECRET, PRODUCTION_ENDPOINT, savedConnection } from '../core/pineConnection';
import { configLine, notSetUpText, sendGate } from '../pineConfig';
import { MemoryVault, FakePine } from './fakePine';
import { ChatService } from '../core/chats';
import { Store } from '../core/store';
import { refusalOf } from '../core/refusal';

const KEY = 'pk_fixture_not-a-real-key';

test('production is fixed; developer launch files are accepted only in development mode', () => {
	assert.equal(developerConnectionFile(false, '/private/pine-dev.env'), undefined);
	assert.equal(developerConnectionFile(true, '/private/pine-dev.env'), '/private/pine-dev.env');
	assert.equal(developerConnectionFile(true, ''), undefined);
	assert.deepEqual(savedConnection(KEY), { endpoint: PRODUCTION_ENDPOINT, apiKey: KEY });
	assert.equal(savedConnection(undefined), undefined);
	assert.throws(() => savedConnection('invalid'), /saved Pine key is invalid/);
});

test('key entry validates then checks policy before persisting, using the built-in endpoint', async () => {
	const vault = new MemoryVault();
	let checked = false;
	const pine = await connectKey(vault, ` ${KEY} `, async pine => {
		assert.equal(pine.endpoint, PRODUCTION_ENDPOINT);
		assert.equal(pine.apiKey, KEY);
		assert.equal(await vault.get(PINE_KEY_SECRET), undefined);
		checked = true;
	});
	assert.equal(checked, true);
	assert.equal(await vault.get(PINE_KEY_SECRET), KEY);
	assert.deepEqual(pine, savedConnection(KEY));
});

test('invalid, rejected and unreachable keys never replace saved credentials or echo response text', async () => {
	const vault = new MemoryVault();
	await vault.store(PINE_KEY_SECRET, KEY);
	let calls = 0;
	await assert.rejects(connectKey(vault, 'not-a-key', async () => { calls++; }), /pk_/);
	assert.equal(calls, 0);
	assert.ok(keyProblem('pk_abc\nsecret'));
	for (const status of [401, 403, 500, undefined]) {
		try {
			await connectKey(vault, 'pk_other_secret', async () => { throw Object.assign(new Error('pk_other_secret leaked by server'), { status }); });
			assert.fail('connection must fail');
		} catch (error) {
			assert.doesNotMatch(String(error), /pk_other_secret|leaked/);
			assert.match(String(error), status === 401 || status === 403 ? /rejected/ : /Could not verify/);
		}
		assert.equal(await vault.get(PINE_KEY_SECRET), KEY);
	}
	assert.doesNotMatch(connectionFailure(new Error(KEY)), /fixture/);
});

test('credential-store failure is visible and does not expose its error or key', async () => {
	const vault = new MemoryVault();
	vault.store = async () => { throw new Error(KEY); };
	await assert.rejects(connectKey(vault, KEY, async () => undefined), error => {
		assert.match(String(error), /system credential store/);
		assert.doesNotMatch(String(error), /fixture/);
		return true;
	});
	assert.equal(await vault.get(PINE_KEY_SECRET), undefined);
});

test('connection history is deterministic per credential and isolated across endpoints and keys', () => {
	const pine = savedConnection(KEY)!;
	assert.equal(connectionScope(pine), connectionScope({ ...pine }));
	assert.notEqual(connectionScope(pine), connectionScope({ ...pine, apiKey: 'pk_other_secret' }));
	assert.notEqual(connectionScope(pine), connectionScope({ ...pine, endpoint: 'http://localhost:18080' }));
	assert.match(connectionScope(pine), /^[a-f0-9]{64}$/);
});

test('a disconnected send names native Accounts instead of a developer file', () => {
	const config = { kind: 'disconnected' } as const;
	assert.match(notSetUpText(config), /Accounts.*Pine Computer/);
	assert.doesNotMatch(configLine(config), /\.env/);
	assert.equal(sendGate(config, []).kind, 'pine');
});

test('credential changes block new Computer admissions without discarding saved history', async () => {
	const store = new Store(':memory:');
	const pine = new FakePine();
	let current = true;
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), pine: savedConnection(KEY), connectionCurrent: () => current });
	current = false;
	await assert.rejects(async () => { for await (const update of service.submit('pine-computer:/fixture', 'make a drama', 'fixture')) { void update; } }, /connection changed/);
	assert.equal(service.chats().length, 0);
	store.close();
});

test('disconnect refuses tracked running/starting work; stopped work and local history can remain', () => {
	for (const item of [{ computer_state: 'running', state: 'idle' }, { computer_state: 'creating', state: 'idle' }, { computer_state: 'stopped', state: 'running' }]) {
		assert.equal(disconnectProblem([item]), 'A Pine Computer is running or starting. It stops by itself after it has been idle; its results are collected the next time the Studio starts with this key.');
	}
	assert.equal(disconnectProblem([{ computer_state: 'stopped', state: 'idle' }]), undefined);
});

test('credential invalidation keeps admitted turns followable and blocks a new session', async () => {
	const store = new Store(':memory:');
	const pine = new FakePine();
	let current = true;
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), pine: savedConnection(KEY), connectionCurrent: () => current });
	pine.plans = [{ state: 'running' }];
	const id = 'pine-computer:/admitted';
	const run = service.submit(id, 'make the drama', 'fixture');
	while (store.chat(id)?.state !== 'running') { await run.next(); }
	await run.return(undefined);
	current = false;
	pine.finish(store.chat(id)!.current_turn_id!, { state: 'completed', text: 'The drama is made.' });
	for await (const update of service.attachChatToPineTurn(id)) { void update; }
	assert.equal(store.chat(id)!.state, 'idle');
	assert.equal(pine.calls.run, 1);
	await assert.rejects(async () => { for await (const update of service.startNewSession(id)) { void update; } }, /connection changed/);
	store.close();
});

test('the actual disconnected refusal renders connection wording and the Accounts route', () => {
	const refusal = refusalOf({ kind: 'pine', text: notSetUpText({ kind: 'disconnected' }) }, { openFolder: '', newFolder: '', openGivenFolder: '' }, '');
	assert.match(refusal.line, /Open Accounts \(bottom left\) → Pine Computer… to connect with your project key/, 'what only the modal said before (Codex on #584)');
	assert.doesNotMatch(refusal.line, /environment/);
});
