import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store';
import { projectRootOf } from '../core/projectPlace';

// One drama, one folder: a session is bound to the
// drama's folder and its mirror is that folder's drama/. Fixture folders only.

const conv = (store: Store, key: string) => store.insertChat({ key, env: 'dev', endpoint: 'https://pine.test', label: key, secret_ref: key });

for (const [version, before] of [[7, 'before the mirror'], [8, 'before explicit project Chat roles'], [9, 'before durable admission preparation'], [10, 'before immutable task runtime attribution'], [11, 'before the execution names (doc/glossary.md)']] as const) {
	test(`a schema ${version} database (${before}) is set aside byte for byte, never migrated, and a fresh one opens`, () => {
		// No migration: an older schema's added column and records are not carried over;
		// the old file is renamed aside, not read, rewritten or deleted.
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-bound-')));
		const path = join(dir, 'studio.sqlite');
		const old = new DatabaseSync(path);
		old.exec(`create table conversations (key text primary key, folder text); create table settled_files (rel_path text); pragma user_version = ${version}`);
		old.close();
		const beforeBytes = readFileSync(path);
		const store = new Store(path, () => Date.parse('2026-11-05T23:15:00Z'));
		assert.deepEqual(store.setAside, { schema: version, path: `${path}.schema${version}-20261105T231500Z` });
		assert.deepEqual(readFileSync(store.setAside!.path), beforeBytes, 'even journal settings must not rewrite a set-aside database');
		assert.equal((store.db.prepare('pragma user_version').get() as { user_version: number }).user_version, 16, 'a fresh database at this schema');
		store.close();
		const after = new DatabaseSync(`${path}.schema${version}-20261105T231500Z`);
		assert.equal((after.prepare('pragma user_version').get() as { user_version: number }).user_version, version);
		assert.equal(after.prepare("select count(*) n from sqlite_master where name = 'mirror_files'").get()!.n, 0);
		after.close();
	});
}

test('a session is bound once; a second binding does not move it', () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-bound-')));
	const root = join(dir, 'Night Ward'); mkdirSync(root);
	const store = new Store(join(dir, 'studio.sqlite'));
	conv(store, 'pine-computer:/a');
	assert.equal(store.bindFolder('pine-computer:/a', root), true);
	assert.equal(store.bindFolder('pine-computer:/a', '/elsewhere'), false);
	assert.equal(store.chat('pine-computer:/a')?.folder, root);
});

test("a bound folder is the project root; resolving it never adds a child or writes files", () => {
	const root = mkdtempSync(join(tmpdir(), 'pine-bound-'));
	const scripts = join(root, 'Night Ward');
	mkdirSync(scripts);
	writeFileSync(join(scripts, 'screenplay.docx'), 'the person’s own file');
	assert.equal(projectRootOf('/unused', { key: 'k', folder: scripts }), scripts);
	// A folder that is itself a drama-cli project is refused at binding; the root never is it.
	const existing = join(root, 'double-life');
	mkdirSync(existing);
	writeFileSync(join(existing, 'choices.json'), 'project: x\n');
	assert.equal(projectRootOf('/unused', { key: 'k', folder: existing }), existing);
	assert.deepEqual(readdirSync(scripts), ['screenplay.docx'], 'resolving a root writes nothing');
});
