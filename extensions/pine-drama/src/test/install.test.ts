// Installing a return (doc/protocol.md, 4.4) and putting a task on a Computer: one test per rule that can lose or
// corrupt the person's drama. System tar makes the archives, as the Computer side does.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readChoices, updateChoices } from '../core/choices';
import type { Request, Return } from '../core/protocol';
import { installReturn, InvalidReturn, previewProgress } from '../core/resultImporter';
import { fileKey, Holders, putAll, sha256, stateKey, versionKey, type ArtifactStore } from '../core/taskArtifacts';
import { dramaRecordOf, previewVersions, requestKeys, requestOf, taskMessage } from '../core/taskRun';

const temp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `pds-install-${name}-`)));

/** A Computer's artifact store in memory. */
function memoryStore(): ArtifactStore & { files: Map<string, Buffer>; reads: string[] } {
	const files = new Map<string, Buffer>();
	const reads: string[] = [];
	return {
		files, reads,
		list: async prefix => [...files].filter(([k]) => k.startsWith(prefix)).map(([path, bytes]) => ({ path, size: bytes.length })),
		upload: async (path, bytes) => void files.set(path, Buffer.from(bytes)),
		read: async path => { reads.push(path); return files.get(path); },
		copy: async () => { throw new Error('no copy in this store'); },
	};
}

/** Archives a version folder's files as the Computer side does, and puts the archive in `store`; returns its hash. */
function archive(store: ArtifactStore & { files: Map<string, Buffer> }, files: Record<string, string>, extra?: (dir: string) => void): string {
	const dir = temp('version');
	for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
	extra?.(dir);
	const tar = `${dir}.tar`;
	execFileSync('tar', ['-cf', tar, '-C', dir, '.']);
	const bytes = readFileSync(tar);
	store.files.set(versionKey(sha256(bytes)), bytes);
	return sha256(bytes);
}

const version = (inputs: { object: string; version: string }[] = []) => JSON.stringify({ schema: 1, made_at: '2026-11-12T10:00:00Z', file: 'image-1.png', inputs, prompt: null, from_choice: null });

/** A drama folder, its record, a store, and a sent request of `scope`. */
async function drama(scope: 'project' | 'episodes' = 'project') {
	const root = temp('drama');
	const storage = temp('storage');
	const record = dramaRecordOf(storage, root);
	const store = memoryStore();
	const send = async (task: string, at: string) => {
		const request: Request = requestOf(root, record, task, scope, 'chat-1', await readChoices(root), []);
		await record.sentRequest(request, 'computer-1', 'chat-1', new Date(at));
		return request;
	};
	const install = (request: Request, ret: Omit<Return, 'schema' | 'turn' | 'state'>) =>
		installReturn({ root, record, kept: join(storage, 'kept'), store, request, ret: { schema: 1, turn: request.turn, state: 'ended', ...ret } });
	return { root, storage, record, store, send, install };
}

test('a return installs whole: its version folders and reviews land, and the next request names them', async () => {
	const d = await drama();
	const hash = archive(d.store, { 'version.json': version(), 'image-1.png': 'lin' });
	const review = Buffer.from('{"schema":1,"accepted_at":"2026-11-12T10:00:00Z","reason":"ok"}');
	d.store.files.set(fileKey(sha256(review)), review);
	const state = Buffer.from('state'); d.store.files.set(stateKey(sha256(state)), state);
	const request = await d.send('task-0001', '2026-11-12T10:00:00Z');
	await d.install(request, { versions: { 'assets/characters/lin/v1': hash }, reviews: { 'assets/characters/lin/v1/reviews/r1.json': sha256(review) }, private_state: sha256(state) });
	assert.equal(readFileSync(join(d.root, 'assets/characters/lin/v1/image-1.png'), 'utf8'), 'lin');
	assert.deepEqual(readFileSync(join(d.root, 'assets/characters/lin/v1/reviews/r1.json')), review);
	assert.deepEqual(readdirSync(join(d.root, 'assets/characters/lin')).filter(n => n.startsWith('.')), [], 'no temporary sibling is left');
	const next = requestOf(d.root, d.record, 'task-0002', 'project', 'chat-1', null, []);
	assert.deepEqual(next.versions, { 'assets/characters/lin/v1': hash });
	assert.deepEqual(next.reviews, { 'assets/characters/lin/v1/reviews/r1.json': sha256(review) });
	assert.equal(next.private_state, sha256(state));
	assert.deepEqual(requestKeys(next).sort(), [fileKey(sha256(review)), stateKey(sha256(state)), versionKey(hash)].sort());
});

