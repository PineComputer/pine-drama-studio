import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { BUDGET, LOCAL_REVIEW, STANDING_PARAGRAPH } from '../core/instructions';
import type { PineConnection } from '../core/pinePort';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { idleStopAndDiscover } from './idleStop';

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/local-1';

function setup() {
	const path = join(mkdtempSync(join(tmpdir(), 'pine-studio-')), 'studio.sqlite');
	const store = new Store(path);
	const pine = new FakePine();
	const options = { holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), pine: ENV, leaseTtlMs: 30_000 };
	return { store, pine, service: new ChatService(options), options };
}
async function send(service: ChatService, text: string): Promise<Update[]> {
	const out: Update[] = [];
	for await (const update of service.submit(KEY, text, text)) {
		out.push(update);
	}
	return out;
}
const sentText = (store: Store) => store.db.prepare("select kind, text from saved_sends order by created_at, rowid").all().map(r => ({ ...r })) as { kind: string; text: string }[];

test('the standing instructions ask for no pack and no lineage: the task\'s transport returns the turn (D21)', () => {
	// pine-dev, 2026-11-03: with the old returns still sent beside the transport, an agent ran the lineage export instead of
	// the task's return step, and the Studio received nothing.
	assert.doesNotMatch(STANDING_PARAGRAPH, /handoff|project\.tar|lineage|pack drama/);
});

test('a session\'s first run carries the instructions once, recorded as the Studio\'s, never the person\'s', async () => {
	const { store, service } = setup();
	await send(service, 'make a drama');
	const first = sentText(store)[0];
	assert.equal(first.text, `make a drama\n\n${STANDING_PARAGRAPH}`);
	assert.ok(first.text.endsWith(LOCAL_REVIEW));
	assert.equal(first.text.split(LOCAL_REVIEW).length - 1, 1);
	// The first run states the budget once, so the agent has no reason to ask about it.
	assert.equal(first.text.split(BUDGET).length - 1, 1);
	assert.ok(BUDGET.includes('drama/drama-cli.cfg.yaml') && BUDGET.includes('without asking me about cost') && BUDGET.includes('stop and tell me'));
	const messages = store.messages(KEY);
	assert.deepEqual(messages.filter(m => m.kind === 'prompt').map(m => m.text), ['make a drama']);
	assert.deepEqual(messages.filter(m => m.kind === 'instructions').map(m => m.text), [STANDING_PARAGRAPH]);
	// The next run of the same session does not repeat them.
	await send(service, 'next');
	assert.equal(sentText(store)[1].text, 'next');
	assert.equal(store.messages(KEY).filter(m => m.kind === 'instructions').length, 1);
});

test('an answer never carries them', async () => {
	const { store, pine, service } = setup();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }];
	await send(service, 'draw');
	await send(service, 'EP003');
	assert.equal(sentText(store)[1].kind, 'run');
	assert.equal(sentText(store)[1].text, 'EP003');
});

test('a run that failed did not deliver them: the next run carries them; a new session carries them again', async () => {
	const { store, service, pine, options } = setup();
	await send(service, 'first');
	store.db.prepare("update saved_sends set state = 'failed'").run();
	await send(service, 'second');
	assert.equal(sentText(store)[1].text, `second\n\n${STANDING_PARAGRAPH}`);
	await idleStopAndDiscover(pine, store, () => new ChatService(options), KEY);
	for await (const _ of service.startNewSession(KEY)) { /* drain */ }
	await send(service, 'third');
	assert.equal(sentText(store)[2].text, `third\n\n${STANDING_PARAGRAPH}`);
});
