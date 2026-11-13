import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { START_WAIT_SECONDS, StartTimeoutError, type PineConnection } from '../core/pinePort';
import { Store } from '../core/store';
import { SdkPort } from '../sdkPort';
import { FakePine, MemoryVault } from './fakePine';

// A start that waits for a Computer says how long, and one that runs out of time says so with
// Pine's last state. On pine-dev on 2026-11-03 a full pool left a new session
// at "Starting a Pine Computer…" with nothing else said.

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/local-1';

function setup() {
	const pine = new FakePine();
	const store = new Store(join(mkdtempSync(join(tmpdir(), 'pine-start-')), 'studio.sqlite'));
	const logs: string[] = [];
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), pine: ENV, log: line => logs.push(line) });
	return { pine, store, service, logs };
}

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const out: Update[] = [];
	for await (const update of updates) {
		out.push(update);
	}
	return out;
}
const send = (service: ChatService, text: string) => drain(service.submit(KEY, text, text));
const markdown = (updates: Update[]) => updates.filter(u => u.kind !== 'progress').map(u => u.text).join('\n');

test('the start says how long Pine may wait', async () => {
	const { pine, service } = setup();
	const updates = await send(service, 'hello');
	assert.ok(updates.some(u => u.kind === 'progress' && u.text === 'Starting a Pine Computer… Pine waits up to 5 minutes for one.'));
	assert.equal(pine.starts.length, 1);
	assert.match(markdown(updates), /done: hello/);
});

// As the person cut it: only what was observed, the message given back in its line
// (unsentLine), no Stop and no cause. Sending it again is the ordinary Send.
test('a start that runs out of time gives the message back, says what was seen, and the next send starts it again', async () => {
	const { pine, store, service, logs } = setup();
	pine.fail('ensureComputer', new StartTimeoutError('sbx-1', 'pending'));
	const updates = await send(service, 'hello');
	assert.equal(markdown(updates), "\n\n_Your message was not sent: the Pine Computer did not start in time (it was last `pending`). Here it is, to send again:_\n\n```text\nhello\n```\n\n");
	assert.equal(store.chat(KEY)!.computer_state, 'creating');
	assert.equal(pine.calls.run ?? 0, 0, 'nothing was sent');
	assert.ok(logs.some(line => line.includes('did not start within 300s (sandbox sbx-1, last state pending)')));
	assert.match(markdown(await send(service, 'hello again')), /done: hello again/);
	assert.equal(store.chat(KEY)!.computer_state, 'running');
});

test('the SDK port passes the wait limit, and maps the SDK\'s ReadyTimeoutError', async () => {
	const { Credentials, ReadyTimeoutError, UnknownComputerError } = await import('@pinesandbox/computer');
	const port = new SdkPort();
	const credentials = (await Credentials.generate()).serialize();
	const seen: { call: string; readyTimeoutMs?: number }[] = [];
	const unknown = Object.create(UnknownComputerError.prototype) as Error;
	let createFails: Error | undefined;
	port['client'] = async () => ({
		startComputer: async (_c: unknown, o: { readyTimeoutMs?: number }) => { seen.push({ call: 'start', ...o }); throw unknown; },
		createComputer: async (o: { readyTimeoutMs?: number }) => {
			seen.push({ call: 'create', ...o });
			if (createFails) {
				throw createFails;
			}
			return { binding: () => ({ serialize: () => 'bound' }) };
		},
	}) as never;
	assert.deepEqual(await port.ensureComputer(ENV, credentials, 'label', 3600), { binding: 'bound' });
	assert.deepEqual(seen.map(s => [s.call, s.readyTimeoutMs]), [['start', START_WAIT_SECONDS * 1000], ['create', START_WAIT_SECONDS * 1000]]);
	createFails = new ReadyTimeoutError('sbx-9', 'pending');
	await assert.rejects(port.ensureComputer(ENV, credentials, 'label', 3600), (e: Error) => e instanceof StartTimeoutError && e.sandboxId === 'sbx-9' && e.lastState === 'pending');
});