test('any bad part refuses the whole return before the first rename: nothing of it is in the folder', async () => {
	const cases: [string, (d: Awaited<ReturnType<typeof drama>>) => Omit<Return, 'schema' | 'turn' | 'state'>][] = [
		['a folder of another scope', d => ({ versions: { 'episodes/EP001/breakdown/v1': archive(d.store, { 'version.json': version() }) } })],
		['an archive with a link', d => ({ versions: { 'assets/props/a/v1': archive(d.store, { 'version.json': version() }, dir => symlinkSync('/etc/passwd', join(dir, 'link'))) } })],
		['an archive with a hard link', d => ({ versions: { 'assets/props/a/v1': archive(d.store, { 'version.json': version() }, dir => linkSync(join(dir, 'version.json'), join(dir, 'twin'))) } })],
		['an archive whose bytes do not match its hash', d => { const hash = archive(d.store, { 'version.json': version() }); d.store.files.set(versionKey(hash), Buffer.from('other')); return { versions: { 'assets/props/a/v1': hash } }; }],
		['a review file missing from the store', () => ({ reviews: { 'assets/props/a/v0/reviews/r.json': sha256('absent') } })],
	];
	for (const [what, ret] of cases) {
		const d = await drama();
		const good = archive(d.store, { 'version.json': version(), 'image-1.png': 'good' });
		const request = await d.send('task-0001', '2026-11-12T10:00:00Z');
		const bad = ret(d);
		await assert.rejects(d.install(request, { ...bad, versions: { 'assets/props/good/v1': good, ...bad.versions } }), what);
		assert.equal(existsSync(join(d.root, 'assets/props/good')) && readdirSync(join(d.root, 'assets/props/good')).some(n => !n.startsWith('.')), false, `${what}: the good folder is not installed`);
		assert.equal(existsSync(join(d.root, 'assets/props/a/v1')), false, what);
		assert.equal(d.record.handled('task-0001'), false, `${what}: the return is not recorded`);
	}
});

test('a folder that exists with another archive refuses the return; the same archive again is skipped', async () => {
	const d = await drama();
	const first = archive(d.store, { 'version.json': version(), 'image-1.png': 'first' });
	await d.install(await d.send('task-0001', '2026-11-12T10:00:00Z'), { versions: { 'assets/props/a/v1': first } });
	const other = archive(d.store, { 'version.json': version(), 'image-1.png': 'other' });
	await assert.rejects(d.install(await d.send('task-0002', '2026-11-12T10:01:00Z'), { versions: { 'assets/props/a/v1': other } }),
		(error: Error) => error instanceof InvalidReturn && /another session made assets\/props\/a\/v1 while this task ran[^]*run this work again/.test(error.message));
	assert.equal(readFileSync(join(d.root, 'assets/props/a/v1/image-1.png'), 'utf8'), 'first', 'the installed version is never replaced');
	await d.install(await d.send('task-0003', '2026-11-12T10:02:00Z'), { versions: { 'assets/props/a/v1': first } });
});

