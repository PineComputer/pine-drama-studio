import { createHash } from 'node:crypto';
import { sha256 } from '../core/sha256';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyChangeToProjectFolder, NotAProjectPathError, type ProjectFolderChange } from '../core/applyChange';
import { git } from '../core/git';
import { commitFilesFoundOnDisk, listHistory } from '../core/projectHistory';

// Applying a turn's change, a Use or an Undo (doc/protocol.md 4.4): the rules that, broken, would lose a paid result,
// apply one twice, take one change for another, or write outside the project.
const project = () => mkdtempSync(join(tmpdir(), 'pine-apply-'));
const sha = sha256;
/** git's id of a blob of `text` (git hash-object): what the file's history names its bytes by. */
const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
/** A store of file bytes by hash, as the Computer's `files/<hash>`. */
const store = (...texts: string[]) => {
	const files = new Map(texts.map(text => [sha(text), Buffer.from(text)]));
	return async (hash: string) => files.get(hash) ?? assert.fail(`${hash} is not in the store`);
};
const LOOK = 'assets/characters/lin/look.png';
const RECEIPT = `${LOOK}.receipt.json`;
const turnResult = (turn: number, files: Record<string, string | null>): ProjectFolderChange => ({
	filesAfterChange: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text === null ? null : sha(text)])),
	author: 'pine-computer', commitMessage: `Turn ${turnId(turn)}`, turnId: turnId(turn),
});
const turnId = (turn: number) => `turn-${String(turn).padStart(4, '0')}-abcdef`;
const out = async (dir: string, ...args: string[]) => (await git(args, dir)).stdout.trim();
const commitCount = async (dir: string) => Number(await out(dir, 'rev-list', '--count', 'HEAD'));

