import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { git } from '../core/git';
import { writeWhole } from '../core/placement';
import { sha256 } from '../core/sha256';
import { collectTurn, listComputerFiles, putTurnFiles, turnRecordOf, type ComputerSession } from '../core/turn';
import { FakePine } from './fakePine';

// A turn on the Studio's side (core/turn.ts): the drama's folder on a fake Computer whose working directory is a real
// folder, where the Studio's commands run in bash. The rules that, broken, would start the agent on a folder that is
// not the project as recorded, land what the agent did not change, miss what it did, or land one turn twice.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'project-v2', 'full');
const ENV = { endpoint: 'http://pine.invalid', apiKey: 'k' };

/** A project copied from the fixture, and a session on a fake Computer, with the drama's folder in its working directory. */
async function place(): Promise<{ root: string; at: ComputerSession & { readonly pine: FakePine }; drama: string }> {
	const root = mkdtempSync(join(tmpdir(), 'turn-project-'));
	cpSync(FIXTURE, root, { recursive: true });
	const pine = new FakePine();
	const { serialized } = await pine.newCredentials();
	const { binding } = await pine.ensureComputer(ENV, serialized, 'test', 60);
	const created = await pine.createSession(ENV, serialized, binding);
	return { root, at: { pine, port: pine, env: ENV, session: { credentials: serialized, binding, ...created } }, drama: join(created.workdir, 'drama') };
}

/** What the agent does in the drama's folder: writes each file, or deletes it for null. */
function agent(drama: string, files: Record<string, string | Buffer | null>): void {
	for (const [path, content] of Object.entries(files)) {
		if (content === null) { rmSync(join(drama, path)); continue; }
		mkdirSync(dirname(join(drama, path)), { recursive: true });
		writeFileSync(join(drama, path), content);
	}
}

const head = async (root: string) => (await git(['rev-parse', 'HEAD'], root)).stdout.trim();

test('before the agent runs, the drama\'s folder holds every file of the project as its history records it, hidden ones aside, and only what differs moves', async () => {
	const { root, at, drama } = await place();
	writeFileSync(join(root, 'inputs-brief.md'), 'a brief written by hand');
	writeFileSync(join(root, '.notes'), 'hidden');
	// An extended attribute, the way each OS sets one (Windows has none to set): the archive is node-tar's portable one,
	// which carries no AppleDouble `._` member and no attribute, so each file extracts as itself alone.
	const look = join(root, 'assets/characters/lin/look.png');
	if (process.platform === 'linux') { execFileSync('python3', ['-c', 'import os, sys; os.setxattr(sys.argv[1], "user.pine.test", b"1")', look]); }
	if (process.platform === 'darwin') { execFileSync('xattr', ['-w', 'user.pine.test', '1', look]); }
	const first = await putTurnFiles(at, root, 'turn-1');
	const extracted = readdirSync(drama, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(drama.length + 1));
	assert.deepEqual(extracted.sort(), Object.keys(first.before).sort(), 'exactly the project\'s files, no ._ member, nothing hidden');
	assert.equal((await git(['status', '--porcelain', '--', 'inputs-brief.md'], root)).stdout, '', 'a hand edit is recorded first');
	const files = (await git(['ls-tree', '-r', '--name-only', 'HEAD'], root)).stdout.trim().split('\n').filter(path => !path.startsWith('.'));
	assert.deepEqual(Object.keys(first.before).sort(), files.sort(), 'every file of HEAD but a hidden one');
	for (const path of files) { assert.equal(first.before[path], sha256(readFileSync(join(root, path))), path); }
	assert.equal(readFileSync(join(drama, 'assets/characters/lin/look.png')).equals(readFileSync(join(root, 'assets/characters/lin/look.png'))), true);
	assert.equal(existsSync(join(drama, '.notes')), false);
	assert.deepEqual(readdirSync(join(drama, '..', 'attachments')), [], 'the parts are gone once extracted');
	// The agent's own edit and a file of its own, then the person's edit: the next turn puts back only what differs.
	agent(drama, { 'assets/props/umbrella/description.md': 'the agent\'s, not landed', 'scratch.txt': 'the agent\'s own' });
	writeFileSync(join(root, 'inputs-brief.md'), 'the brief, changed');
	rmSync(join(root, 'assets/scenes/street/prompt.md'));
	const second = await putTurnFiles(at, root, 'turn-2');
	assert.deepEqual([second.put, second.removed], [2, 2], 'the brief and the description go up; the deleted prompt and the agent\'s own file go');
	assert.equal(readFileSync(join(drama, 'assets/props/umbrella/description.md'), 'utf8'), readFileSync(join(root, 'assets/props/umbrella/description.md'), 'utf8'));
	assert.deepEqual([existsSync(join(drama, 'scratch.txt')), existsSync(join(drama, 'assets/scenes/street/prompt.md'))], [false, false]);
	assert.ok(at.pine.commands.every(({ command }) => command.startsWith('( ') && command.endsWith(' )')), 'every command runs in a subshell');
	const third = await putTurnFiles(at, root, 'turn-3');
	assert.deepEqual([third.put, third.removed], [0, 0], 'nothing moves when nothing differs');
	// What the agent's tools keep under dot names (locks, temporary files), at any depth, is no file of the drama: never
	// listed, so never put over or deleted.
	const dotted = ['.drama-cli.lock', 'assets/.publication.lock', 'assets/props/umbrella/.image-1.part.bin', '.cache/deep/file'];
	agent(drama, Object.fromEntries(dotted.map(path => [path, 'the agent\'s'])));
	assert.deepEqual(Object.keys(await listComputerFiles(at)).filter(path => dotted.includes(path)), [], 'not listed');
	writeFileSync(join(root, 'inputs-brief.md'), 'the brief, changed again');
	const fourth = await putTurnFiles(at, root, 'turn-4');
	assert.deepEqual([fourth.put, fourth.removed], [1, 0]);
	assert.deepEqual(dotted.map(path => readFileSync(join(drama, path), 'utf8')), dotted.map(() => 'the agent\'s'), 'left as they were');
	// A file of the agent's where the project has a folder of that name goes first, so the folder's files can go in.
	agent(drama, { references: 'the agent\'s file' });
	mkdirSync(join(root, 'references'));
	writeFileSync(join(root, 'references/a.txt'), 'the person\'s');
	await putTurnFiles(at, root, 'turn-5');
	assert.equal(readFileSync(join(drama, 'references/a.txt'), 'utf8'), 'the person\'s');
});

