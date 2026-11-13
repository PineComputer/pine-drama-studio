// S1: local Chat identity: one Project Chat per project and its peer sessions, which work in it once it has one.
// Temporary projects and FakePine only; no project generation, credentials or network.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Store } from '../core/store';
import { entryFor } from '../core/binding';
import { owningChat } from '../core/projectPlace';
import { ChatService } from '../core/chats';
import { FakePine, MemoryVault } from './fakePine';
import { associateProject } from './storeFixture';

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-project-chats-')));
	const root = join(dir, 'North Harbor'); mkdirSync(root);
	const path = join(dir, 'studio.sqlite');
	const store = new Store(path);
	for (const key of ['main', 'ep1', 'ep2', 'history', 'other']) {
		store.insertChat({ key, env: 'pine', endpoint: 'https://pine.test', label: 'same label', secret_ref: key });
	}
	return { dir, root, path, store };
}

test('one canonical project has its Project Chat and peer sessions; each session works in it, a Chat outside it does not (D48)', () => {
	const { dir, root, store } = fixture();
	assert.equal(store.bindFolder('main', root), true);
	writeFileSync(join(root, 'choices.json'), 'existing accepted project\n');
	const alias = join(dir, 'alias'); symlinkSync(root, alias);
	associateProject(store, 'ep1', alias, null);
	associateProject(store, 'ep2', root, null);
	assert.equal(store.projectChat(alias)?.key, 'main');
	assert.deepEqual(store.projectChats(alias).map(c => c.key).sort(), ['ep1', 'ep2', 'main']);
	assert.deepEqual(store.projectChats(root).filter(c => c.project_role === 'main').map(c => c.key), ['main']);
	assert.equal(store.chat('ep1')?.computer_id, null, 'association starts no runtime');
	assert.equal(readFileSync(join(root, 'choices.json'), 'utf8'), 'existing accepted project\n');
	assert.deepEqual(entryFor(store.chats(), dir, 'ep1', alias), { kind: 'go', bind: false }, 'a session works in its project');
	assert.deepEqual(entryFor(store.chats().reverse(), dir, 'main', root), { kind: 'go', bind: false });
	assert.deepEqual(entryFor(store.chats(), dir, 'history', root), { kind: 'go', bind: true }, 'a Chat of no project joins it on its first send');
	assert.equal(owningChat(store.chats().reverse(), dir, [alias])?.key, 'main', 'the Project Chat, not row order');
	store.close();
});

test('explicit Project Chat assignments persist and remain idempotent through reopen without runtime or title inference', () => {
	const { root, path, store } = fixture();
	associateProject(store, 'history', root, null);
	assert.equal(store.projectChat(root), undefined, 'oldest row is not a Project Chat');
	assert.deepEqual(entryFor(store.chats(), '', 'history', root), { kind: 'unassigned' }, 'a project without its Project Chat admits nothing');
	assert.equal(owningChat([...store.chats(), { key: 'second', folder: root, project_role: null }], '', [root]), undefined, 'several histories and no Project Chat: no guess');
	associateProject(store, 'ep1', root, null);
	associateProject(store, 'main', root, { kind: 'main' });
	const original = store.chat('main')!;
	assert.deepEqual(associateProject(store, 'main', root, { kind: 'main' }), original);
	assert.equal(owningChat(store.chats(), '', [root])?.key, 'main');
	store.close();
	const reopened = new Store(path);
	assert.equal(reopened.projectChat(root)?.key, 'main');
	assert.equal(reopened.chat('ep1')?.project_role, null);
	assert.equal(reopened.chat('main')?.computer_state, 'none');
	reopened.close();
});

test('database constraints and normal updates cannot disguise another Project Chat as runtime metadata', () => {
	const { root, store } = fixture();
	assert.equal(store.bindFolder('main', root), true);
	associateProject(store, 'ep1', root, null);
	assert.throws(() => store.db.prepare("update chats set project_role = 'main' where key = 'ep1'").run(), /UNIQUE/);
	assert.throws(() => store.db.prepare("update chats set project_role = 'episode' where key = 'ep1'").run(), /CHECK/);
	assert.throws(() => store.db.prepare("update chats set project_role = 'main' where key = 'history'").run(), /CHECK/, 'no Project Chat without a folder');
	// Deliberately untyped JSON verifies the runtime boundary as well as the TypeScript patch type.
	assert.throws(() => store.updateChat('ep1', JSON.parse('{"project_role":"main"}')), /explicit admission/);
	assert.throws(() => store.updateChat('ep1', JSON.parse('{"folder":"/another"}')), /explicit admission/);
	store.updateChat('main', { computer_id: 'retained-computer', computer_state: 'stopped', pine_session_state: 'ended' });
	assert.equal(store.projectChat(root)?.key, 'main', 'Stop is not an implicit project handoff');
	store.close();
});

test('a session of a project that has no Project Chat cannot provision or submit, even without a supplied window folder', async () => {
	const { root, store, dir } = fixture();
	associateProject(store, 'ep1', root, null);
	const pine = new FakePine();
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), log: () => undefined,
		pine: { endpoint: 'https://pine.test', apiKey: 'pk_fixture', controlHost: 'api.pine.test' },
		files: { projectsRoot: join(dir, 'projects'), libraryRoot: join(dir, 'library') } });
	for (const folder of [root, undefined]) {
		const updates = [];
		for await (const update of service.submit('ep1', 'continue EP001', 'episode', folder)) { updates.push(update); }
		assert.ok(updates.some(u => u.kind === 'unsent' && u.text.includes('Not sent:')));
		assert.ok(updates.some(u => u.kind === 'unsent' && u.text.includes('```text\ncontinue EP001\n```')), 'the message is given back (D72)');
		assert.ok(updates.every(u => u.kind !== 'markdown' || !u.text.includes('has ended')), 'no fabricated runtime state');
	}
	for await (const update of service.startNewSession('ep1')) { assert.match(update.kind === 'markdown' ? update.text : '', /not admitted/); }
	assert.deepEqual(pine.calls, {}, 'refusal precedes every Pine call');
	assert.equal(store.chat('ep1')?.computer_state, 'none');
	store.close();
});


test('explicit project authority is enforced even when file transport is not configured', async () => {
	const { root, store } = fixture();
	associateProject(store, 'main', root, null);
	const pine = new FakePine();
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), log: () => undefined,
		pine: { endpoint: 'https://pine.test', apiKey: 'pk_fixture', controlHost: 'api.pine.test' } });
	for await (const update of service.submit('main', 'continue', 'main')) {
		if (update.kind === 'markdown' || update.kind === 'unsent') { assert.doesNotMatch(update.text, /has ended/); }
	}
	for await (const _update of service.submit('other', 'continue in this folder', 'other', root)) { /* drain */ }
	for await (const update of service.startNewSession('main')) {
		assert.match(update.kind === 'markdown' ? update.text : '', /not admitted/);
	}
	assert.deepEqual(pine.calls, {});
	assert.equal(store.chat('main')?.computer_state, 'none');
	store.close();
});
