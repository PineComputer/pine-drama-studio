import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initialProjectChat, openProjectChat, projectWindowRestorer } from '../projectChatNavigation';
import { projectSessions } from '../core/projectSessions';
import { Store } from '../core/store';
import { associateProject } from './storeFixture';

const savedChat = (resource: string) => ({ resource, isUntitledDraft: false });

test('default entry preserves a restored episode; a named destination overrides it only inside its project', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-chat-navigation-')));
	const store = new Store(':memory:');
	store.insertChat({ key: 'ep1', label: 'Episode 1', env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
	associateProject(store, 'ep1', root, null);
	const scope = projectSessions(root, store.chats());
	assert.equal(initialProjectChat(undefined, savedChat('foreign')), undefined);
	assert.equal(initialProjectChat(scope), scope.mainKey);
	assert.equal(initialProjectChat(scope, savedChat('pine-computer:/untitled-empty')), scope.mainKey, 'an empty native draft still defaults to main');
	assert.equal(initialProjectChat(scope, savedChat('foreign')), scope.mainKey);
	assert.equal(initialProjectChat(scope, savedChat('ep1')), undefined);
	assert.equal(initialProjectChat(scope, savedChat(scope.mainKey)), undefined);
	assert.equal(initialProjectChat(scope, savedChat(scope.mainKey), 'ep1'), 'ep1');
	assert.equal(initialProjectChat(scope, savedChat('ep1'), 'foreign'), undefined);
	store.close();
});

test('initial restore and the exact destination are serialized across focus events', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-window-restore-')));
	const store = new Store(':memory:');
	for (const key of ['main', 'episode']) {
		store.insertChat({ key, label: key, env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
		associateProject(store, key, root, key === 'main' ? { kind: 'main' } : null);
	}
	store.requestChatReveal('episode');
	const calls: string[] = [];
	let selected = 'main';
	let restored!: (key: string) => void;
	const ready = new Promise<string>(resolve => { restored = resolve; });
	const restore = projectWindowRestorer({
		scope: () => projectSessions(root, store.chats()),
		prepare: async () => { calls.push('prepare'); return ready.then(savedChat); },
		takeRequested: root => { calls.push('take'); return store.takeChatReveal(root, 60_000); },
		show: async key => { calls.push(`show:${key}`); selected = key; },
		review: async () => { calls.push('review'); }, failed: error => { throw error; },
	});
	const first = restore(); const focused = restore();
	await Promise.resolve(); assert.deepEqual(calls, ['prepare']);
	restored('main');
	await Promise.all([first, focused]);
	assert.deepEqual(calls, ['prepare', 'take', 'show:episode', 'review', 'take', 'review'], 'the focus waits for the startup, and prepares nothing again');
	assert.equal(selected, 'episode', 'the restored main never overrides the named episode destination');
	assert.equal(store.takeChatReveal(root, 60_000), undefined);
	store.close();
});

test('the startup default runs once: a later focus after a failed restore does not switch an empty New Chat', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-window-default-once-')));
	const store = new Store(':memory:');
	const scope = projectSessions(root, store.chats());
	const shown: string[] = [];
	const failures: unknown[] = [];
	let reviewCalls = 0;
	const restore = projectWindowRestorer({
		scope: () => scope,
		// Before the first default nothing related is open; later the person has opened an empty untitled New Chat,
		// which is neither a draft nor a project Chat (pineProjectChat.ts:67-69).
		prepare: async () => savedChat('pine-computer:/untitled-empty'),
		takeRequested: () => undefined,
		show: async key => { shown.push(key); },
		review: async () => { if (++reviewCalls === 1) { throw new Error('review reveal failed'); } },
		failed: error => { failures.push(error); },
	});
	await restore();
	assert.deepEqual(shown, [scope.mainKey], 'the first focus applies the default');
	assert.equal(failures.length, 1, 'the failure is reported');
	await restore();
	assert.deepEqual(shown, [scope.mainKey], 'the default is not applied again');
	assert.equal(reviewCalls, 2, 'the rest of the sequence still runs on the next focus');
	store.close();
});

test('navigation shows an unsent main locally; foreign destinations open their exact canonical root before selecting Chat', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-chat-navigation-')));
	const foreign = join(root, 'foreign'); mkdirSync(foreign);
	const store = new Store(':memory:');
	store.insertChat({ key: 'foreign', label: 'Episode 1', env: 'offline', endpoint: 'https://pine.test', secret_ref: 'offline' });
	associateProject(store, 'foreign', foreign, { kind: 'main' });
	const scope = projectSessions(root, store.chats());
	const calls: string[][] = [];
	const navigation = {
		scope: () => scope, chat: (key: string) => store.chat(key),
		show: async (key: string) => { calls.push(['show', key]); },
		open: async (path: string) => { calls.push(['open', path]); },
		request: (key: string) => store.requestChatReveal(key), clear: (token: string) => store.clearChatReveal(token),
	};
	await openProjectChat(scope.mainKey, navigation);
	assert.deepEqual(calls, [['show', scope.mainKey]]);
	assert.equal(store.chat(scope.mainKey), undefined);
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

for (const input of ['text', 'attachments'] as const) {
	test(`native New Chat with already-restored ${input} stays visible`, async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-untitled-restore-')));
		const store = new Store(':memory:');
		// Code-OSS getNewChatSessionResource('pine-computer') before first send; no provider item/history exists yet.
		const resource = 'pine-computer:/untitled-offline-fixture';
		let selected = resource;
		const unsent = { text: input === 'text' ? 'OFFLINE unsent New Chat' : '', files: input === 'attachments' ? [join(root, 'script.fountain')] : [] };
		const original = structuredClone(unsent);
		const restore = projectWindowRestorer({
			scope: () => projectSessions(root, store.chats()), prepare: async () => ({ resource, isUntitledDraft: true }),
			takeRequested: () => undefined,
			show: async key => { selected = key; },
			review: async () => {}, failed: error => { throw error; },
		});
		await restore();
		assert.equal(selected, resource, 'the native draft must remain reachable in the active Chat');
		assert.deepEqual(unsent, original);
		assert.deepEqual(store.chats(), []);
		store.close();
	});
}
