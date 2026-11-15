import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../core/git';
import { writeWhole } from '../core/placement';
import { sha256 } from '../core/sha256';
import { changeKey, fileKey, Holders, paidCallsPrefix, privateStateKey, putAll, requestKey, returnKey, type ArtifactStore } from '../core/taskArtifacts';
import { applyStoredChanges, objectsBeingMade, resolveTurn, sendTurnRequest, turnMessage, turnRecordOf, type TurnPlace } from '../core/turn';

// A turn on the Studio's side, protocol major 2 (core/turn.ts, doc/protocol.md section 4), over a store in memory, on the
// major-2 fixture (test-fixtures/project-v2/full): the rules that, broken, would send a seed that is not the folder as
// recorded, upload a file twice, apply a change out of order or twice, resolve a turn whose return names a change not
// stored, lose a session's private state, or show nothing being made while a paid call runs.
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
	return { root, record: turnRecordOf(storage, root), computer: 'computer-1', store: memoryStore(), kept: join(storage, 'kept'), holders: new Holders(join(storage, 'holders')) };
}

/**
 * Stores `files` as change `n` of `turn`, its bytes first, after the change stored as `n - 1`, as the Computer side writes
 * one (doc/protocol.md 4.3). Returns the hash of its bytes.
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

const storeReturn = (at: ReturnType<typeof place>, turn: string, value: object) =>
	at.store.files.set(returnKey(turn), Buffer.from(JSON.stringify({ schema: 2, turn_id: turn, ...value })));

test('the seed is every file of the folder as its history records it, hidden ones aside; a file goes up once', async () => {
	const at = place();
	writeFileSync(join(at.root, 'inputs-brief.md'), 'a brief written by hand');
	const { request, uploaded } = await sendTurnRequest(at, 'turn-1', 'main');
	assert.equal(request.seed_files['inputs-brief.md'], sha256('a brief written by hand'), 'a hand edit is recorded, then seeded');
	assert.equal(request.seed_files['assets/characters/lin/look.png'], sha256(readFileSync(join(at.root, 'assets/characters/lin/look.png'))));
	assert.ok(Object.keys(request.seed_files).every(path => !path.split('/').some(part => part.startsWith('.'))), 'no .git, no hidden file');
	assert.equal((await git(['status', '--porcelain'], at.root)).stdout, '', 'the seed is recorded in history');
	assert.equal(uploaded, new Set(Object.values(request.seed_files)).size);
	assert.deepEqual(JSON.parse(at.store.files.get(requestKey('turn-1'))!.toString('utf8')), request);
	assert.equal(request.session_private_state, null);
	writeFileSync(join(at.root, 'inputs-brief.md'), 'the brief, changed');
	await at.record.resolve('turn-1', { state: 'pine_computer_finished_the_work', files: [], making: [] });
	const second = await sendTurnRequest(at, 'turn-2', 'main');
	assert.equal(second.uploaded, 1, 'only the changed file goes up');
});

test('changes land in order as they are stored, each a pine-computer commit with its trailers, and a second read applies nothing again', async () => {
	const at = place();
	await sendTurnRequest(at, 'turn-1', 'main');
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

test('a return resolves its turn once every change it names is in, and its private state is the session\'s next', async () => {
	const at = place();
	await sendTurnRequest(at, 'turn-1', 'main');
	storeChange(at, 'turn-1', 1, { 'assets/props/umbrella/description.md': 'A red umbrella.' });
	const state = Buffer.from('the session after turn 1');
	at.store.files.set(privateStateKey(sha256(state)), state);
	const second = { 'assets/props/umbrella/prompt.md': 'Red, folded.' };
	const last = sha256(changeBytes('turn-1', 2, second, at.store.files.get(changeKey('turn-1', 1))));
	storeReturn(at, 'turn-1', { state: 'pine_computer_finished_the_work', last_change: { change_number: 2, sha256: last }, session_private_state: sha256(state), pine_computer_could_not_do: [] });
	await assert.rejects(resolveTurn(at, 'turn-1'), /turns\/turn-1\/changes\/2\.json is not in the Computer's artifacts/);
	assert.equal(at.record.resolved('turn-1'), undefined, 'a return whose changes are not all in leaves its turn unresolved');
	storeChange(at, 'turn-1', 2, second);
	assert.equal((await resolveTurn(at, 'turn-1')).kind, 'returned');
	assert.deepEqual(at.record.resolved('turn-1')!.files.slice().sort(), ['assets/props/umbrella/description.md', 'assets/props/umbrella/prompt.md']);
	assert.equal(at.record.privateState('main'), sha256(state));
	const next = await sendTurnRequest(at, 'turn-2', 'main');
	assert.equal(next.request.session_private_state, sha256(state));
});

test('a turn with no return keeps what it stored and the private state before it; a refused one changes nothing', async () => {
	const at = place();
	await sendTurnRequest(at, 'turn-1', 'main');
	storeChange(at, 'turn-1', 1, { 'assets/props/umbrella/description.md': 'Made before the run was cut off.' });
	for (const state of ['pine_computer_sent_request_to_provider', 'pine_computer_cannot_learn_call_outcome']) {
		at.store.files.set(`${paidCallsPrefix('turn-1')}call-1/${state}.json`, Buffer.from(JSON.stringify({ schema: 2, paid_call_id: 'call-1', object_id: 'assets/scenes/street', state, state_written_at: '2026-11-14T10:00:00Z' })));
	}
	assert.deepEqual(await resolveTurn(at, 'turn-1'), { kind: 'no return', applied: 1 });
	assert.deepEqual([...at.record.stillMaking()], [['turn-1', ['assets/scenes/street']]], 'a call cut off with the run is still making, in the record (4.5)');
	await at.record.settled('turn-1', []);
	assert.equal(at.record.stillMaking().size, 0);
	assert.equal(readFileSync(join(at.root, 'assets/props/umbrella/description.md'), 'utf8'), 'Made before the run was cut off.');
	assert.deepEqual([at.record.resolved('turn-1')!.state, at.record.privateState('main')], [null, null]);
	await sendTurnRequest(at, 'turn-2', 'main');
	storeReturn(at, 'turn-2', { state: 'pine_computer_refused_the_turn_before_running', error: { code: 'pine_computer_found_file_missing_from_store', message: 'files/abc is missing' } });
	const head = (await git(['rev-parse', 'HEAD'], at.root)).stdout;
	assert.equal((await resolveTurn(at, 'turn-2')).kind, 'returned');
	assert.equal((await git(['rev-parse', 'HEAD'], at.root)).stdout, head);
	assert.equal(at.record.unresolved('main').length, 0);
});

test('an object is being made while a paid call of it was sent and has no terminal state; one not settled is still making', async () => {
	const store = memoryStore();
	const state = (call: string, object: string, s: string) =>
		store.files.set(`${paidCallsPrefix('turn-1')}${call}/${s}.json`, Buffer.from(JSON.stringify({ schema: 2, paid_call_id: call, object_id: object, state: s, state_written_at: '2026-11-14T10:00:00Z' })));
	state('call-1', 'assets/props/umbrella', 'pine_computer_sent_request_to_provider');
	state('call-2', 'assets/characters/lin', 'pine_computer_sent_request_to_provider');
	state('call-2', 'assets/characters/lin', 'provider_returned_output_to_pine_computer');
	state('call-3', 'assets/scenes/street', 'pine_computer_sent_request_to_provider');
	state('call-3', 'assets/scenes/street', 'pine_computer_cannot_learn_call_outcome');
	assert.deepEqual([...await objectsBeingMade(store, 'turn-1')].sort(), ['assets/props/umbrella', 'assets/scenes/street']);
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
	const put = await putAll(target, 'computer-1', holders, ['files/a', 'session-private-states/b.tar', 'files/c', 'files/d', 'files/c'], async key => { uploaded.push(key); return Buffer.from('up'); }, key => key === 'files/a' ? 1 : 6);
	assert.deepEqual(put, { copied: 1, uploaded: 2 });
	assert.deepEqual(copies, ['computer-2:session-private-states/b.tar', 'gone:files/d']);
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