test('a put larger than one attachment goes up in parts, and names that start with @ or - or hold quotes go up and come back', async () => {
	const { root, at, drama } = await place();
	// Over write_file's 64 MiB, so the put is two parts.
	const big = Buffer.alloc(65 * 1024 * 1024, 7);
	const odd = { 'assets/props/umbrella/big.bin': big, '@at.txt': 'at', '-dash.txt': 'dash', 'it\'s "a" take.txt': 'quoted' };
	for (const [path, content] of Object.entries(odd)) { writeFileSync(join(root, path), content); }
	await putTurnFiles(at, root, 'turn-1');
	assert.equal(at.pine.calls.writeFile, 2, 'two parts');
	for (const [path, content] of Object.entries(odd)) { assert.ok(readFileSync(join(drama, path)).equals(Buffer.from(content)), path); }
	const before = await listComputerFiles(at);
	agent(drama, { '@at.txt': 'at, redone', '-dash.txt': 'dash, redone', 'it\'s "a" take.txt': 'quoted, redone' });
	await collectTurn(at, root, 'turn-1', before);
	assert.deepEqual(['@at.txt', '-dash.txt', 'it\'s "a" take.txt'].map(path => readFileSync(join(root, path), 'utf8')), ['at, redone', 'dash, redone', 'quoted, redone']);
});

test('at the turn\'s end what the agent changed lands as one pine-computer commit with the turn\'s trailer, deletions too, and landing it again is a no-op', async () => {
	const { root, at, drama } = await place();
	const { before } = await putTurnFiles(at, root, 'turn-1');
	agent(drama, {
		'assets/props/umbrella/description.md': 'A red umbrella.', 'assets/props/cup/object.json': '{"schema":2,"type":"prop","name":"Cup","shown_file":null}',
		'assets/scenes/street/prompt.md': null, '.cache/scratch': 'hidden, the agent\'s own',
	});
	const collected = await collectTurn(at, root, 'turn-1', before);
	assert.deepEqual([...collected.files].sort(), ['assets/props/cup/object.json', 'assets/props/umbrella/description.md', 'assets/scenes/street/prompt.md']);
	assert.equal(readFileSync(join(root, 'assets/props/umbrella/description.md'), 'utf8'), 'A red umbrella.');
	assert.equal(existsSync(join(root, 'assets/scenes/street/prompt.md')), false);
	assert.equal(existsSync(join(root, '.cache')), false, 'a hidden file is not the drama\'s');
	assert.equal((await git(['log', '-1', '--format=%an|%(trailers:key=Pine-Turn-Id,valueonly,separator=)'], root)).stdout.trim(), 'pine-computer|turn-1');
	assert.deepEqual((await git(['show', '--name-only', '--format=', 'HEAD'], root)).stdout.trim().split('\n').sort(), [...collected.files].sort(), 'one commit of exactly its paths');
	const landed = await head(root);
	await collectTurn(at, root, 'turn-1', before);
	assert.equal(await head(root), landed, 'collected again, nothing more is committed');
	assert.equal(readdirSync(join(drama, '..')).includes('pine-drama-get.tar'), false, 'the tar it read is gone');
});

