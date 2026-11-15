import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../core/git';
import { writeWhole } from '../core/placement';
import { sha256 } from '../core/sha256';
import { changeKey, fileKey, Holders, putAll, type ArtifactStore } from '../core/taskArtifacts';
import { RefusedWithUpgradeInstructions, STUDIO_RELEASES_URL } from '../core/protocol';
import { applyStoredChanges, sendTurnRequest, settleTurn, turnMessage, turnRecordOf, type TurnPlace } from '../core/turn';

// A turn on the Studio's side, protocol major 2 (core/turn.ts, doc/protocol.md section 4), over a store in memory, on the
// major-2 fixture (test-fixtures/project-v2/full): the rules that, broken, would send a seed that is not the folder as
// recorded, upload a file twice, apply a change out of order or twice, or settle a turn short of what it stored.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'project-v2', 'full');

/** A Computer's store in memory, counting uploads (taskArtifacts.ts, ArtifactStore). */
function memoryStore(): ArtifactStore & { readonly files: Map<string, Buffer>; uploads: number } {
	const files = new Map<string, Buffer>();
	return {
		files, uploads: 0,
		async list(prefix) { return [...files].filter(([k]) => k.startsWith(prefix)).map(([path, bytes]) => ({ path, size: bytes.length })); },
		async upload(path, bytes) { this.uploads++; files.set(path, Buffer.from(bytes)); },
		async read(path) { return files.get(path); },
		async copy() { throw new Error('one Computer only'); },
	};
}

function place(): TurnPlace & { store: ReturnType<typeof memoryStore> } {
	const root = mkdtempSync(join(tmpdir(), 'turn-project-'));
	cpSync(FIXTURE, root, { recursive: true });
	const storage = mkdtempSync(join(tmpdir(), 'turn-storage-'));
	return { root, record: turnRecordOf(storage, root), computer: 'computer-1', store: memoryStore(), holders: new Holders(join(storage, 'holders')) };
}

/** Puts turn `turn` of the Chat `main` on the Computer (doc/protocol.md 4.2). */
const send = (at: ReturnType<typeof place>, turn: string) => sendTurnRequest(at, turn, 'main');

/**
 * Stores `files` as change `n` of `turn`, its bytes first, after the change stored as `n - 1`, as the Computer side writes
 * one (doc/protocol.md 4.3).
 */
function storeChange(at: ReturnType<typeof place>, turn: string, n: number, files: Record<string, string | null>, previous = at.store.files.get(changeKey(turn, n - 1))): void {
	for (const text of Object.values(files)) { if (text !== null) { at.store.files.set(fileKey(sha256(text)), Buffer.from(text)); } }
	at.store.files.set(changeKey(turn, n), changeBytes(turn, n, files, previous));
}

/** The bytes of change `n` of `turn` writing `files`, after the change of bytes `previous`. */
const changeBytes = (turn: string, n: number, files: Record<string, string | null>, previous: Buffer | undefined) => Buffer.from(JSON.stringify({
	schema: 2, turn_id: turn, change_number: n, previous_change_sha256: previous ? sha256(previous) : null,
	files_after_change: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text === null ? null : sha256(text)])),
}));

test('the seed is every file of the folder as its history records it, hidden ones aside; a file goes up once', async () => {
	const at = place();
	writeFileSync(join(at.root, 'inputs-brief.md'), 'a brief written by hand');
	const { request, uploaded } = await send(at, 'turn-1');
	assert.equal(request.seed_files['inputs-brief.md'], sha256('a brief written by hand'), 'a hand edit is recorded, then seeded');
	assert.equal(request.seed_files['assets/characters/lin/look.png'], sha256(readFileSync(join(at.root, 'assets/characters/lin/look.png'))));
	assert.ok(Object.keys(request.seed_files).every(path => !path.split('/').some(part => part.startsWith('.'))), 'no .git, no hidden file');
	assert.equal((await git(['status', '--porcelain'], at.root)).stdout, '', 'the seed is recorded in history');
	assert.equal(uploaded, new Set(Object.values(request.seed_files)).size);
	assert.deepEqual(at.record.sentTurn('turn-1')?.request, request, 'recorded, for the send to put into the session');
	assert.deepEqual([...at.store.files.keys()].filter(key => !key.startsWith('files/')), [], 'the store holds the files alone, no request');
	writeFileSync(join(at.root, 'inputs-brief.md'), 'the brief, changed');
	await at.record.settle('turn-1', { files: [] });
	const second = await send(at, 'turn-2');
	assert.equal(second.uploaded, 1, 'only the changed file goes up');
});

