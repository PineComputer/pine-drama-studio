import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openProjectChat, projectWindowRestorer } from '../projectChatNavigation';
import { projectSessions } from '../core/projectSessions';
import { Store } from '../core/store';
import { associateProject } from './storeFixture';

test('initial restore and the exact destination are serialized across focus events', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-window-restore-')));
	const store = new Store(':memory:');
	for (const key of ['main', 'episode']) {
		store.insertChat({ key, label: key, env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
		associateProject(store, key, root);
	}
	store.requestChatReveal('episode');
	const calls: string[] = [];
	let selected = 'main';
	let restored!: (key: string) => void;
	const ready = new Promise<string>(resolve => { restored = resolve; }).then(resource => ({ resource, isUntitledDraft: false }));
	const restore = projectWindowRestorer({
		scope: () => projectSessions(root, store.chats()),
		prepare: async () => { calls.push('prepare'); return ready; },
		fresh: async () => { calls.push('fresh'); },
		takeRequested: root => { calls.push('take'); return store.takeChatReveal(root, 60_000); },
		show: async key => { calls.push(`show:${key}`); selected = key; },
		failed: error => { throw error; },
	});
	const first = restore(); const focused = restore();
	await Promise.resolve(); assert.deepEqual(calls, ['prepare']);
	restored('main');
	await Promise.all([first, focused]);
	assert.deepEqual(calls, ['prepare', 'take', 'show:episode', 'take'], 'the focus waits for the startup, and prepares nothing again');
	assert.equal(selected, 'episode', 'the restored Chat never overrides the named destination');
	assert.equal(store.takeChatReveal(root, 60_000), undefined);
	store.close();
});

test('no Chat is chosen by default: a draft or a Chat of this project stays, another project\'s is replaced by a fresh Chat', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-window-default-none-')));
	const store = new Store(':memory:');
	store.insertChat({ key: 'here', label: 'here', env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
	associateProject(store, 'here', root);
	// Code-OSS getNewChatSessionResource('pine-computer') before first send; no provider item/history exists yet.
	const cases: [{ resource: string; isUntitledDraft: boolean } | undefined, number][] = [
		[undefined, 0], [{ resource: 'here', isUntitledDraft: false }, 0],
		[{ resource: 'pine-computer:/untitled-offline-fixture', isUntitledDraft: true }, 0], [{ resource: 'foreign', isUntitledDraft: false }, 1],
	];
	for (const [restored, fresh] of cases) {
		let opened = 0;
		const shown: string[] = [];
		const restore = projectWindowRestorer({
			scope: () => projectSessions(root, store.chats()),
			prepare: async () => restored,
			fresh: async () => { opened++; },
			takeRequested: () => undefined,
			show: async key => { shown.push(key); },
			failed: error => { throw error; },
		});
		await restore();
		await restore();
		assert.deepEqual([shown, opened], [[], fresh], JSON.stringify(restored));
	}
	store.close();
});

test('navigation shows a Chat of this project here; foreign destinations open their exact canonical root before selecting Chat', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-chat-navigation-')));
	const foreign = join(root, 'foreign'); mkdirSync(foreign);
	const store = new Store(':memory:');
	for (const [key, folder] of [['here', root], ['foreign', foreign]]) {
		store.insertChat({ key, label: key, env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
		associateProject(store, key, folder);
	}
	const scope = projectSessions(root, store.chats());
	const calls: string[][] = [];
	const navigation = {
		scope: () => scope, chat: (key: string) => store.chat(key),
		show: async (key: string) => { calls.push(['show', key]); },
		open: async (path: string) => { calls.push(['open', path]); },
		request: (key: string) => store.requestChatReveal(key), clear: (token: string) => store.clearChatReveal(token),
	};
	await openProjectChat('here', navigation);
	assert.deepEqual(calls, [['show', 'here']]);
	await openProjectChat('foreign', navigation);
	assert.deepEqual(calls.at(-1), ['open', foreign]);
	assert.equal(store.takeChatReveal(root, 60_000), undefined);
	assert.equal(store.takeChatReveal(foreign, 60_000), 'foreign');
	await assert.rejects(openProjectChat('missing', navigation), /no associated/);
	await assert.rejects(openProjectChat('foreign', { ...navigation, open: async () => { throw new Error('open failed'); } }), /open failed/);
	assert.equal(store.takeChatReveal(foreign, 60_000), undefined);
	assert.equal(store.chat('foreign')!.computer_state, 'none', 'navigation starts nothing');
	store.close();
});
