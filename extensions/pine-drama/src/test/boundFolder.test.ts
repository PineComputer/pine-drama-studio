import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store';

// One drama, one folder: a session is bound to the
// drama's folder and its mirror is that folder's drama/. Fixture folders only.


// Every schema but this one takes the same path (store.ts, Store): one older schema stands for them all.
test('a database of an older schema is set aside byte for byte, never migrated, and a fresh one opens', () => {
	const version = 11;
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
	assert.equal((store.db.prepare('pragma user_version').get() as { user_version: number }).user_version, 19, 'a fresh database at this schema');
	store.close();
	const after = new DatabaseSync(`${path}.schema${version}-20261105T231500Z`);
	assert.equal((after.prepare('pragma user_version').get() as { user_version: number }).user_version, version);
	assert.equal(after.prepare("select count(*) n from sqlite_master where name = 'mirror_files'").get()!.n, 0);
	after.close();
});