test('two clashing returns installed at once: the first lands whole, the second installs nothing', async () => {
	const d = await drama();
	const first = archive(d.store, { 'version.json': version(), 'image-1.png': 'first' });
	const second = archive(d.store, { 'version.json': version(), 'image-1.png': 'second' });
	const other = archive(d.store, { 'version.json': version(), 'image-1.png': 'other' });
	const a = await d.send('task-0001', '2026-11-12T10:00:00Z');
	const b = await d.send('task-0002', '2026-11-12T10:00:01Z');
	const [ra, rb] = await Promise.allSettled([
		d.install(a, { versions: { 'assets/props/a/v1': first } }),
		d.install(b, { versions: { 'assets/props/b/v1': other, 'assets/props/a/v1': second } }),
	]);
	assert.equal(ra.status, 'fulfilled');
	assert.equal(rb.status, 'rejected');
	assert.equal(readFileSync(join(d.root, 'assets/props/a/v1/image-1.png'), 'utf8'), 'first');
	assert.equal(existsSync(join(d.root, 'assets/props/b/v1')), false, 'nothing of the second return is installed');
});

test('an install cut off between its record and its renames finishes when run again', async () => {
	const d = await drama();
	const a = archive(d.store, { 'version.json': version(), 'image-1.png': 'a' });
	const b = archive(d.store, { 'version.json': version(), 'image-1.png': 'b' });
	const request = await d.send('task-0001', '2026-11-12T10:00:00Z');
	const ret = { versions: { 'assets/props/a/v1': a, 'assets/props/b/v1': b } };
	await d.install(request, ret);
	// The crash window: the return recorded and one folder renamed, the other not.
	execFileSync('rm', ['-rf', join(d.root, 'assets/props/b/v1')]);
	await d.install(request, ret);
	assert.equal(readFileSync(join(d.root, 'assets/props/a/v1/image-1.png'), 'utf8'), 'a');
	assert.equal(readFileSync(join(d.root, 'assets/props/b/v1/image-1.png'), 'utf8'), 'b');
});

test('an older return installed late never replaces a later task\'s private state', async () => {
	const d = await drama();
	const older = await d.send('task-0001', '2026-11-12T10:00:00Z');
	const newer = await d.send('task-0002', '2026-11-12T10:05:00Z');
	const state = (text: string) => { const bytes = Buffer.from(text); d.store.files.set(stateKey(sha256(bytes)), bytes); return sha256(bytes); };
	await d.install(newer, { private_state: state('newer') });
	await d.install(older, { private_state: state('older') });
	assert.equal(d.record.latest('chat-1')!.private_state, sha256('newer'));
});

test('a version made from a version the person deleted during the task is installed and marked deleted, with what was made from it', async () => {
	const d = await drama();
	const request = await d.send('task-0001', '2026-11-12T10:00:00Z');
	await updateChoices(d.root, c => ({ ...c, objects: { 'assets/props/a': { discarded: ['v1'] } } }));
	const b = archive(d.store, { 'version.json': version([{ object: 'assets/props/a', version: 'v1' }]) });
	const c = archive(d.store, { 'version.json': version([{ object: 'assets/props/b', version: 'v1' }]) });
	const e = archive(d.store, { 'version.json': version() });
	await d.install(request, { versions: { 'assets/props/b/v1': b, 'assets/props/c/v1': c, 'assets/props/e/v1': e } });
	const choices = (await readChoices(d.root))!;
	assert.deepEqual(choices.objects['assets/props/b']?.discarded, ['v1']);
	assert.deepEqual(choices.objects['assets/props/c']?.discarded, ['v1']);
	assert.equal(choices.objects['assets/props/e'], undefined);
	assert.ok(existsSync(join(d.root, 'assets/props/b/v1/version.json')), 'its folder stays, so numbering stays intact');
});

