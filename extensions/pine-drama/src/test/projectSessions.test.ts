import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectSessions, sessionProjectRoot } from '../core/projectSessions';
import { Store } from '../core/store';
import { ChatService } from '../core/chats';
import { FakePine, MemoryVault } from './fakePine';
import { testProtocol } from './protocolFixture';
import { writeFileSync } from 'node:fs';
import { associateProject } from './storeFixture';

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-session-scope-')));
	const root = join(dir, 'North Harbor'); mkdirSync(root);
	const other = join(dir, 'other', 'North Harbor'); mkdirSync(other, { recursive: true });
	const store = new Store(join(dir, 'studio.sqlite'));
	for (const key of ['main', 'ep1', 'other']) { store.insertChat({ key, endpoint: 'https://pine.test', label: 'Work', secret_ref: key }); }
	return { dir, root, other, store };
}

for (const existing of [false, true]) {
	test(`a project's first send survives synchronous UI refresh${existing ? ' after an interrupted unbound insertion' : ''}`, async () => {
		const { dir, root, store } = fixture();
		const key = 'pine-computer:/session-first';
		if (existing) { store.insertChat({ key, endpoint: 'http://pine.test', label: 'First send', secret_ref: 'offline' }); }
		const pine = new FakePine(); pine.plans = [{ state: 'completed' }];
		const seen: string[] = [];
		let unboundNotifications = 0;
		const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(),
			pine: { endpoint: 'http://pine.test', apiKey: 'offline' },
			files: { projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir),
			onChange: () => {
				// The real extension refreshes scoped Sessions synchronously on every service notification.
				const current = store.chat(key);
				if (current?.folder) { assert.equal(current.folder, root); seen.push(current.folder); }
				else if (current) { unboundNotifications++; }
			},
		});
		const script = join(dir, 'script.txt'); writeFileSync(script, 'OFFLINE screenplay');
		try {
			assert.doesNotThrow(() => projectSessions(root, store.chats()));
			for await (const _update of service.submit(key, 'Read the script', 'First send', [{ kind: 'file', path: script }], root)) { /* drain fake transport */ }
			assert(seen.length > 0); assert.equal(store.chat(key)!.folder, root);
			if (!existing) { assert.equal(unboundNotifications, 0, 'new-row notification follows folder admission'); }
			assert.deepEqual(projectSessions(root, store.chats()).chats.map(c => c.key), [key]); assert.equal(pine.calls.run, 1);
		} finally { store.close(); }
	});
}

test('an unbound row is not project history, and a row bound elsewhere is that project\'s', () => {
	const { root, other, store } = fixture();
	const key = 'pine-computer:/session-pending';
	store.insertChat({ key, endpoint: 'http://pine.test', label: 'Pending', secret_ref: 'offline' });
	try {
		assert.deepEqual(projectSessions(root, store.chats()).chats, []);
		associateProject(store, key, other);
		assert.deepEqual(projectSessions(root, store.chats()).chats, []);
		assert.deepEqual(projectSessions(other, store.chats()).chats.map(c => c.key), [key]);
	} finally { store.close(); }
});

test('empty/multiple-folder windows have no project session scope', () => {
	assert.equal(sessionProjectRoot([]), undefined);
	assert.equal(sessionProjectRoot(['/one', '/two']), undefined);
});

test('refresh preserves the pinned root through alias retargeting and local folder loss', () => {
	const { dir, root, other, store } = fixture();
	const alias = join(dir, 'alias'); symlinkSync(root, alias);
	associateProject(store, 'main', root);
	associateProject(store, 'other', other);
	const pinned = sessionProjectRoot([alias])!;
	unlinkSync(alias); symlinkSync(other, alias);
	assert.deepEqual(projectSessions(pinned, store.chats()).chats.map(c => c.key), ['main']);
	assert.equal(sessionProjectRoot([alias]), other, 'only explicit entry retargets the alias');
	unlinkSync(alias); symlinkSync(root, alias);
	renameSync(root, root + '-moved');
	assert.deepEqual(projectSessions(pinned, store.chats()).chats.map(c => c.key), ['main'], 'saved history stays readable');
	assert.throws(() => sessionProjectRoot([alias]), /missing|ENOENT/, 'explicit re-entry validates the root');
	store.close();
});

test('named Chat reveal is project-qualified, single-consumer and starts nothing', () => {
	const { root, other, store, dir } = fixture();
	associateProject(store, 'main', root);
	associateProject(store, 'ep1', root);
	associateProject(store, 'other', other);
	const second = new Store(join(dir, 'studio.sqlite'));
	store.requestChatReveal('main'); store.requestChatReveal('other'); store.requestChatReveal('ep1');
	assert.equal(second.takeChatReveal(root, 60_000), 'ep1');
	assert.equal(store.takeChatReveal(root, 60_000), undefined);
	assert.equal(store.takeChatReveal(other, 60_000), 'other');
	assert.equal(store.chat('ep1')?.computer_state, 'none');
	assert.throws(() => store.requestChatReveal('missing'), /no associated project/);
	const token = store.requestChatReveal('main'); store.clearChatReveal(token);
	assert.equal(second.takeChatReveal(root, 60_000), undefined, 'failed opening leaves no deferred switch');
	store.close(); second.close();
});


test('named Chat requests expire, reject clock reversal and cannot be erased by a failed earlier open', () => {
	const { root, store } = fixture();
	associateProject(store, 'main', root);
	associateProject(store, 'ep1', root);
	let now = 1000;
	const timed = new Store(':memory:', () => now);
	for (const c of store.chats().filter(c => c.folder)) {
		timed.insertChat(c); associateProject(timed, c.key, root);
	}
	const earlier = timed.requestChatReveal('main');
	timed.requestChatReveal('ep1'); timed.requestChatReveal('main');
	timed.clearChatReveal(earlier);
	assert.equal(timed.takeChatReveal(root, 60_000), 'main', 'last click wins even in the same millisecond and when repeated');
	timed.requestChatReveal('main'); now += 60_001;
	assert.equal(timed.takeChatReveal(root, 60_000), undefined);
	timed.requestChatReveal('main'); now--;
	assert.equal(timed.takeChatReveal(root, 60_000), undefined);
	timed.close(); store.close();
});
