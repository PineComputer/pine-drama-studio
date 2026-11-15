import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { git } from '../core/git';
import { commitFilesFoundOnDisk, commitPathsToHistory, commitSnapshotOfIndex, runInProjectWriteQueue } from '../core/projectHistory';

const project = () => mkdtempSync(join(tmpdir(), 'pine-history-'));
const LIN = 'assets/characters/lin';
/** The person's description of Lin, written and committed as theirs (doc/protocol.md, section 3). */
const describe = (dir: string, text: string) => runInProjectWriteQueue(dir, async () => {
	mkdirSync(join(dir, LIN), { recursive: true });
	await writeFile(join(dir, LIN, 'description.md'), text);
	await commitPathsToHistory(dir, 'person', [`${LIN}/description.md`], 'Description of Lin');
});
const out = async (dir: string, ...args: string[]) => {
	const result = await git(args, dir);
	assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
};
/** Each commit, newest first: author, subject and the files it changed. */
const commits = async (dir: string) => (await out(dir, 'log', '--format=%x00%an|%s', '--name-only')).split('\0').filter(Boolean)
	.map(entry => { const [head, ...files] = entry.trim().split('\n').filter(Boolean); return { head, files: files.sort() }; });

test("the person's change is committed as theirs with the paths it wrote, and nothing someone else changed", async () => {
	const dir = project();
	writeFileSync(join(dir, 'notes.txt'), 'changed by hand\n');
	await describe(dir, 'Tall, in a grey coat.');
	const [only] = await commits(dir);
	assert.equal(only.head, 'person|Description of Lin');
	assert.deepEqual(only.files, [`${LIN}/description.md`]);
	// The hand edit is still uncommitted: it is recorded by whoever commits it, here the next opening (client-found-changes-on-disk).
	assert.equal(await out(dir, 'status', '--porcelain', '--', 'notes.txt'), '?? notes.txt');
	assert.match(readFileSync(join(dir, '.git', 'info', 'attributes'), 'utf8'), /^\* -text -filter -ident -working-tree-encoding$/m);
	assert.deepEqual(readdirSync(dir).sort(), ['.git', 'assets', 'notes.txt'], 'nothing of the Studio\'s in the person\'s folder');
});

test('opening commits what no commit recorded as found on disk, and commits nothing when there is nothing new', async () => {
	const dir = project();
	await describe(dir, 'Tall.');
	writeFileSync(join(dir, 'notes.txt'), 'changed by hand\n');
	await commitFilesFoundOnDisk(dir, 'Changes found on disk when the project opened');
	await commitFilesFoundOnDisk(dir, 'Changes found on disk when the project opened');
	const all = await commits(dir);
	assert.equal(all.length, 2);
	assert.equal(all[0].head, 'client-found-changes-on-disk|Changes found on disk when the project opened');
	assert.deepEqual(all[0].files, ['notes.txt']);
	assert.equal(await out(dir, 'status', '--porcelain'), '');
});

test('changes to one folder are committed one after another, in the order they were made', async () => {
	const dir = project();
	await Promise.all(['one', 'two', 'three'].map(text => describe(dir, text)));
	assert.equal((await commits(dir)).length, 3);
	assert.equal(readFileSync(join(dir, LIN, 'description.md'), 'utf8'), 'three', 'the last change made is the last written');
	assert.equal(await out(dir, 'show', 'HEAD~2:assets/characters/lin/description.md'), 'one');
});

test("the person's own git setup changes nothing: no signing, no hooks, no identity of theirs", async () => {
	const home = project();
	writeFileSync(join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[user]\n\tname = Someone Else\n');
	const saved = process.env.HOME;
	process.env.HOME = home;
	try {
		const dir = project();
		await describe(dir, 'Tall.');
		for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
			writeFileSync(join(dir, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
		}
		await describe(dir, 'Taller.');
		assert.equal((await commits(dir)).length, 2);
		assert.equal(await out(dir, 'log', '-1', '--format=%an %ae'), 'person person@pine-drama.invalid');
	} finally {
		if (saved === undefined) { delete process.env.HOME; } else { process.env.HOME = saved; }
	}
});

test('a folder that is already a repository keeps its own attributes and ignore files', async () => {
	const dir = project();
	await out(dir, 'init', '-q');
	writeFileSync(join(dir, '.gitignore'), 'mine\n');
	await describe(dir, 'Tall.');
	assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'mine\n');
	assert.equal(existsSync(join(dir, '.gitattributes')), false);
});

test('the folder\'s own repository is committed to whatever the environment names, and paths are names, not patterns', async () => {
	const elsewhere = project();
	await out(elsewhere, 'init', '-q');
	const dir = project();
	const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
	process.env.GIT_DIR = join(elsewhere, '.git');
	process.env.GIT_WORK_TREE = elsewhere;
	try {
		writeFileSync(join(dir, 'notes1.txt'), 'changed by hand\n');
		await runInProjectWriteQueue(dir, async () => {
			await writeFile(join(dir, 'notes[1].txt'), 'the person\'s');
			await commitPathsToHistory(dir, 'person', ['notes[1].txt'], 'A note');
		});
	} finally {
		for (const [name, value] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.tree]] as const) {
			if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
		}
	}
	const [only] = await commits(dir);
	assert.deepEqual(only.files, ['notes[1].txt'], 'notes1.txt is not "notes[1].txt"');
	assert.equal((await git(['rev-parse', '--verify', '-q', 'HEAD'], elsewhere)).exitCode, 1, 'nothing was committed in the other repository');
});

