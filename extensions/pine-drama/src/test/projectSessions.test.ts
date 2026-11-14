import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerOf, projectSessions, sessionProjectRoot } from '../core/projectSessions';
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
	for (const key of ['main', 'ep1', 'other']) { store.insertChat({ key, env: 'test', endpoint: 'https://pine.test', label: 'Work', secret_ref: key }); }
	return { dir, root, other, store };
}

for (const existing of [false, true]) {
	test(`first Project Chat send survives synchronous UI refresh${existing ? ' after an interrupted unbound insertion' : ''}`, async () => {
		const { dir, root, store } = fixture();
		const key = projectSessions(root, store.chats()).mainKey;
		if (existing) { store.insertChat({ key, env: 'offline', endpoint: 'http://pine.test', label: 'First send', secret_ref: 'offline' }); }
		const pine = new FakePine(); pine.plans = [{ state: 'completed' }];
		const seen: string[] = [];
		let unboundNotifications = 0;
		const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(),
			pine: { endpoint: 'http://pine.test', apiKey: 'offline' },
			files: { libraryRoot: join(dir, 'library'), projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir),
			onChange: () => {
				// The real extension refreshes scoped Sessions synchronously on every service notification.
				assert.equal(projectSessions(root, store.chats()).mainKey, key);
				const current = store.chat(key);
				if (current?.folder) { assert.equal(current.folder, root); seen.push(current.folder); }
				else if (current) { unboundNotifications++; }
			},
		});
		const script = join(dir, 'script.txt'); writeFileSync(script, 'OFFLINE screenplay');
		try {
			assert.doesNotThrow(() => projectSessions(root, store.chats()));
			for await (const _update of service.submitWithFiles(key, 'Read the script', 'First send', [{ kind: 'file', path: script }], root)) { /* drain fake transport */ }
			assert(seen.length > 0); assert.equal(store.chat(key)!.project_role, 'main');
			if (!existing) { assert.equal(unboundNotifications, 0, 'new-row notification follows folder admission'); }
			assert.equal(store.projectChat(root)?.key, key); assert.equal(pine.calls.run, 1);
		} finally { store.close(); }
	});
}

test('an unbound reserved entry is not project history, but an entry bound elsewhere remains a conflict', () => {
	const { root, other, store } = fixture();
	const key = projectSessions(root, store.chats()).mainKey;
	store.insertChat({ key, env: 'offline', endpoint: 'http://pine.test', label: 'Pending', secret_ref: 'offline' });
	try {
		const scope = projectSessions(root, store.chats());
		assert.equal(scope.mainKey, key); assert.equal(scope.main, undefined); assert.deepEqual(scope.chats, []);
		associateProject(store, key, other, { kind: 'main' });
		assert.throws(() => projectSessions(root, store.chats()), /belongs to another/);
	} finally { store.close(); }
});

test('empty/multiple-folder windows have no project session scope', () => {
	assert.equal(sessionProjectRoot([]), undefined);
	assert.equal(sessionProjectRoot(['/one', '/two']), undefined);
});

test('a default main entry is deterministic and creates no Store row, runtime or execution grant', () => {
	const { dir, root, store } = fixture();
	const alias = join(dir, 'alias'); symlinkSync(root, alias);
	const a = projectSessions(sessionProjectRoot([root])!, store.chats());
	const b = projectSessions(sessionProjectRoot([alias])!, store.chats());
	assert.equal(a.mainKey, b.mainKey);
	assert.equal(a.main, undefined);
	assert.deepEqual(a.chats, []);
	assert.equal(store.chat(a.mainKey), undefined);
	store.close();
});