test('a file the agent hard-linked lands whole under both names, and a deleted file named like an object property is deleted', async () => {
	const { root, at, drama } = await place();
	writeFileSync(join(root, 'constructor'), 'a file of the project');
	const { before } = await putTurnFiles(at, root, 'turn-1');
	agent(drama, { 'assets/props/umbrella/picture.png': 'redrawn', constructor: null });
	linkSync(join(drama, 'assets/props/umbrella/picture.png'), join(drama, 'assets/props/umbrella/copy.png'));
	const collected = await collectTurn(at, root, 'turn-1', before);
	assert.deepEqual([...collected.files].sort(), ['assets/props/umbrella/copy.png', 'assets/props/umbrella/picture.png', 'constructor']);
	assert.deepEqual(['picture.png', 'copy.png'].map(name => readFileSync(join(root, 'assets/props/umbrella', name), 'utf8')), ['redrawn', 'redrawn']);
	assert.equal(existsSync(join(root, 'constructor')), false);
});

test('an entry of the Computer\'s tar that was not asked for is not read, and the asked ones land', async () => {
	const { root, at, drama } = await place();
	const { before } = await putTurnFiles(at, root, 'turn-1');
	agent(drama, { 'assets/props/umbrella/description.md': 'A red umbrella.' });
	// The Computer's tar, as the Computer may make it: an entry the Studio did not ask for, and one named outside drama/.
	const port = Object.create(at.pine) as FakePine;
	port.exec = async (env, session, command, signal) => {
		const out = await at.pine.exec(env, session, command, signal);
		if (command.includes('-cf ../pine-drama-get.tar')) {
			await at.pine.exec(env, session, `( printf x > extra.txt && tar -rf pine-drama-get.tar extra.txt && tar -P -rf pine-drama-get.tar --transform 's,^,../,' extra.txt )`, signal);
		}
		return out;
	};
	const collected = await collectTurn({ ...at, port }, root, 'turn-1', before);
	assert.deepEqual([collected.files, [...collected.unasked].sort()], [['assets/props/umbrella/description.md'], ['../extra.txt', 'extra.txt']]);
	assert.deepEqual([existsSync(join(root, 'extra.txt')), existsSync(join(root, '..', 'extra.txt'))], [false, false]);
	assert.equal(readFileSync(join(root, 'assets/props/umbrella/description.md'), 'utf8'), 'A red umbrella.');
});

test('a turn whose agent changed nothing lands nothing, and a name that is no path of the project stays on the Computer, said', async () => {
	const { root, at, drama } = await place();
	const { before } = await putTurnFiles(at, root, 'turn-1');
	const recorded = await head(root);
	assert.deepEqual(await collectTurn(at, root, 'turn-1', before), { files: [], notPaths: [], unasked: [] });
	assert.equal(await head(root), recorded);
	agent(drama, { 'assets/props/umbrella/description.md': 'A red umbrella.', 'assets/CON': 'a Windows reserved name' });
	const collected = await collectTurn(at, root, 'turn-2', before);
	assert.deepEqual([collected.files, collected.notPaths], [['assets/props/umbrella/description.md'], ['assets/CON']]);
	assert.equal(existsSync(join(root, 'assets/CON')), false);
});

test('the turn record keeps each turn as sent, with the folder its agent found, until it is settled', async () => {
	const storage = mkdtempSync(join(tmpdir(), 'turn-storage-'));
	const record = turnRecordOf(storage, mkdtempSync(join(tmpdir(), 'turn-project-')));
	await record.send('turn-1', 'main', 's-1', { 'a.txt': sha256('a') }, new Date('2026-11-15T10:00:00Z'));
	await record.send('turn-2', 'main', 's-1', {}, new Date('2026-11-15T10:01:00Z'));
	assert.deepEqual(record.unsettled('main').map(t => t.turn), ['turn-1', 'turn-2']);
	assert.deepEqual(record.sentTurn('turn-1')?.before, { 'a.txt': sha256('a') });
	await record.settle('turn-1', { files: ['a.txt'] });
	assert.deepEqual([record.unsettled('main').map(t => t.turn), record.latestSettled('main')?.turn, record.settled('turn-1')?.files], [['turn-2'], 'turn-1', ['a.txt']]);
});

// B9: two sessions recording at once write in one folder at the same moment. Each write's temporary file must be its
// own: when two shared a name, one rename found the file gone ("ENOENT … .<pid>.<ms>.tmp") and the other could put one
// write's bytes under the other's name.
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
});
