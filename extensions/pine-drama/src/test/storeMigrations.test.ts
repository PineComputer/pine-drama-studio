import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, newerStoreMessage, setAsideNotice, Store } from '../core/store';

// The Chat store migrates in place (store.ts MIGRATIONS, after Code-OSS's sessionDatabase.ts): its steps run once, in
// one transaction; a store older than the first step is copied aside and replaced; a newer one is refused, unchanged.

const LATEST = MIGRATIONS.at(-1)!.version;
const place = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'pine-store-'))), 'studio.sqlite');
const versionOf = (db: DatabaseSync) => (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
const tableCount = (db: DatabaseSync, name: string) => (db.prepare('select count(*) n from sqlite_master where name = ?').get(name) as { n: number }).n;
const asides = (path: string) => readdirSync(join(path, '..')).filter(f => f.includes('.schema'));

for (const mode of ['delete', 'wal'] as const) {
	test(`a store a newer Studio wrote (${mode} journal) is refused, and its schema, rows and journal mode stay as they were`, () => {
		const path = place();
		const old = new DatabaseSync(path);
		old.exec(`pragma journal_mode = ${mode}; create table t (x); insert into t values (1); pragma user_version = ${LATEST + 1}`);
		// A WAL store with a second connection keeps its rows in the WAL, not yet in the main file.
		const held = mode === 'wal' ? new DatabaseSync(path) : undefined;
		held?.prepare('select count(*) n from t').get();
		old.close();
		assert.throws(() => new Store(path), { message: newerStoreMessage(LATEST + 1, LATEST) });
		const after = held ?? new DatabaseSync(path);
		assert.equal(versionOf(after), LATEST + 1);
		assert.equal((after.prepare('pragma journal_mode').get() as { journal_mode: string }).journal_mode, mode);
		assert.equal((after.prepare('select count(*) n from t').get() as { n: number }).n, 1);
		assert.equal(tableCount(after, 'chats'), 0, 'no step ran');
		after.close();
		assert.deepEqual(asides(path), []);
	});
}

test('a step that fails rolls back every step before it: the version, the tables and the rows stay as they were', () => {
	const path = place();
	const store = new Store(path);
	store.insertChat({ key: 'k', endpoint: 'https://pine.test', label: 'before', secret_ref: 'k' });
	store.close();
	const steps = [...MIGRATIONS,
		{ version: LATEST + 1, sql: "create table probe (x); update chats set label = 'after'" },
		{ version: LATEST + 2, sql: 'select * from no_such_table' }];
	assert.throws(() => new Store(path, Date.now, steps), /no such table/);
	const after = new DatabaseSync(path);
	assert.equal(versionOf(after), LATEST);
	assert.equal(tableCount(after, 'probe'), 0);
	assert.equal((after.prepare('select label from chats').get() as { label: string }).label, 'before');
	after.close();
	const again = new Store(path);
	assert.equal(again.chat('k')?.label, 'before');
	again.close();
});

// Schemas before the first step (the released v0.2.x stores are at 16) are not migrated: the file is copied aside, then
// replaced in place, and the person is told where the copy went, once.
for (const schema of [2, 11]) {
	test(`a store at schema ${schema}, older than the first step, is copied aside once and replaced in place, and the person is told where`, () => {
		const path = place();
		const old = new DatabaseSync(path);
		old.exec(`pragma journal_mode = wal; create table conversations (key text primary key); insert into conversations values ('old'); pragma user_version = ${schema}`);
		// A second connection keeps the -wal, as a running older Studio would: the copy still holds its rows.
		const held = new DatabaseSync(path);
		held.prepare('select count(*) n from conversations').get();
		old.close();
		const store = new Store(path, () => Date.parse('2026-11-05T23:15:00Z'));
		const aside = `${path}.schema${schema}-20261105T231500Z`;
		assert.deepEqual(store.setAside, { schema, path: aside });
		assert.equal(setAsideNotice(store.setAside!), `Chat history from an older version of Pine Drama Studio was moved to ${aside}; your work is in your project folder.`);
		assert.equal(versionOf(store.db), LATEST);
		assert.equal(tableCount(store.db, 'conversations'), 0, 'the old tables are gone from the store');
		store.insertChat({ key: 'k', endpoint: 'https://pine.test', label: 'k', secret_ref: 'k' });
		store.close();
		held.close();
		const copy = new DatabaseSync(aside);
		assert.equal(versionOf(copy), schema);
		assert.deepEqual(copy.prepare('select key from conversations').all().map(r => (r as { key: string }).key), ['old']);
		copy.close();
		// The second start finds the latest schema: nothing is copied again.
		const again = new Store(path, () => Date.parse('2026-11-06T08:00:00Z'));
		assert.equal(again.setAside, undefined);
		assert.equal(again.chats().length, 1);
		again.close();
		assert.deepEqual(asides(path), [`studio.sqlite.schema${schema}-20261105T231500Z`]);
	});
}

/** A real process that opens a Store with one more step than MIGRATIONS; it says `ready` just before it asks for the write lock. */
function opener(path: string): { child: ChildProcess; result: Promise<string> } {
	const module = join(__dirname, '..', 'core', 'store.js');
	const script = `const { DatabaseSync } = require('node:sqlite');
const { writeSync } = require('node:fs');
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) { if (sql === 'begin immediate') { writeSync(1, 'ready\\n'); } return exec.call(this, sql); };
const { MIGRATIONS, Store } = require(${JSON.stringify(module)});
const store = new Store(${JSON.stringify(path)}, Date.now, [...MIGRATIONS, { version: ${LATEST + 1}, sql: 'create table probe (x)' }]);
writeSync(1, 'opened ' + store.db.prepare('pragma user_version').get().user_version + '\\n');
store.close();`;
	const child = spawn(process.execPath, ['--no-warnings', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
	let out = ''; let err = '';
	child.stdout!.on('data', chunk => { out += chunk; });
	child.stderr!.on('data', chunk => { err += chunk; });
	// 'close', not 'exit': its output may still be draining when it exits (https://nodejs.org/api/child_process.html#event-close).
	const result = new Promise<string>(resolve => child.once('close', code => resolve(`${code}|${out.trim()}|${err.trim()}`)));
	return { child, result };
}

async function readied(child: ChildProcess): Promise<void> {
	let out = '';
	await new Promise<void>((resolve, reject) => {
		child.stdout!.on('data', chunk => { out += chunk; if (out.includes('ready\n')) { resolve(); } });
		child.once('exit', code => reject(new Error(`the opener exited ${code} before it asked for the lock`)));
	});
}

// Several windows start at once. Each read the file's version before any of them could migrate; under the write lock
// the second finds the step already run, so it runs once (its `create table probe` would fail a second time).
for (const start of ['current', 'fresh', 'schema 11'] as const) {
	test(`two processes opening a ${start} store at once both open it, and its pending step runs once`, async () => {
		const path = place();
		if (start !== 'fresh') {
			const made = start === 'current' ? new Store(path) : undefined;
			made?.close();
			if (start === 'schema 11') {
				const old = new DatabaseSync(path);
				old.exec('pragma journal_mode = wal; create table conversations (key text primary key); pragma user_version = 11');
				old.close();
			}
		}
		const lock = new DatabaseSync(path);
		lock.exec('begin immediate');
		const openers = [opener(path), opener(path)];
		try {
			// Both are past their version read and wait on the lock before it is released.
			await Promise.all(openers.map(o => readied(o.child)));
			lock.exec('rollback');
			lock.close();
			const results = await Promise.all(openers.map(o => o.result));
			for (const result of results) { assert.equal(result, `0|ready\nopened ${LATEST + 1}|`); }
			const after = new DatabaseSync(path);
			assert.equal(versionOf(after), LATEST + 1);
			assert.equal(tableCount(after, 'probe'), 1);
			after.close();
			assert.equal(asides(path).length, start === 'schema 11' ? 1 : 0, 'one copy, by the lock holder');
		} finally {
			for (const o of openers) { o.child.kill(); }
			if (lock.isOpen) { lock.close(); }
		}
	});
}