test("a turn's result is written and committed once, as the Pine Computer's, with its trailer and only its paths", async () => {
	const dir = project();
	writeFileSync(join(dir, 'notes.txt'), 'the person\'s, by hand\n');
	const bytes = store('picture one', '{"paid_call_id":"call-0001"}');
	const change = turnResult(1, { [LOOK]: 'picture one', [RECEIPT]: '{"paid_call_id":"call-0001"}' });
	assert.equal(await applyChangeToProjectFolder(dir, change, bytes), 'written and committed');
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'picture one');
	assert.equal(await out(dir, 'log', '-1', '--format=%an|%(trailers:key=Pine-Turn-Id,valueonly,separator=)'), 'pine-computer|turn-0001-abcdef');
	assert.deepEqual((await out(dir, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(), [LOOK, RECEIPT]);
	assert.equal(await out(dir, 'status', '--porcelain', '--', 'notes.txt'), '?? notes.txt', 'the hand edit is left for its own commit');
	const commits = await commitCount(dir);
	assert.equal(await applyChangeToProjectFolder(dir, change, bytes), 'already in history', 'a result landed once is skipped');
	assert.equal(await commitCount(dir), commits);
});

test('turn 1 is not turn 10: each is found by its own trailer', async () => {
	const dir = project();
	const bytes = store('ten', 'one');
	assert.equal(await applyChangeToProjectFolder(dir, { ...turnResult(10, { [LOOK]: 'ten' }), turnId: 'turn-1x' }, bytes), 'written and committed');
	assert.equal(await applyChangeToProjectFolder(dir, { ...turnResult(1, { [LOOK]: 'one' }), turnId: 'turn-1' }, bytes), 'written and committed');
});

test('a result whose files a crash left on disk is recorded with an empty commit, then found in history', async () => {
	const dir = project();
	mkdirSync(join(dir, 'assets', 'characters', 'lin'), { recursive: true });
	writeFileSync(join(dir, LOOK), 'picture one');
	await commitFilesFoundOnDisk(dir, 'Changes found on disk when the project opened');
	const change = turnResult(1, { [LOOK]: 'picture one' });
	assert.equal(await applyChangeToProjectFolder(dir, change, store()), 'already on disk', 'no bytes are fetched again');
	assert.equal(await out(dir, 'show', '--name-only', '--format=%an', 'HEAD'), 'pine-computer');
	assert.equal(await applyChangeToProjectFolder(dir, change, store()), 'already in history');
});

test("the newest result lands over the person's edit, and the file's history keeps both, a deletion too", async () => {
	const dir = project();
	const bytes = store('picture one', 'picture two');
	await applyChangeToProjectFolder(dir, turnResult(1, { [LOOK]: 'picture one' }), bytes);
	writeFileSync(join(dir, LOOK), 'the person\'s own picture');
	await commitFilesFoundOnDisk(dir, 'Changes found on disk before turn-0002');
	await applyChangeToProjectFolder(dir, turnResult(2, { [LOOK]: 'picture two' }), bytes);
	await applyChangeToProjectFolder(dir, turnResult(3, { [LOOK]: null }), bytes);
	assert.equal(existsSync(join(dir, LOOK)), false, 'null deletes the file');
	const history = await listHistory(dir, LOOK);
	assert.deepEqual(history.map(h => [h.author, h.files.get(LOOK), h.turnId]), [
		['pine-computer', null, turnId(3)],
		['pine-computer', blob('picture two'), turnId(2)],
		['client-found-changes-on-disk', blob('the person\'s own picture'), null],
		['pine-computer', blob('picture one'), turnId(1)],
	]);
});

test('nothing is written when a file\'s bytes do not match their hash, or a name is not a path of the project', async () => {
	const dir = project();
	const wrong = async () => Buffer.from('not the picture');
	await assert.rejects(applyChangeToProjectFolder(dir, turnResult(1, { [LOOK]: 'picture one' }), wrong), /do not match/);
	assert.equal(existsSync(join(dir, LOOK)), false);
	for (const path of ['.git/config', 'assets/../../outside.txt', '/etc/passwd', 'assets/CON', 'a/b.', `${LOOK.toUpperCase()}`]) {
		const change = turnResult(2, path === LOOK.toUpperCase() ? { [LOOK]: 'x', [path]: 'y' } : { [path]: 'x' });
		await assert.rejects(applyChangeToProjectFolder(dir, change, store('x', 'y')), (error: Error) => error instanceof NotAProjectPathError, path);
	}
	assert.equal(existsSync(join(dir, 'assets')), false, 'nothing of a refused change is written');
});

test('a result whose bytes the history holds already is still recorded, and its record takes nothing else staged', async () => {
	const dir = project();
	const bytes = store('picture one', 'the person\'s');
	await applyChangeToProjectFolder(dir, turnResult(1, { [LOOK]: 'picture one' }), bytes);
	// The person's uncommitted edit, and a file they staged themselves: the turn brings back what HEAD holds.
	writeFileSync(join(dir, LOOK), 'the person\'s');
	writeFileSync(join(dir, 'notes.txt'), 'staged by hand\n');
	await out(dir, 'add', 'notes.txt');
	assert.equal(await applyChangeToProjectFolder(dir, turnResult(2, { [LOOK]: 'picture one' }), bytes), 'written and committed');
	assert.equal(await out(dir, 'log', '-1', '--format=%(trailers:key=Pine-Turn-Id,valueonly,separator=)'), turnId(2), 'the result is recorded');
	assert.equal(await out(dir, 'show', '--name-only', '--format=', 'HEAD'), '', 'nothing else is in its commit');
	assert.equal(await out(dir, 'diff', '--cached', '--name-only'), 'notes.txt', 'the person\'s staged file stays staged');
	assert.equal(await applyChangeToProjectFolder(dir, turnResult(2, { [LOOK]: 'picture one' }), bytes), 'already in history');
});

test('text quoted in a commit message is no trailer: the result it quotes is still landed', async () => {
	const dir = project();
	writeFileSync(join(dir, 'notes.txt'), 'x');
	await out(dir, 'init', '-q');
	await out(dir, 'add', '.');
	await out(dir, '-c', 'user.name=p', '-c', 'user.email=p@x', 'commit', '-q', '-m', 'About it\n\nPine-Turn-Id: turn-0001-abcdef\n\nNot a trailer block.');
	assert.equal(await applyChangeToProjectFolder(dir, turnResult(1, { [LOOK]: 'one' }), store('one')), 'written and committed');
});

test('a folder linked into .git is never written through, and a file whose name is words and spaces keeps its history', async () => {
	const dir = project();
	await applyChangeToProjectFolder(dir, turnResult(1, { 'a blob 1000': 'x', [LOOK]: 'one' }), store('x', 'one'));
	await applyChangeToProjectFolder(dir, turnResult(2, { 'a blob 1000': null, [LOOK]: 'two' }), store('two'));
	assert.deepEqual((await listHistory(dir, 'a blob 1000')).map(h => h.files.get('a blob 1000')), [null, blob('x')]);
	assert.deepEqual((await listHistory(dir, LOOK)).map(h => h.files.get(LOOK)), [blob('two'), blob('one')]);
	symlinkSync(join(dir, '.git'), join(dir, 'linked'));
	const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
	await assert.rejects(applyChangeToProjectFolder(dir, turnResult(3, { 'linked/config': 'x' }), store('x')), (error: Error) => error instanceof NotAProjectPathError);
	assert.equal(readFileSync(join(dir, '.git', 'config'), 'utf8'), config);
	// A link to the project's own folder too: git could not commit the path it names.
	symlinkSync(join(dir, 'assets'), join(dir, 'also-assets'));
	await assert.rejects(applyChangeToProjectFolder(dir, turnResult(4, { 'also-assets/characters/lin/look.png': 'x' }), store('x')), (error: Error) => error instanceof NotAProjectPathError);
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'two');
	// A result landed before is skipped, though a link now stands where its folder was.
	assert.equal(await applyChangeToProjectFolder(dir, turnResult(1, { 'also-assets/x.png': 'x' }), store('x')), 'already in history');
});