test('Generate asks the session that owns the item: its episode\'s one session, else the Project Chat', () => {
	const { dir, root, other, store } = fixture();
	const before = projectSessions(sessionProjectRoot([root])!, store.chats());
	associateProject(store, 'main', root, { kind: 'main' });
	const after = projectSessions(sessionProjectRoot([root])!, store.chats());
	const ep6 = ownerOf(after, 'episodes/EP006');
	// B6: the seg editor's and the canvas's Generate on the episode's items ask its one session; asking again, sent or
	// not, in this window or another, before the Project Chat exists as after, opens the same one.
	for (const id of ['episodes/EP006', 'episodes/EP006/seg01', 'episodes/EP006/seg01/shot01/keyframe']) {
		assert.equal(ownerOf(after, id), ep6, id);
		assert.equal(ownerOf(before, id), ep6, `${id} before the Project Chat`);
	}
	const alias = join(dir, 'alias'); symlinkSync(root, alias);
	assert.equal(ownerOf(projectSessions(sessionProjectRoot([alias])!, store.chats()), 'episodes/EP006'), ep6, 'another window of the project');
	// Another episode, the Project Chat and another project's EP006 are other sessions.
	assert.equal(new Set([ep6, ownerOf(after, 'episodes/EP007/seg01'), after.mainKey, ownerOf(projectSessions(sessionProjectRoot([other])!, store.chats()), 'episodes/EP006')]).size, 4);
	// B6, case 3: a shared item asks the Project Chat.
	assert.equal(ownerOf(after, 'assets/characters/mia'), 'main');
	assert.equal(ownerOf(before, 'assets/characters/mia'), before.mainKey);
	store.close();
});

test('scope filters exact canonical project identity and never transfers other histories', () => {
	const { root, other, store } = fixture();
	associateProject(store, 'main', root, { kind: 'main' });
	associateProject(store, 'ep1', root, null);
	associateProject(store, 'other', other, { kind: 'main' });
	const scope = projectSessions(root, store.chats());
	assert.equal(scope.mainKey, 'main');
	assert.deepEqual(scope.chats.map(c => c.key).sort(), ['ep1', 'main']);
	assert.equal(projectSessions(other, store.chats()).mainKey, 'other');
	assert.equal(store.chats().length, 3);
	assert.equal(store.chat('main')?.computer_state, 'none', 'reading the scope starts nothing');
	store.close();
});

test('refresh preserves the pinned root through alias retargeting and local folder loss', () => {
	const { dir, root, other, store } = fixture();
	const alias = join(dir, 'alias'); symlinkSync(root, alias);
	associateProject(store, 'main', root, { kind: 'main' });
	associateProject(store, 'other', other, { kind: 'main' });
	const pinned = sessionProjectRoot([alias])!;
	unlinkSync(alias); symlinkSync(other, alias);
	assert.equal(projectSessions(pinned, store.chats()).mainKey, 'main');
	assert.equal(sessionProjectRoot([alias]), other, 'only explicit entry retargets the alias');
	unlinkSync(alias); symlinkSync(root, alias);
	renameSync(root, root + '-moved');
	assert.equal(projectSessions(pinned, store.chats()).mainKey, 'main', 'saved history stays readable');
	assert.throws(() => sessionProjectRoot([alias]), /missing|ENOENT/, 'explicit re-entry validates the root');
	store.close();
});

test('missing primary metadata does not make the oldest session the Project Chat; labels name the role once', () => {
	const { root, store } = fixture();
	associateProject(store, 'ep1', root, null);
	const scope = projectSessions(root, store.chats());
	assert.notEqual(scope.mainKey, 'ep1');
	assert.equal(scope.main, undefined);
	associateProject(store, 'main', root, { kind: 'main' });
	assert.equal(projectSessions(root, store.chats()).mainKey, 'main');
	store.close();
});


test('named Chat reveal is project-qualified, single-consumer and starts nothing', () => {
	const { root, other, store, dir } = fixture();
	associateProject(store, 'main', root, { kind: 'main' });
	associateProject(store, 'ep1', root, null);
	associateProject(store, 'other', other, { kind: 'main' });
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
	associateProject(store, 'main', root, { kind: 'main' });
	associateProject(store, 'ep1', root, null);
	let now = 1000;
	const timed = new Store(':memory:', () => now);
	for (const c of store.chats().filter(c => c.folder)) {
		timed.insertChat(c); associateProject(timed, c.key, root, c.project_role === 'main' ? { kind: 'main' } : null);
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
