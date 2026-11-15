import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { git } from '../core/git';
import { writeWhole } from '../core/placement';
import { collectTurn, putTurnFiles, turnRecordOf, type ComputerSession } from '../core/turn';
import { FakePine } from './fakePine';

// A turn on the Studio's side (core/turn.ts), git on both sides: the drama's folder on a fake Computer whose working
// directory is a real folder, where the Studio's commands, git among them, run in bash. The rules that, broken, would
// start the agent on a folder that is not the project as recorded, send history up, land what the agent did not
// change, miss what it did, let one odd name hold up a whole turn, or land one turn twice.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'project-v2', 'full');
const ENV = { endpoint: 'http://pine.invalid', apiKey: 'k' };

/** A project copied from the fixture, and a session on a fake Computer, with the drama's folder in its working directory. */
async function place(): Promise<{ root: string; at: ComputerSession & { readonly pine: FakePine }; drama: string; workdir: string }> {
	const root = mkdtempSync(join(tmpdir(), 'turn-project-'));
	cpSync(FIXTURE, root, { recursive: true });
	const pine = new FakePine();
	const { serialized } = await pine.newCredentials();
	const { binding } = await pine.ensureComputer(ENV, serialized, 'test', 60);
	const created = await pine.createSession(ENV, serialized, binding);
	return { root, at: { pine, port: pine, env: ENV, session: { credentials: serialized, binding, ...created } }, drama: join(created.workdir, 'drama'), workdir: created.workdir };
}

/** What the agent does in the drama's folder: writes each file, or deletes it for null. */
function agent(drama: string, files: Record<string, string | Buffer | null>): void {
	for (const [path, content] of Object.entries(files)) {
		if (content === null) { rmSync(join(drama, path), { recursive: true }); continue; }
		mkdirSync(dirname(join(drama, path)), { recursive: true });
		writeFileSync(join(drama, path), content);
	}
}

