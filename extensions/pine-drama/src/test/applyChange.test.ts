import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPersonChange, landTurnFiles, NotAProjectPathError } from '../core/applyChange';
import { git } from '../core/git';
import { commitFilesFoundOnDisk, listHistory } from '../core/projectHistory';

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

test("the person's change is written and committed as theirs, with only its paths, and the same change again writes nothing", async () => {
	const dir = project();
	writeFileSync(join(dir, 'notes.txt'), 'a hand edit\n');
	assert.equal(await person(dir, { [LOOK]: 'picture one', [RECEIPT]: '{"paid_call_id":"call-0001"}' }), 'written and committed');
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'picture one');
	assert.equal(await out(dir, 'log', '-1', '--format=%an'), 'person');
	assert.deepEqual((await out(dir, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(), [LOOK, RECEIPT]);
	assert.equal(await out(dir, 'log', '-1', '--format=%an', 'HEAD~1', '--', 'notes.txt'), 'client-found-changes-on-disk', 'the hand edit gets its own commit, first');
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
	const ids = (turn: string) => ({ computer: 'pc-1', session: 's-1', turn });
	assert.deepEqual((await landTurnFiles(dir, ids('turn-2'), [{ path: LOOK, mode: '100644', blob: two }], true, {})).landed, [LOOK]);
	await landTurnFiles(dir, ids('turn-3'), [{ path: LOOK, mode: '100644', blob: null }], true, {});
	assert.equal(existsSync(join(dir, LOOK)), false, 'null deletes the file');
	assert.equal(existsSync(join(dir, 'assets')), false, 'and the folders it leaves empty');
	assert.deepEqual((await listHistory(dir, LOOK)).map(h => [h.author, h.files.get(LOOK), h.turnId]), [
		['pine-computer', null, 'turn-3'],
		['pine-computer', blob('picture two'), 'turn-2'],
		['client-found-changes-on-disk', blob('the person\'s own picture'), null],
		['person', blob('picture one'), null],
	]);
});

test('nothing of the person\'s change is written when a name is not a path of the project, or leads through a link', async () => {
	const dir = project();
	for (const path of ['.git/config', 'assets/../../outside.txt', '/etc/passwd', 'assets/CON', 'a/b.', `${LOOK.toUpperCase()}`]) {
		const files = path === LOOK.toUpperCase() ? { [LOOK]: 'x', [path]: 'y' } : { [path]: 'x' };
		await assert.rejects(person(dir, files), (error: Error) => error instanceof NotAProjectPathError, path);
	}
	assert.equal(existsSync(join(dir, 'assets')), false, 'nothing of a refused change is written');
	// A folder linked into .git, or another of the project, is never written through.
	await person(dir, { [LOOK]: 'one' });
	symlinkSync(join(dir, '.git'), join(dir, 'linked'));
	const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
	await assert.rejects(person(dir, { 'linked/config': 'x' }), (error: Error) => error instanceof NotAProjectPathError);
	assert.equal(readFileSync(join(dir, '.git', 'config'), 'utf8'), config);
	symlinkSync(join(dir, 'assets'), join(dir, 'also-assets'));
	await assert.rejects(person(dir, { 'also-assets/characters/lin/look.png': 'x' }), (error: Error) => error instanceof NotAProjectPathError);
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'one');
});

test('while the turn runs, an output whose receipt waits for a folder in its way waits with it, staged nowhere', async () => {
	const dir = project();
	await person(dir, { [LOOK]: 'one', 'notes.txt': 'old' });
	mkdirSync(join(dir, RECEIPT), { recursive: true });
	writeFileSync(join(dir, RECEIPT, 'in the way'), 'a folder where the receipt goes');
	const blobOf = async (text: string) => (await git(['hash-object', '-w', '--stdin'], dir, { stdin: text })).stdout.trim();
	const { landed } = await landTurnFiles(dir, { computer: 'pc-1', session: 's-1', turn: 'turn-1' }, [
		{ path: LOOK, mode: '100644', blob: await blobOf('two') },
		{ path: RECEIPT, mode: '100644', blob: await blobOf('{"paid_call_id":"call-0002"}') },
		{ path: 'notes.txt', mode: '100644', blob: await blobOf('new') },
	], false, {});
	assert.deepEqual(landed, ['notes.txt']);
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'one');
	assert.deepEqual((await git(['diff', '--cached', '--name-only'], dir)).stdout.trim().split('\n'), ['notes.txt']);
});