test('before a task, a key the store lacks is copied from the Computer remembered holding it, else uploaded; a failed copy uploads', async () => {
	const holders = new Holders(temp('holders'));
	const target = memoryStore();
	target.files.set('versions/a.tar', Buffer.from('a'));
	const copies: string[] = [];
	target.copy = async (from, path) => { copies.push(`${from}:${path}`); if (from === 'gone') { throw new Error('no such Computer'); } target.files.set(path, Buffer.from('copied')); };
	await holders.set(['b'], 'computer-2');
	await holders.set(['d'], 'gone');
	const uploaded: string[] = [];
	const put = await putAll(target, 'computer-1', holders, ['versions/a.tar', 'versions/b.tar', 'files/c', 'files/d', 'files/c'], key => { uploaded.push(key); return Buffer.from('up'); }, key => key === 'versions/a.tar' ? 1 : 6);
	assert.deepEqual(put, { copied: 1, uploaded: 2 });
	assert.deepEqual(copies, ['computer-2:versions/b.tar', 'gone:files/d']);
	assert.deepEqual(uploaded, ['files/c', 'files/d'], 'nothing remembered, or the copy failed: uploaded from the Studio\'s copy');
	assert.deepEqual(['a', 'b', 'c', 'd'].map(h => holders.get(h)), ['computer-1', 'computer-1', 'computer-1', 'computer-1'], 'the listing and each put remember the target');
});

test('a task message names its task on the first line, the person\'s words after', () => {
	assert.equal(taskMessage('task-0001', 'make the poster'), 'pine-drama-turn task-0001\nmake the poster');
});

test('a return\'s problems are kept in its record, installed or refused, and every request is listed in the order sent', async () => {
	const d = await drama();
	const problems = [{ ref: 'imp-0001-office', error: { code: 'invalid' as const, message: 'not a picture' } }];
	const first = await d.send('task-0002', '2026-11-12T10:00:00Z');
	await d.send('task-0001', '2026-11-12T10:01:00Z');
	await d.install(first, { problems });
	await d.record.handle('task-0001', problems);
	assert.deepEqual(d.record.returns().map(r => r.problems), [problems, problems]);
	assert.deepEqual(d.record.requests().map(r => r.request.turn), ['task-0002', 'task-0001']);
});

test('a version announced while its task runs is previewed from the record, then installed from the same archive without a second download', async () => {
	const d = await drama();
	const hash = archive(d.store, { 'version.json': version(), 'image-1.png': 'lin' });
	const request = await d.send('task-0001', '2026-11-12T10:00:00Z');
	d.store.files.set(`turns/task-0001/progress/${hash}.json`, Buffer.from(JSON.stringify({ schema: 1, object: 'assets/characters/lin', version: 'v1', file: 'image-1.png' })));
	assert.equal(await previewProgress({ record: d.record, kept: join(d.storage, 'kept'), store: d.store, task: 'task-0001' }), 1);
	assert.equal(await previewProgress({ record: d.record, kept: join(d.storage, 'kept'), store: d.store, task: 'task-0001' }), 0, 'once');
	const [preview] = previewVersions(d.storage, d.root);
	assert.deepEqual([preview.object, preview.version, preview.task], ['assets/characters/lin', 'v1', 'task-0001']);
	assert.equal(readFileSync(join(preview.dir, 'image-1.png'), 'utf8'), 'lin');
	assert.equal(existsSync(join(d.root, 'assets')), false, 'nothing reaches the folder before the return');
	d.store.reads.length = 0;
	await d.install(request, { versions: { 'assets/characters/lin/v1': hash } });
	assert.deepEqual(d.store.reads.filter(r => r.startsWith('versions/')), [], 'the archive came from the kept copy');
	assert.deepEqual(previewVersions(d.storage, d.root), [], 'the preview ends with the install');
	assert.equal(existsSync(preview.dir), false);
});

test('before a task, a file the store holds cut short is put again', async () => {
	const holders = new Holders(temp('holders'));
	const target = memoryStore();
	target.files.set('versions/a.tar', Buffer.from('par'));
	const put = await putAll(target, 'computer-1', holders, ['versions/a.tar'], () => Buffer.from('partial'), () => 7);
	assert.deepEqual(put, { copied: 0, uploaded: 1 });
	assert.deepEqual(target.files.get('versions/a.tar'), Buffer.from('partial'));
});
