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
import { archiveNames, installReturn, InvalidReturn, previewProgress } from '../core/resultImporter';
import { fileKey, Holders, putAll, sha256, stateKey, versionKey, type ArtifactStore } from '../core/taskArtifacts';
import { dramaRecordOf, installedSnapshots, previewVersions, requestKeys, requestOf, taskMessage } from '../core/taskRun';

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
	const send = async (task: string, at: string, as: 'project' | 'episodes' = scope) => {
		const request: Request = await requestOf(root, record, join(storage, 'kept'), task, as, 'chat-1', await readChoices(root), []);
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
	const next = await requestOf(d.root, d.record, join(d.storage, 'kept'), 'task-0002', 'project', 'chat-1', null, []);
	assert.deepEqual(next.versions, { 'assets/characters/lin/v1': hash });
	assert.deepEqual(next.reviews, { 'assets/characters/lin/v1/reviews/r1.json': sha256(review) });
	assert.equal(next.private_state, sha256(state));
	assert.deepEqual(requestKeys(next).sort(), [fileKey(sha256(review)), stateKey(sha256(state)), versionKey(hash)].sort());
});

// Two places in one folder can hold the same bytes: their temporary siblings are named apart (Codex on B9).
test('two identical review files for an installed version both land', async () => {
	const d = await drama();
	const hash = archive(d.store, { 'version.json': version(), 'image-1.png': 'lin' });
	await d.install(await d.send('task-0001', '2026-11-12T10:00:00Z'), { versions: { 'assets/characters/lin/v1': hash }, reviews: {} });
	const review = Buffer.from('{"schema":1,"accepted_at":"2026-11-12T10:00:00Z","reason":"ok"}');
	d.store.files.set(fileKey(sha256(review)), review);
	await d.install(await d.send('task-0002', '2026-11-12T10:05:00Z'), { versions: {}, reviews: { 'assets/characters/lin/v1/reviews/r1.json': sha256(review), 'assets/characters/lin/v1/reviews/r2.json': sha256(review) } });
	assert.deepEqual(readdirSync(join(d.root, 'assets/characters/lin/v1/reviews')).sort(), ['r1.json', 'r2.json']);
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

test('a version folder written straight to disk goes out in the next request with its hash, archived once; its review too', async () => {
	const d = await drama();
	mkdirSync(join(d.root, 'assets/props/cup/v1/reviews'), { recursive: true });
	writeFileSync(join(d.root, 'assets/props/cup/v1/version.json'), version());
	writeFileSync(join(d.root, 'assets/props/cup/v1/image-1.png'), 'cup');
	writeFileSync(join(d.root, 'assets/props/cup/v1/reviews/r1.json'), '{"schema":1,"accepted_at":"2026-11-12T10:00:00Z","reason":"ok"}');
	const first = await d.send('task-0001', '2026-11-12T10:00:00Z');
	const hash = first.versions['assets/props/cup/v1'];
	assert.ok(hash, 'the folder goes out with its archive\'s hash');
	assert.deepEqual(archiveNames(join(d.storage, 'kept', versionKey(hash))).sort(), ['image-1.png', 'version.json'], 'reviews/ is left out');
	assert.equal(sha256(readFileSync(join(d.storage, 'kept', versionKey(hash)))), hash);
	assert.ok(first.reviews['assets/props/cup/v1/reviews/r1.json']);
	const second = await d.send('task-0002', '2026-11-12T10:01:00Z');
	assert.equal(second.versions['assets/props/cup/v1'], hash, 'archived once: the same hash');
	assert.equal(d.record.adopted().filter(a => a.kind === 'version').length, 1);
});

test('the Computer side\'s config written to disk, config/<version id> with no version.json, goes out the same way', async () => {
	const d = await drama();
	mkdirSync(join(d.root, 'config/v1'), { recursive: true });
	writeFileSync(join(d.root, 'config/v1/drama-cli.cfg.yaml'), 'project: .');
	const request = await d.send('task-0001', '2026-11-12T10:00:00Z');
	assert.deepEqual(archiveNames(join(d.storage, 'kept', versionKey(request.versions['config/v1']))), ['drama-cli.cfg.yaml']);
});

// An episode may add a new shared variant (doc/protocol.md, section 1): under assets/, only for an object new to the drama.
test('an episodes return may add a new shared object under assets/, with its own sub-objects, and nothing else there', async () => {
	const d = await drama('episodes');
	// A new variant, with its entry/ and prompts/ sub-objects, and a review of it: accepted.
	const variant = archive(d.store, { 'version.json': version(), 'image-1.png': 'v' });
	const entry = archive(d.store, { 'version.json': version(), 'entry.json': '{}' });
	const prompts = archive(d.store, { 'version.json': version(), 'prompt.md': 'p' });
	const review = Buffer.from('{"schema":1,"accepted_at":"2026-11-12T10:00:00Z","reason":"ok"}');
	d.store.files.set(fileKey(sha256(review)), review);
	const adds = { versions: { 'assets/scenes/x/variants/y/v1': variant, 'assets/scenes/x/variants/y/entry/v1': entry, 'assets/scenes/x/variants/y/prompts/v1': prompts },
		reviews: { 'assets/scenes/x/variants/y/v1/reviews/r.json': sha256(review) } };
	const first = await d.send('task-0001', '2026-11-12T10:00:00Z');
	await d.install(first, adds);
	assert.ok(existsSync(join(d.root, 'assets/scenes/x/variants/y/entry/v1/entry.json')));
	// Installed again after a crash, with its folders already in place: still new, since they are this return's own.
	await d.install(first, adds);
	// A new version of an object the drama has: refused whole.
	const again = archive(d.store, { 'version.json': version(), 'image-1.png': 'v2' });
	await assert.rejects(d.install(await d.send('task-0002', '2026-11-12T10:01:00Z'), { versions: { 'assets/scenes/x/variants/y/v2': again } }), InvalidReturn);
	assert.equal(existsSync(join(d.root, 'assets/scenes/x/variants/y/v2')), false);
});

// B11: a variant an episode turn made was refused in that episode's next turn, which drew its picture.
test('an episodes return may add inside a shared object made in an episodes turn, while it holds that object\'s asset; elsewhere not', async () => {
	const d = await drama('project');
	const object = (type: 'scene' | 'variant', extra = {}) => ({ type, name: type, segment: null, usable: true, from_add: null, ...extra });
	const entry = (text: string) => archive(d.store, { 'version.json': version(), 'entry.json': text });
	// The Project Chat's drama: the street with a variant made in an episodes turn (y) and one the Project Chat made (z),
	// and the yard, which only its marked variant (w) holds.
	await d.install(await d.send('task-0001', '2026-11-12T10:00:00Z'), {
		versions: { 'assets/scenes/street/entry/v1': entry('street'), 'assets/scenes/street/variants/y/entry/v1': entry('y'), 'assets/scenes/street/variants/z/entry/v1': entry('z'),
			'assets/scenes/yard/variants/w/entry/v1': entry('w') },
		snapshot: { observed_at: '2026-11-12T10:00:00Z', edges: [
			{ from: 'assets/scenes/street/variants/y', to: 'assets/scenes/street', kind: 'variant_of' }, { from: 'assets/scenes/street/variants/z', to: 'assets/scenes/street', kind: 'variant_of' },
			{ from: 'assets/scenes/yard/variants/w', to: 'assets/scenes/yard', kind: 'variant_of' }],
		objects: { 'assets/scenes/street': object('scene'), 'assets/scenes/street/variants/y': object('variant', { episode_made: true }), 'assets/scenes/street/variants/z': object('variant'),
			'assets/scenes/yard': object('scene'), 'assets/scenes/yard/variants/w': object('variant', { episode_made: true }) } },
	});
	const picture = (text: string) => archive(d.store, { 'version.json': version(), 'image-1.png': text });
	// Inside y, its picture and a view: accepted.
	const inside = { 'assets/scenes/street/variants/y/v1': picture('y'), 'assets/scenes/street/variants/y/views/front/v1': picture('front') };
	await d.install(await d.send('task-0002', '2026-11-12T10:01:00Z', 'episodes'), { versions: inside });
	assert.ok(existsSync(join(d.root, 'assets/scenes/street/variants/y/views/front/v1/image-1.png')));
	// Inside z, which the Project Chat made, or inside w, whose asset the request holds no version of: refused whole.
	for (const [task, versions] of [['task-0003', { 'assets/scenes/street/variants/z/v1': picture('z') }], ['task-0004', { 'assets/scenes/yard/variants/w/v1': picture('w') }]] as const) {
		await assert.rejects(d.install(await d.send(task, '2026-11-12T10:02:00Z', 'episodes'), { versions }), /outside the task's scope, episodes/);
		assert.equal(existsSync(join(d.root, Object.keys(versions)[0])), false);
	}
});

// Codex on B11: the marked object's asset is the one the latest snapshot listing it derives it from (5.3): an edge
// an older snapshot gave it decides nothing, in whatever order the records are read.
test('the asset an episodes return must hold follows the latest snapshot of the marked object, not an older edge', async () => {
	const d = await drama('project');
	const object = (type: 'scene' | 'variant', extra = {}) => ({ type, name: type, segment: null, usable: true, from_add: null, ...extra });
	const entry = (text: string) => archive(d.store, { 'version.json': version(), 'entry.json': text });
	const objects = { 'assets/scenes/a': object('scene'), 'assets/scenes/a/variants/m': object('variant', { episode_made: true }) };
	await d.install(await d.send('task-0001', '2026-11-12T10:00:00Z'), { versions: { 'assets/scenes/a/entry/v1': entry('a'), 'assets/scenes/a/variants/m/entry/v1': entry('m') },
		snapshot: { observed_at: '2026-11-12T10:00:00Z', objects, edges: [{ from: 'assets/scenes/a/variants/m', to: 'assets/scenes/a', kind: 'variant_of' }] } });
	// The latest snapshot lists m with no variant_of edge: m derives from nothing the request holds beside its own.
	await d.install(await d.send('task-0002', '2026-11-12T10:01:00Z'), { snapshot: { observed_at: '2026-11-12T10:01:00Z', objects, edges: [] } });
	const picture = archive(d.store, { 'version.json': version(), 'image-1.png': 'm' });
	await assert.rejects(d.install(await d.send('task-0003', '2026-11-12T10:02:00Z', 'episodes'), { versions: { 'assets/scenes/a/variants/m/v1': picture } }), /outside the task's scope, episodes/);
});

test('an episodes return may not draw a planned shared object an installed snapshot lists', async () => {
	const d = await drama('episodes');
	const snapshot = { observed_at: '2026-11-12T10:00:00Z', objects: { 'assets/props/umbrella': { type: 'prop' as const, name: 'Umbrella', segment: null, usable: false, from_add: null } }, edges: [] };
	await d.install(await d.send('task-0001', '2026-11-12T10:00:00Z'), { snapshot });
	const drawn = archive(d.store, { 'version.json': version(), 'image-1.png': 'umbrella' });
	await assert.rejects(d.install(await d.send('task-0002', '2026-11-12T10:01:00Z'), { versions: { 'assets/props/umbrella/v1': drawn } }), /outside the task's scope, episodes/);
	assert.equal(existsSync(join(d.root, 'assets/props/umbrella')), false);
});

test('installed snapshots come in install order, each with its task and when it was sent and installed', async () => {
	const d = await drama();
	const snapshot = (at: string) => ({ observed_at: at, objects: {}, edges: [] });
	const late = await d.send('task-0001', '2026-11-12T10:00:00Z');
	const early = await d.send('task-0002', '2026-11-12T10:01:00Z');
	await d.install(early, { snapshot: snapshot('2026-11-12T10:02:00Z') });
	await new Promise(resolve => setTimeout(resolve, 5));
	await d.install(late, { snapshot: snapshot('2026-11-12T10:03:00Z') });
	const listed = installedSnapshots(d.storage, d.root);
	assert.deepEqual(listed.map(s => [s.task, s.sent]), [['task-0002', '2026-11-12T10:01:00.000Z'], ['task-0001', '2026-11-12T10:00:00.000Z']], 'by install, not by send');
	assert.ok(listed[0].installed < listed[1].installed);
});
