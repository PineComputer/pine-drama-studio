import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPersonChange, landTurnFiles, NotAProjectPathError } from '../core/applyChange';
import { git } from '../core/git';
import { commitFilesFoundOnDisk, commitTreeWith, listHistory, readRef, sessionRefs, type TreeEntry } from '../core/projectHistory';

// The person's change landing in the project folder (doc/protocol.md section 3), and a turn's result landing over it:
// the rules that, broken, would lose an earlier version, take in what someone else staged, or write outside the
// project.
const project = () => mkdtempSync(join(tmpdir(), 'pine-apply-'));
/** git's id of a blob of `text` (git hash-object): what the file's history names its bytes by. */
const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const LOOK = 'assets/characters/lin/look.png';
const RECEIPT = `${LOOK}.receipt.json`;
const out = async (dir: string, ...args: string[]) => (await git(args, dir)).stdout.trim();
const commitCount = async (dir: string) => Number(await out(dir, 'rev-list', '--count', 'HEAD'));
const person = (dir: string, files: Record<string, string | null>) => applyPersonChange(dir, 'The person\'s change', async () => Object.entries(files));
/** A turn's end whose result is HEAD with `entries` (landTurnFiles), on a session that has written nothing yet. */
async function land(dir: string, turn: string, entries: TreeEntry[]) {
	const acked = (await readRef(dir, 'HEAD'))!;
	const to = await commitTreeWith(dir, acked, entries);
	return landTurnFiles(dir, { ids: { computer: 'pc-1', session: 's-1', turn }, refs: sessionRefs('s-1'), acked, written: acked, to, last: true });
}

test("the person's change is written and committed as theirs, with only its paths, and the same change again writes nothing", async () => {
	const dir = project();
	writeFileSync(join(dir, 'notes.txt'), 'a hand edit\n');
	assert.equal(await person(dir, { [LOOK]: 'picture one', [RECEIPT]: '{"paid_call_id":"call-0001"}' }), 'written and committed');
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'picture one');
	assert.equal(await out(dir, 'log', '-1', '--format=%an'), 'person');
	assert.deepEqual((await out(dir, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(), [LOOK, RECEIPT]);
	assert.equal(await out(dir, 'status', '--porcelain', '--', 'notes.txt'), '?? notes.txt', 'the hand edit is left for its own commit');
	const commits = await commitCount(dir);
	assert.equal(await person(dir, { [LOOK]: 'picture one' }), 'already on disk');
	assert.equal(await commitCount(dir), commits);
});

test("a turn's result lands over the person's edit, and the file's history keeps both, a deletion too", async () => {
	const dir = project();
	await person(dir, { [LOOK]: 'picture one' });
	writeFileSync(join(dir, LOOK), 'the person\'s own picture');
	await commitFilesFoundOnDisk(dir, 'Changes found on disk');
	const two = (await git(['hash-object', '-w', '--stdin'], dir, { stdin: 'picture two' })).stdout.trim();
	assert.deepEqual((await land(dir, 'turn-2', [{ path: LOOK, mode: '100644', blob: two }])).landed, [LOOK]);
	await land(dir, 'turn-3', [{ path: LOOK, mode: '100644', blob: null }]);
	assert.equal(existsSync(join(dir, LOOK)), false, 'null deletes the file');
	assert.equal(existsSync(join(dir, 'assets')), false, 'and the folders it leaves empty');
	assert.deepEqual((await listHistory(dir, LOOK)).map(h => [h.author, h.files.get(LOOK), h.turnId]), [
		['pine-computer', null, 'turn-3'],
		['pine-computer', blob('picture two'), 'turn-2'],
		['client-found-changes-on-disk', blob('the person\'s own picture'), null],
		['person', blob('picture one'), null],
	]);
});

test('nothing of the person\'s change is written when a name is not a path of the project', async () => {
	const dir = project();
	for (const path of ['.git/config', 'assets/../../outside.txt', '/etc/passwd', 'assets/CON', 'a/b.', `${LOOK.toUpperCase()}`]) {
		const files = path === LOOK.toUpperCase() ? { [LOOK]: 'x', [path]: 'y' } : { [path]: 'x' };
		await assert.rejects(person(dir, files), (error: Error) => error instanceof NotAProjectPathError, path);
	}
	assert.equal(existsSync(join(dir, 'assets')), false, 'nothing of a refused change is written');
});

test("the person's change takes nothing else staged, and a file whose name is words and spaces keeps its history", async () => {
	const dir = project();
	await person(dir, { [LOOK]: 'one', 'a blob 1000': 'x' });
	writeFileSync(join(dir, 'notes.txt'), 'staged by hand\n');
	await out(dir, 'add', 'notes.txt');
	await person(dir, { [LOOK]: 'two', 'a blob 1000': null });
	assert.deepEqual((await out(dir, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(), ['a blob 1000', LOOK]);
	assert.equal(await out(dir, 'diff', '--cached', '--name-only'), 'notes.txt', 'the person\'s staged file stays staged');
	assert.deepEqual((await listHistory(dir, 'a blob 1000')).map(h => h.files.get('a blob 1000')), [null, blob('x')]);
});

test('a folder linked into .git, or another of the project, is never written through', async () => {
	const dir = project();
	await person(dir, { [LOOK]: 'one' });
	symlinkSync(join(dir, '.git'), join(dir, 'linked'));
	const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
	await assert.rejects(person(dir, { 'linked/config': 'x' }), (error: Error) => error instanceof NotAProjectPathError);
	assert.equal(readFileSync(join(dir, '.git', 'config'), 'utf8'), config);
	symlinkSync(join(dir, 'assets'), join(dir, 'also-assets'));
	await assert.rejects(person(dir, { 'also-assets/characters/lin/look.png': 'x' }), (error: Error) => error instanceof NotAProjectPathError);
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'one');
});

test('a path the folder will not take (a read-only folder) is left out with why, and the rest of the turn lands', async () => {
	const dir = project();
	await person(dir, { 'locked/old.txt': 'the person\'s', [LOOK]: 'one' });
	chmodSync(join(dir, 'locked'), 0o555);
	try {
		const blobOf = async (text: string) => (await git(['hash-object', '-w', '--stdin'], dir, { stdin: text })).stdout.trim();
		const { landed, leftOut } = await land(dir, 'turn-1', [
			{ path: 'locked/new.txt', mode: '100644', blob: await blobOf('not allowed') },
			{ path: 'locked/old.txt', mode: '100644', blob: null },
			{ path: LOOK, mode: '100644', blob: await blobOf('two') },
		]);
		assert.deepEqual(landed, [LOOK]);
		assert.deepEqual(Object.fromEntries(leftOut), { 'locked/new.txt': 'not allowed to write there', 'locked/old.txt': 'not allowed to write there' });
		assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'two');
		assert.equal(readFileSync(join(dir, 'locked/old.txt'), 'utf8'), 'the person\'s');
	} finally {
		chmodSync(join(dir, 'locked'), 0o755);
	}
});