test('changes land in order as they are stored, each a pine-computer commit with its trailers, and a second read applies nothing again', async () => {
	const at = place();
	await send(at, 'turn-1');
	storeChange(at, 'turn-1', 1, { 'assets/props/umbrella/description.md': 'A red umbrella.' });
	storeChange(at, 'turn-1', 3, { 'assets/props/umbrella/description.md': 'Not yet: change 2 is missing.' }, Buffer.from('change 2, as it will be'));
	assert.equal((await applyStoredChanges(at, 'turn-1')).next, 2, 'up to the first change not stored');
	assert.equal(readFileSync(join(at.root, 'assets/props/umbrella/description.md'), 'utf8'), 'A red umbrella.');
	storeChange(at, 'turn-1', 2, { 'assets/props/umbrella/picture.png': 'a redraw', 'assets/props/umbrella/picture.png.receipt.json': null });
	await assert.rejects(applyStoredChanges(at, 'turn-1'), /changes\/3\.json does not follow the change before it/, 'a change stored after another than the one before it is not applied');
	storeChange(at, 'turn-1', 3, { 'assets/props/umbrella/description.md': 'Not yet: change 2 is missing.' });
	const { next, files } = await applyStoredChanges(at, 'turn-1');
	assert.equal(next, 4);
	assert.deepEqual([...files].sort(), ['assets/props/umbrella/description.md', 'assets/props/umbrella/picture.png', 'assets/props/umbrella/picture.png.receipt.json']);
	const log = (await git(['log', '--format=%an|%(trailers:key=Pine-Change-Number,valueonly)', '-3'], at.root)).stdout.split('\n').map(l => l.trim()).filter(Boolean);
	assert.deepEqual(log, ['pine-computer|3', 'pine-computer|2', 'pine-computer|1']);
	const before = (await git(['rev-parse', 'HEAD'], at.root)).stdout;
	await applyStoredChanges(at, 'turn-1');
	assert.equal((await git(['rev-parse', 'HEAD'], at.root)).stdout, before, 'each change is applied once');
});

test('at the Pine turn\'s end every change stored lands, up to the first not stored, and the turn is settled with the files it wrote', async () => {
	const at = place();
	await send(at, 'turn-1');
	storeChange(at, 'turn-1', 1, { 'assets/props/umbrella/description.md': 'Made before the run was cut off.' });
	storeChange(at, 'turn-1', 3, { 'assets/props/umbrella/prompt.md': 'Not in: change 2 is not stored.' }, Buffer.from('change 2, as it will be'));
	await settleTurn(at, 'turn-1');
	assert.equal(readFileSync(join(at.root, 'assets/props/umbrella/description.md'), 'utf8'), 'Made before the run was cut off.');
	assert.deepEqual(at.record.settled('turn-1')!.files, ['assets/props/umbrella/description.md']);
	assert.deepEqual(at.record.unsettled('main'), []);
});

