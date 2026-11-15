// S1: local Chat identity: a project's Chats are peers, each bound to it by its first send.
// Temporary projects only; no project generation, credentials or network.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Store } from '../core/store';
import { entryFor } from '../core/binding';
import { projectIdentity, projectRootOf } from '../core/projectPlace';
import { projectSessions } from '../core/projectSessions';
import { associateProject } from './storeFixture';

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-project-chats-')));
	const root = join(dir, 'North Harbor'); mkdirSync(root);
	const path = join(dir, 'studio.sqlite');
	const store = new Store(path);
	for (const key of ['main', 'ep1', 'ep2', 'history', 'other']) {
		store.insertChat({ key, endpoint: 'https://pine.test', label: 'same label', secret_ref: key });
	}
	return { dir, root, path, store };
}

test('one canonical project has any number of peer Chats; each works in it, a Chat outside it does not (D48)', () => {
	const { dir, root, store } = fixture();
	assert.equal(store.bindFolder('main', root), true);
	writeFileSync(join(root, 'pine-drama-project.json'), '{"schema":2}\n');
	const alias = join(dir, 'alias'); symlinkSync(root, alias);
	associateProject(store, 'ep1', alias);
	associateProject(store, 'ep2', root);
	assert.deepEqual(projectSessions(projectIdentity(alias), store.chats()).chats.map(c => c.key).sort(), ['ep1', 'ep2', 'main']);
	assert.equal(store.chat('ep1')?.computer_id, null, 'association starts no runtime');
	assert.equal(readFileSync(join(root, 'pine-drama-project.json'), 'utf8'), '{"schema":2}\n');
	assert.deepEqual(entryFor(store.chats(), dir, 'ep1', alias), { kind: 'go', bind: false }, 'a Chat works in its project');
	assert.deepEqual(entryFor(store.chats().reverse(), dir, 'main', root), { kind: 'go', bind: false });
	assert.deepEqual(entryFor(store.chats(), dir, 'history', root), { kind: 'go', bind: true }, 'a Chat of no project joins it on its first send');
	store.close();
});

test('a drama made or converted before any Chat is joined by whichever Chat sends first, as a peer of every later one', () => {
	const { root, store } = fixture();
	writeFileSync(join(root, 'pine-drama-project.json'), '{"schema":2}\n');
	assert.deepEqual(entryFor(store.chats(), '', 'ep1', root), { kind: 'go', bind: true });
	assert.equal(store.bindFolder('ep1', root), true);
	assert.deepEqual(entryFor(store.chats(), '', 'ep2', root), { kind: 'go', bind: true });
	assert.equal(store.bindFolder('ep2', root), true);
	assert.deepEqual(projectSessions(projectIdentity(root), store.chats()).chats.map(c => c.key).sort(), ['ep1', 'ep2']);
	store.close();
});

test('a binding persists through reopen, and no ordinary update moves a Chat to another project', () => {
	const { root, path, store } = fixture();
	associateProject(store, 'ep1', root);
	// Deliberately untyped JSON verifies the runtime boundary as well as the TypeScript patch type.
	assert.throws(() => store.updateChat('ep1', JSON.parse('{"folder":"/another"}')), /first send/);
	store.updateChat('ep1', { computer_id: 'retained-computer', computer_state: 'stopped', pine_session_state: 'ended' });
	store.close();
	const reopened = new Store(path);
	assert.equal(reopened.chat('ep1')?.folder, root);
	assert.equal(reopened.chat('ep1')?.computer_state, 'stopped');
	reopened.close();
});

// Codex on the first head: counting an unbound Chat's storage folder as an association let a send there skip bindFolder,
// and so its execution-history refusal.
test('an unbound Chat\'s storage folder is no binding: a send there still goes through bindFolder', () => {
	const { dir, store } = fixture();
	const fallback = projectRootOf(dir, store.chat('history')!); mkdirSync(fallback, { recursive: true });
	const entry = entryFor(store.chats(), dir, 'history', fallback);
	assert.deepEqual([entry.kind, entry.kind === 'go' && entry.bind], ['go', true]);
	store.close();
});