const out = async (root: string, ...args: string[]) => (await git(args, root)).stdout.trim();
/** Every file under `dir`, by its path there. */
const filesUnder = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
/** The project's tracked files but hidden ones: what a put sends. */
const projectFiles = async (root: string) => (await out(root, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').filter(path => !path.split('/').some(part => part.startsWith('.'))).sort();
const ids = (at: ComputerSession, turn: string) => ({ computer: 'pc-1', session: at.session.name, turn });

test('before the agent runs, the drama\'s folder is the project as its history records it, hidden files and links aside, and later puts send only what the Computer lacks', async () => {
	const { root, at, drama } = await place();
	writeFileSync(join(root, 'inputs-brief.md'), 'a brief written by hand');
	writeFileSync(join(root, '.notes'), 'hidden');
	symlinkSync('assets', join(root, 'a-link'));
	// An extended attribute, the way each OS sets one: git keeps none, so each file arrives as itself alone.
	const look = join(root, 'assets/characters/lin/look.png');
	if (process.platform === 'linux') { execFileSync('python3', ['-c', 'import os, sys; os.setxattr(sys.argv[1], "user.pine.test", b"1")', look]); }
	if (process.platform === 'darwin') { execFileSync('xattr', ['-w', 'user.pine.test', '1', look]); }
	const first = await putTurnFiles(at, root, 'turn-1');
	assert.equal(await out(root, 'status', '--porcelain', '--', 'inputs-brief.md'), '', 'a hand edit is recorded first');
	assert.deepEqual(filesUnder(drama), (await projectFiles(root)).filter(path => path !== 'a-link'), 'exactly the project\'s files: no hidden one, no link');
	assert.ok(readFileSync(join(drama, 'assets/characters/lin/look.png')).equals(readFileSync(look)));
	assert.equal(await out(root, 'rev-list', '--count', first.seed), '1', 'the first put has no parent: no history goes up');
	assert.deepEqual(readdirSync(join(drama, '..', 'attachments')), [], 'the parts are gone once fetched');
	assert.ok(at.pine.commands.every(({ command }) => command.startsWith('( ') && command.endsWith(' )')), 'every command runs in a subshell');
	// The agent's lock files; then the person changes one file and deletes another.
	agent(drama, { '.drama-cli.lock': 'the agent\'s', 'assets/.image-1.part.bin': 'the agent\'s' });
	writeFileSync(join(root, 'inputs-brief.md'), 'the brief, changed');
	rmSync(join(root, 'assets/scenes/street/prompt.md'));
	const writes = at.pine.calls.writeFile ?? 0;
	const second = await putTurnFiles(at, root, 'turn-2');
	assert.equal(await out(root, 'rev-parse', `${second.seed}^`), first.seed, 'a child of what the Computer holds');
	assert.equal(at.pine.calls.writeFile, writes + 1, 'one small part');
	assert.equal(readFileSync(join(drama, 'inputs-brief.md'), 'utf8'), 'the brief, changed');
	assert.equal(existsSync(join(drama, 'assets/scenes/street/prompt.md')), false);
	assert.deepEqual(['.drama-cli.lock', 'assets/.image-1.part.bin'].map(path => readFileSync(join(drama, path), 'utf8')), ['the agent\'s', 'the agent\'s'], 'names starting with "." stay');
	// A project folder that becomes a file of the same name, and back.
	mkdirSync(join(root, 'references'));
	writeFileSync(join(root, 'references/a.txt'), 'in a folder');
	await putTurnFiles(at, root, 'turn-3');
	rmSync(join(root, 'references'), { recursive: true });
	writeFileSync(join(root, 'references'), 'a file');
	await putTurnFiles(at, root, 'turn-4');
	assert.equal(readFileSync(join(drama, 'references'), 'utf8'), 'a file');
});

test('a Computer that lost the harness\'s repository gets a whole snapshot again, with no history', async () => {
	const { root, at, drama, workdir } = await place();
	await putTurnFiles(at, root, 'turn-1');
	rmSync(join(workdir, 'pine-drama.git'), { recursive: true });
	agent(drama, { 'stale.txt': 'left from before', '.drama-cli.lock': 'the agent\'s' });
	const again = await putTurnFiles(at, root, 'turn-2');
	assert.equal(await out(root, 'rev-list', '--count', again.seed), '1');
	assert.deepEqual(filesUnder(drama), [...await projectFiles(root), '.drama-cli.lock'].sort(), 'a file the snapshot lacks goes; a name starting with "." stays');
});

test('a put larger than one attachment goes up in parts; big media, a deletion, a hard link and a file that becomes a folder land as one pine-computer commit with Pine\'s ids', async () => {
	const { root, at, drama } = await place();
	// Over write_file's 64 MiB once bundled: bytes that do not compress.
	writeFileSync(join(root, 'assets/props/umbrella/big.bin'), randomBytes(65 * 1024 * 1024));
	writeFileSync(join(root, 'episodes/EP001/segments/seg01/take.mp4'), randomBytes(5 * 1024 * 1024));
	await putTurnFiles(at, root, 'turn-1');
	assert.equal(at.pine.calls.writeFile, 2, 'two parts');
	const picture = randomBytes(3 * 1024 * 1024);
	agent(drama, {
		'assets/characters/lin/look.png': picture, 'episodes/EP001/segments/seg01/take.mp4': null,
		'assets/scenes/street/prompt.md': null, 'assets/scenes/street/prompt.md/take-1.md': 'now a folder', '.cache/scratch': 'the agent\'s own',
	});
	linkSync(join(drama, 'assets/characters/lin/look.png'), join(drama, 'assets/characters/lin/copy.png'));
	const collected = await collectTurn(at, root, ids(at, 'turn-1'));
	assert.deepEqual([...collected.files].sort(), ['assets/characters/lin/copy.png', 'assets/characters/lin/look.png', 'assets/scenes/street/prompt.md', 'assets/scenes/street/prompt.md/take-1.md', 'episodes/EP001/segments/seg01/take.mp4']);
	assert.deepEqual(['look.png', 'copy.png'].map(name => readFileSync(join(root, 'assets/characters/lin', name)).equals(picture)), [true, true]);
	assert.equal(existsSync(join(root, 'episodes/EP001/segments/seg01/take.mp4')), false);
	assert.equal(readFileSync(join(root, 'assets/scenes/street/prompt.md/take-1.md'), 'utf8'), 'now a folder');
	assert.equal(existsSync(join(root, '.cache')), false, 'a hidden file is not the drama\'s');
	assert.equal(await out(root, 'log', '-1', '--format=%an|%s|%(trailers:key=Pine-Computer-Id,valueonly,separator=)|%(trailers:key=Pine-Session-Id,valueonly,separator=)|%(trailers:key=Pine-Turn-Id,valueonly,separator=)'),
		`pine-computer|Turn turn-1|pc-1|${at.session.name}|turn-1`);
	assert.deepEqual((await out(root, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(), [...collected.files].sort(), 'one commit of exactly its paths');
	assert.equal(await out(root, 'status', '--porcelain'), '', 'the folder, the index and HEAD agree');
	const landed = await out(root, 'rev-parse', 'HEAD');
	assert.deepEqual(await collectTurn(at, root, ids(at, 'turn-1')), { files: [], leftOut: new Map() }, 'collected again, nothing is left to land');
	assert.equal(await out(root, 'rev-parse', 'HEAD'), landed, 'and nothing more is committed');
	// And back: the agent turns the folder into a file again.
	await putTurnFiles(at, root, 'turn-2');
	agent(drama, { 'assets/scenes/street/prompt.md': null });
	agent(drama, { 'assets/scenes/street/prompt.md': 'a file again' });
	await collectTurn(at, root, ids(at, 'turn-2'));
	assert.equal(readFileSync(join(root, 'assets/scenes/street/prompt.md'), 'utf8'), 'a file again');
	assert.equal(readdirSync(dirname(drama)).some(name => name.endsWith('.bundle')), false, 'no bundle is left on the Computer');
});

test('the agent\'s own .gitignore hides nothing it made, and a hand edit made during the turn is kept in history before the result replaces it', async () => {
	const { root, at, drama } = await place();
	await putTurnFiles(at, root, 'turn-1');
	agent(drama, { '.gitignore': '*.mp4\n', 'episodes/EP001/segments/seg02/take.mp4': 'a new take', 'assets/props/umbrella/description.md': 'the agent\'s' });
	writeFileSync(join(root, 'assets/props/umbrella/description.md'), 'the person\'s, by hand');
	const collected = await collectTurn(at, root, ids(at, 'turn-1'));
	assert.deepEqual([...collected.files].sort(), ['assets/props/umbrella/description.md', 'episodes/EP001/segments/seg02/take.mp4']);
	assert.equal(existsSync(join(root, '.gitignore')), false);
	assert.deepEqual((await out(root, 'log', '-2', '--format=%an', '--', 'assets/props/umbrella/description.md')).split('\n'), ['pine-computer', 'client-found-changes-on-disk']);
	assert.equal(await out(root, 'show', 'HEAD~1:assets/props/umbrella/description.md'), 'the person\'s, by hand');
});

test('a turn whose agent changed nothing makes no commit on either side', async () => {
	const { root, at, workdir } = await place();
	await putTurnFiles(at, root, 'turn-1');
	const head = await out(root, 'rev-parse', 'HEAD');
	assert.deepEqual(await collectTurn(at, root, ids(at, 'turn-1')), { files: [], leftOut: new Map() });
	assert.equal(await out(root, 'rev-parse', 'HEAD'), head);
	assert.equal((await git(['--git-dir', join(workdir, 'pine-drama.git'), 'rev-parse', '--verify', '-q', 'refs/heads/turn'], workdir)).exitCode, 1, 'no capture on the Computer either');
});

test('a path the project cannot hold is left out, with why, and the rest of the turn lands', async () => {
	const { root, at, drama } = await place();
	await putTurnFiles(at, root, 'turn-1');
	agent(drama, {
		'assets/props/umbrella/description.md': 'A red umbrella.', 'notes/A.txt': 'upper', 'notes/a.txt': 'lower', 'assets/CON': 'a Windows reserved name',
		'assets/characters/lin/Look.png': 'the same name as look.png but for case',
	});
	symlinkSync('/etc/passwd', join(drama, 'assets/passwd'));
	const collected = await collectTurn(at, root, ids(at, 'turn-1'));
	assert.deepEqual(collected.files, ['assets/props/umbrella/description.md']);
	assert.deepEqual(Object.fromEntries(collected.leftOut), {
		'assets/CON': 'no path of the project', 'assets/passwd': 'a link', 'assets/characters/lin/Look.png': 'the same name as another but for case',
		'notes/A.txt': 'the same name as another but for case', 'notes/a.txt': 'the same name as another but for case',
	});
	assert.equal(readFileSync(join(root, 'assets/props/umbrella/description.md'), 'utf8'), 'A red umbrella.');
	assert.deepEqual([existsSync(join(root, 'notes')), existsSync(join(root, 'assets/passwd')), existsSync(join(root, 'assets/CON'))], [false, false, false]);
});

test('the turn record keeps each turn as sent, with its session, until it is settled', async () => {
	const storage = mkdtempSync(join(tmpdir(), 'turn-storage-'));
	const record = turnRecordOf(storage, mkdtempSync(join(tmpdir(), 'turn-project-')));
	await record.send('turn-1', 'main', 's-1', new Date('2026-11-14T10:00:00Z'));
	await record.send('turn-2', 'main', 's-1', new Date('2026-11-14T10:01:00Z'));
	assert.deepEqual(record.unsettled('main').map(t => t.turn), ['turn-1', 'turn-2']);
	assert.equal(record.sentTurn('turn-1')?.session, 's-1');
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