test('while the turn runs, a receipt whose output the person edited waits with it', async () => {
	const dir = project();
	await person(dir, { [LOOK]: 'one', [RECEIPT]: '{"paid_call_id":"call-0001"}' });
	writeFileSync(join(dir, LOOK), 'edited by hand');
	const blobOf = async (text: string) => (await git(['hash-object', '-w', '--stdin'], dir, { stdin: text })).stdout.trim();
	const { landed } = await landTurnFiles(dir, { computer: 'pc-1', session: 's-1', turn: 'turn-1' }, [
		{ path: LOOK, mode: '100644', blob: await blobOf('two') },
		{ path: RECEIPT, mode: '100644', blob: await blobOf('{"paid_call_id":"call-0002"}') },
	], false, {});
	assert.deepEqual(landed, []);
	assert.equal(readFileSync(join(dir, RECEIPT), 'utf8'), '{"paid_call_id":"call-0001"}');
	assert.equal((await git(['diff', '--cached', '--name-only'], dir)).stdout.trim(), '');
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

test('a path the folder will not take (a read-only folder) is left out with why, and the rest of the turn lands', async () => {
	const dir = project();
	await person(dir, { 'locked/old.txt': 'the person\'s', [LOOK]: 'one' });
	chmodSync(join(dir, 'locked'), 0o555);
	try {
		const blobOf = async (text: string) => (await git(['hash-object', '-w', '--stdin'], dir, { stdin: text })).stdout.trim();
		const { landed, leftOut } = await landTurnFiles(dir, { computer: 'pc-1', session: 's-1', turn: 'turn-1' }, [
			{ path: 'locked/new.txt', mode: '100644', blob: await blobOf('not allowed') },
			{ path: 'locked/old.txt', mode: '100644', blob: null },
			{ path: LOOK, mode: '100644', blob: await blobOf('two') },
		], true, {});
		assert.deepEqual(landed, [LOOK]);
		assert.deepEqual(Object.fromEntries(leftOut), { 'locked/new.txt': 'not allowed to write there', 'locked/old.txt': 'not allowed to write there' });
		assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'two');
		assert.equal(readFileSync(join(dir, 'locked/old.txt'), 'utf8'), 'the person\'s');
	} finally {
		chmodSync(join(dir, 'locked'), 0o755);
	}
});

// Codex's production review, item A8: a card action wrote over a hand edit the person had saved but no commit held,
// so history went A → C and B was lost.
test("a person's change first records the hand edit it writes over, so history keeps it", async () => {
	const dir = project();
	const prompt = 'assets/characters/lin/prompt.md';
	await person(dir, { [prompt]: 'A' });
	writeFileSync(join(dir, prompt), 'B');
	await person(dir, { [prompt]: 'C' });
	const shown = (await out(dir, 'log', '--format=%an %s', '--', prompt)).split('\n');
	assert.deepEqual(shown.map(line => line.split(' ')[0]), ['person', 'client-found-changes-on-disk', 'person']);
	assert.equal(await out(dir, 'show', `HEAD~1:${prompt}`), 'B');
	assert.equal(readFileSync(join(dir, prompt), 'utf8'), 'C');
});

// The flexibility cuts, item 17: a receipt that could not be written was left out, and its output still landed, so the
// project held an output with no receipt, or with an older one's (doc/protocol.md 2.3: a receipt goes with its output).
test('an output whose receipt cannot be written is left out with it, and the rest of the turn lands', async () => {
	const dir = project();
	await person(dir, { [LOOK]: 'one', 'notes.txt': 'old' });
	mkdirSync(join(dir, RECEIPT), { recursive: true });
	writeFileSync(join(dir, RECEIPT, 'in the way'), 'a folder where the receipt goes');
	const blobOf = async (text: string) => (await git(['hash-object', '-w', '--stdin'], dir, { stdin: text })).stdout.trim();
	const { landed, leftOut } = await landTurnFiles(dir, { computer: 'pc-1', session: 's-1', turn: 'turn-1' }, [
		{ path: LOOK, mode: '100644', blob: await blobOf('two') },
		{ path: RECEIPT, mode: '100644', blob: await blobOf('{"paid_call_id":"call-0002"}') },
		{ path: 'notes.txt', mode: '100644', blob: await blobOf('new') },
	], true, {});
	assert.deepEqual(landed, ['notes.txt']);
	assert.deepEqual(Object.fromEntries(leftOut), { [RECEIPT]: 'in the way of a folder or a file', [LOOK]: 'its receipt was left out' });
	assert.equal(readFileSync(join(dir, LOOK), 'utf8'), 'one');
});