test('a new repository keeps every byte whatever the folder\'s .gitattributes says, and commits a path the folder ignores', async () => {
	const dir = project();
	writeFileSync(join(dir, '.gitattributes'), '* text eol=lf ident\n');
	writeFileSync(join(dir, '.gitignore'), 'description.md\n');
	writeFileSync(join(dir, 'screenplay.fountain'), 'INT. ROOM\r\nLin waits. $Id: by hand $\r\n');
	await describe(dir, 'Tall.\r\n');
	await commitFilesFoundOnDisk(dir, 'Changes found on disk when the project opened');
	assert.equal(await out(dir, 'show', `HEAD~1:${LIN}/description.md`), 'Tall.', 'the ignored description is committed');
	const blob = await git(['cat-file', 'blob', 'HEAD:screenplay.fountain'], dir);
	assert.equal(blob.stdout, 'INT. ROOM\r\nLin waits. $Id: by hand $\r\n', 'CRLF and $Id$ are kept as written');
	assert.equal(readFileSync(join(dir, '.gitattributes'), 'utf8'), '* text eol=lf ident\n', 'the folder\'s own file is not rewritten');
});

test('a deletion a cut-off commit left staged is still committed by the next commit of its path', async () => {
	const dir = project();
	await describe(dir, 'Tall.');
	rmSync(join(dir, LIN, 'description.md'));
	await out(dir, 'add', '-A', '--', LIN);
	await runInProjectWriteQueue(dir, () => commitPathsToHistory(dir, 'person', [`${LIN}/description.md`], 'Delete Lin'));
	const [last] = await commits(dir);
	assert.deepEqual([last.head, last.files], ['person|Delete Lin', [`${LIN}/description.md`]]);
});

// #210: git commit --only refuses a path that changed from a file to a folder ("updating files failed"), so the
// person's change or a hand edit that swapped them could never be committed.
test("the person's change commits a file and a folder that changed places, either way", async () => {
	const dir = project();
	writeFileSync(join(dir, 'notes'), 'a file\n');
	await runInProjectWriteQueue(dir, () => commitPathsToHistory(dir, 'person', ['notes'], 'A file'));
	rmSync(join(dir, 'notes'));
	mkdirSync(join(dir, 'notes'));
	writeFileSync(join(dir, 'notes', 'a.txt'), 'in a folder\n');
	await runInProjectWriteQueue(dir, () => commitPathsToHistory(dir, 'person', ['notes'], 'A folder'));
	assert.deepEqual((await commits(dir))[0], { head: 'person|A folder', files: ['notes', 'notes/a.txt'] });
	rmSync(join(dir, 'notes'), { recursive: true });
	writeFileSync(join(dir, 'notes'), 'a file again\n');
	await runInProjectWriteQueue(dir, () => commitPathsToHistory(dir, 'person', ['notes'], 'A file again'));
	assert.deepEqual((await commits(dir))[0], { head: 'person|A file again', files: ['notes', 'notes/a.txt'] });
	assert.equal(await out(dir, 'status', '--porcelain'), '');
});

// Codex's production review, item A4: a running turn's results are written into the folder and staged, not committed.
// A put that snapshotted HEAD sent another chat the files from before them, which the person no longer saw.
test('a put\'s snapshot holds what the index holds, what the person staged included, and no hidden path', async () => {
	const dir = project();
	await commitPathsToHistory(dir, 'person', [], 'empty');
	writeFileSync(join(dir, 'old.txt'), 'committed\n');
	await commitPathsToHistory(dir, 'person', ['old.txt'], 'old');
	writeFileSync(join(dir, 'look.png'), 'staged by the person\n');
	writeFileSync(join(dir, '.hidden'), 'never sent\n');
	await out(dir, 'add', '--force', 'look.png', '.hidden');
	const seed = await commitSnapshotOfIndex(dir, 'refs/pine-drama/put/test', null, 'snapshot');
	assert.deepEqual((await out(dir, 'ls-tree', '-r', '--name-only', seed)).split('\n').sort(), ['look.png', 'old.txt']);
	assert.equal(await out(dir, 'show', `${seed}:look.png`), 'staged by the person');
});