test('a Pine Computer of another major is known by a change it wrote, and refused with what to use, once: an older side or a newer one', async () => {
	const at = place();
	const refused = async (turn: string, change: object) => {
		await send(at, turn);
		at.store.files.set(changeKey(turn, 1), Buffer.from(JSON.stringify(change)));
		const settled = await settleTurn(at, turn);
		assert.ok(settled.kind === 'refused with upgrade instructions', settled.kind);
		assert.ok(at.record.settled(turn), 'settled: never read again');
		return settled.refusal;
	};
	const older = await refused('turn-1', { schema: 1, turn_id: 'turn-1', change_number: 1 });
	assert.match(older.message, /older Pine Computer side.*A new session starts on a current one/);
	assert.deepEqual([older.studioVersion, older.downloadUrl], [undefined, undefined]);
	const newer = (refusal: RefusedWithUpgradeInstructions) => {
		assert.match(refusal.message, /newer Pine Computer side/);
		assert.equal(refusal.downloadUrl, STUDIO_RELEASES_URL);
	};
	newer(await refused('turn-2', { schema: 3, turn_id: 'turn-2', change_number: 1 }));
	assert.equal(at.record.unsettled('main').length, 0);
});

// B9: two sessions preparing at once record holders in one folder at the same moment. Each write's temporary file must
// be its own: when two shared a name, one rename found the file gone ("ENOENT … holders/.<pid>.<ms>.tmp") and the
// other could put one write's bytes under the other's name.
test('writes started together in one folder each land whole, under their own name', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'write-whole-'));
	// One millisecond for every write, so that a name made of the time can only collide.
	t.mock.method(Date, 'now', () => 1_794_573_115_577);
	const names = Array.from({ length: 20 }, (_, i) => `file-${i}`);
	await Promise.all(names.map(name => writeWhole(join(dir, name), `text of ${name}`)));
	for (const name of names) {
		assert.equal(await readFile(join(dir, name), 'utf8'), `text of ${name}`);
	}
	assert.deepEqual((await readdir(dir)).sort(), [...names].sort(), 'no temporary file is left');
	const holders = new Holders(join(dir, 'holders'));
	await Promise.all([holders.set(['a', 'b'], 'computer-1'), holders.set(['c', 'd'], 'computer-2')]);
	assert.deepEqual(['a', 'b', 'c', 'd'].map(hash => holders.get(hash)), ['computer-1', 'computer-1', 'computer-2', 'computer-2']);
});

test('before a turn, a key the store lacks is copied from the Computer remembered holding it, else uploaded; a failed copy uploads', async () => {
	const holders = new Holders(mkdtempSync(join(tmpdir(), 'holders-')));
	const target = memoryStore();
	target.files.set('files/a', Buffer.from('a'));
	const copies: string[] = [];
	target.copy = async (from, path) => { copies.push(`${from}:${path}`); if (from === 'gone') { throw new Error('no such Computer'); } target.files.set(path, Buffer.from('copied')); };
	await holders.set(['b'], 'computer-2');
	await holders.set(['d'], 'gone');
	const uploaded: string[] = [];
	const put = await putAll(target, 'computer-1', holders, ['files/a', 'files/b', 'files/c', 'files/d', 'files/c'], async key => { uploaded.push(key); return Buffer.from('up'); }, key => key === 'files/a' ? 1 : 6);
	assert.deepEqual(put, { copied: 1, uploaded: 2 });
	assert.deepEqual(copies, ['computer-2:files/b', 'gone:files/d']);
	assert.deepEqual(uploaded, ['files/c', 'files/d'], 'nothing remembered, or the copy failed: uploaded from the Studio\'s copy');
	assert.deepEqual(['a', 'b', 'c', 'd'].map(h => holders.get(h)), ['computer-1', 'computer-1', 'computer-1', 'computer-1'], 'the listing and each put remember the target');
});

test('before a turn, a file the store holds cut short is put again', async () => {
	const holders = new Holders(mkdtempSync(join(tmpdir(), 'holders-')));
	const target = memoryStore();
	target.files.set('files/a', Buffer.from('par'));
	const put = await putAll(target, 'computer-1', holders, ['files/a'], async () => Buffer.from('partial'), () => 7);
	assert.deepEqual(put, { copied: 0, uploaded: 1 });
	assert.deepEqual(target.files.get('files/a'), Buffer.from('partial'));
});

test('a turn\'s message names the turn on its first line, the person\'s words after', () => {
	assert.equal(turnMessage('turn-0001', 'make the poster'), 'pine-drama-turn turn-0001\nmake the poster');
});
