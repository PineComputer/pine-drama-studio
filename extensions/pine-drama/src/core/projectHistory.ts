// The project's history (doc/protocol.md 2.1): every write to the project folder goes through its one write queue, and
// every commit through this module, with the git the Studio ships (git.ts). Codex's cloud apply lands a task's diff
// through the git CLI in the same way (codex-rs git-utils/src/apply.rs); unlike Codex, the Studio commits by itself,
// since the people who make dramas don't use git, and every version stays recoverable, as Claude Code's checkpoints
// keep each edit for a rewind. No vscode import.

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { git, gitStream } from './git';
import { projectIdentity } from './projectPlace';
import { OBJECT_FILE } from './protocol';

/**
 * A commit's author (doc/protocol.md 2.1): a turn's result, the person's own change through the Studio, or what the
 * folder held that no commit recorded (a hand edit, or a write a crash cut off).
 */
export type CommitAuthor = 'pine-computer' | 'person' | 'client-found-changes-on-disk';

// Written when the Studio makes the repository, to its own info/attributes, which a folder's .gitattributes cannot
// override (gitattributes, "the highest precedence"); a folder that has its own repository keeps it as it is
// (doc/protocol.md 2.1). Nothing is written into the person's folder.
// `-text`: no line-ending conversion of any file, so a file's bytes are the bytes its hash names (gitattributes, "text").
// `-filter`, `-ident`, `-working-tree-encoding`: no clean or smudge filter, no $Id$ expansion and no re-encoding
// (gitattributes, "filter", "ident", "working-tree-encoding").
// `-delta`: no delta compression of media, which recompressed bytes don't gain from (gitattributes, "delta").
const ATTRIBUTES = ['* -text -filter -ident -working-tree-encoding', ...['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'wav', 'mp3', 'm4a']
	.map(ext => `*.${ext} -delta`)].join('\n') + '\n';
// The Studio's own temporary files, a whole write's sibling (placement.ts, writeWhole), gone once its rename is done; and
// the Finder's: in the repository's own info/exclude (gitignore, "$GIT_DIR/info/exclude"), not the person's folder.
const EXCLUDED = '.*.tmp\n.DS_Store\n';

// The variables git reads to choose a repository other than the folder's, as `git rev-parse --local-env-vars` lists them
// (git's environment.c, local_repo_env), unset. A list, because dugite's exec runs git with process.env under the call's
// own variables (dugite git-environment.ts, setupEnvironment), and a child process is given no variable whose value is
// undefined (Node child_process, options.env).
const REPOSITORY_UNSET = Object.fromEntries(['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
	'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS',
	'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR'].map(name => [name, undefined]));

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `write` after the project's earlier writes and before its later ones: the one queue every write to the project
 * folder goes through, the person's and the agent's (doc/protocol.md 4.4), so two never write at once. A write that
 * makes several commits (a conversion) runs as one `write` and calls commitPathsToHistory inside it.
 */
export function runInProjectWriteQueue<T>(projectRoot: string, write: () => Promise<T>): Promise<T> {
	// By the project's canonical path, so a link to the folder joins the same queue.
	const project = projectIdentity(projectRoot);
	const step = (writeQueues.get(project) ?? Promise.resolve()).catch(() => undefined).then(write);
	writeQueues.set(project, step);
	return step;
}

/**
 * Inside the project's write queue: commits `paths` (project-relative files or folders, or `all`) as `author` with
 * `message` and `trailers`. The commit takes only those paths, so a file someone else changed or staged meanwhile keeps
 * its change for the commit of whoever made it (git commit, "--only"). A commit with trailers is a record (a turn's
 * change applied, doc/protocol.md 4.4), so it is made even when its paths are unchanged (--allow-empty). A commit that
 * fails is thrown: a version the history does not hold could be overwritten unseen.
 */
export async function commitPathsToHistory(projectRoot: string, author: CommitAuthor, paths: readonly string[] | 'all', message: string,
	trailers: Readonly<Record<string, string>> = {}, leaveOut: readonly string[] = []): Promise<void> {
	await ensureRepository(projectRoot);
	const trailing = Object.entries(trailers).flatMap(([key, value]) => ['--trailer', `${key}: ${value}`]);
	const record = trailing.length > 0;
	// A path on disk is staged by `git add` (--force: even where the folder's .gitignore names it); one the write removed by
	// `git rm --cached --ignore-unmatch`, which also takes a deletion a cut-off commit left staged. The commit then reads
	// them with --only, against HEAD too; a removed path HEAD never held is left out, as git refuses a whole commit for one.
	const onDisk = paths === 'all' ? ['.'] : paths.filter(p => existsSync(join(projectRoot, p)));
	const removed = paths === 'all' ? [] : paths.filter(p => !existsSync(join(projectRoot, p)));
	if (onDisk.length) { await run(projectRoot, author, ['add', '-A', ...(paths === 'all' ? [] : ['--force']), '--', ...onDisk]); }
	if (removed.length) { await run(projectRoot, author, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...removed]); }
	// Paths left as they are in HEAD's index: staged back to HEAD (git reset), or out of an index with no HEAD yet.
	if (leaveOut.length) {
		await run(projectRoot, author, await hasHead(projectRoot) ? ['reset', '-q', 'HEAD', '--', ...leaveOut] : ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...leaveOut]);
	}
	const inHead = removed.length && await hasHead(projectRoot) ? (await run(projectRoot, author, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...removed])).split('\0') : [];
	const spec = [...onDisk, ...removed.filter(p => inHead.some(t => t === p || t.startsWith(`${p}/`)))];
	if (!spec.length && !record) { return; }
	if (spec.length) {
		// --quiet exits 1 when something is staged there, 0 when there is nothing to commit (git diff, "--exit-code").
		const staged = await exec(projectRoot, author, ['diff', '--cached', '--quiet', '--', ...spec]);
		if (staged.exitCode !== 0 && staged.exitCode !== 1) { throw new Error(`git diff: ${staged.stderr.trim()}`); }
		if (staged.exitCode === 0 && !record) { return; }
	}
	// --only with no path and --allow-empty commits nothing of the index: an empty record (git commit, "--only").
	await run(projectRoot, author, ['commit', '-q', ...(record ? ['--allow-empty'] : []), '-m', message, ...trailing,
		...(paths === 'all' ? [] : ['--only', '--', ...spec])]);
}

/**
 * Commits, in the project's write queue, whatever the folder holds that no commit records, as
 * `client-found-changes-on-disk` (doc/protocol.md 2.1), at opening (recordFilesFoundOnDisk).
 */
export function commitFilesFoundOnDisk(projectRoot: string, message: string): Promise<void> {
	return runInProjectWriteQueue(projectRoot, () => recordFilesFoundOnDisk(projectRoot, message));
}

/**
 * Inside the project's write queue: commits whatever the folder holds that no commit records, as
 * `client-found-changes-on-disk`, but the files a running turn has written so far: they are that turn's, and its one
 * commit at its end records them (writtenByRunningTurns).
 */
export async function recordFilesFoundOnDisk(projectRoot: string, message: string): Promise<void> {
	const turns = await writtenByRunningTurns(projectRoot);
	const paths = [...new Set(turns.flatMap(turn => [...turn.files.keys()]))];
	// Only where the folder still holds what a turn wrote: a hand edit since is the person's, and is recorded.
	const disk = await onDisk(projectRoot, paths);
	const writing = paths.filter(path => turns.some(turn => turn.files.get(path) === blobOf(disk.get(path))));
	await commitPathsToHistory(projectRoot, 'client-found-changes-on-disk', 'all', message, {}, writing);
}

/**
 * The project's refs for a session of Pine Computer (one name per session, from its own), outside refs/heads, so no
 * branch shows them: `acked`, the last commit both sides hold, which the project's history records; `put`, the snapshot
 * going up; `captured`, the turn's last capture on the Computer, which the next one follows; `incoming`, a capture just
 * fetched; `written`, a commit of what the turn has written into the folder so far, a path at a time.
 */
export function sessionRefs(session: string): SessionRefs {
	const key = createHash('sha256').update(session).digest('hex').slice(0, 16);
	const ref = (kind: string) => `${SESSION_REFS}/${kind}/${key}`;
	return { acked: ref('sessions'), put: ref('put'), captured: ref('captured'), incoming: ref('incoming'), written: ref('written') };
}

export interface SessionRefs { readonly acked: string; readonly put: string; readonly captured: string; readonly incoming: string; readonly written: string }

const SESSION_REFS = 'refs/pine-drama';

/**
 * Each running turn's writes into the folder that no commit records yet: for each session whose `written` commit is
 * not its acknowledged one, the paths that differ, with the blob it wrote there or null where it removed one.
 */
export async function writtenByRunningTurns(projectRoot: string): Promise<{ readonly written: string; readonly files: ReadonlyMap<string, string | null> }[]> {
	if (!existsSync(join(projectRoot, '.git'))) { return []; }
	const turns: { written: string; files: Map<string, string | null> }[] = [];
	for (const written of (await run(projectRoot, 'person', ['for-each-ref', '--format=%(refname)', `${SESSION_REFS}/written/`])).split('\n').filter(Boolean)) {
		const acked = await readRef(projectRoot, written.replace(`${SESSION_REFS}/written/`, `${SESSION_REFS}/sessions/`));
		const wrote = await readRef(projectRoot, written);
		if (!acked || !wrote || acked === wrote) { continue; }
		turns.push({ written, files: new Map((await treeChanges(projectRoot, acked, wrote)).map(e => [e.path, e.blob])) });
	}
	return turns;
}

/** A commit of `base`'s tree with `entries` in it (a temporary index, write-tree, commit-tree), or `base` itself for none. */
export async function commitTreeWith(projectRoot: string, base: string, entries: readonly TreeEntry[]): Promise<string> {
	if (!entries.length) { return base; }
	const tree = await withIndex(async index => {
		await run(projectRoot, 'person', ['read-tree', base], { index });
		await run(projectRoot, 'person', ['update-index', '-z', '--index-info'], { index, stdin: indexLines(entries) });
		return (await run(projectRoot, 'person', ['write-tree'], { index })).trim();
	});
	return (await run(projectRoot, 'person', ['commit-tree', tree, '-m', 'What a turn has written into the folder'])).trim();
}

/** Every file of `rev` (git ls-tree -r), by path, with its mode and blob; none where `rev` names no commit. */
export async function filesOf(projectRoot: string, rev: string): Promise<Map<string, { readonly mode: string; readonly blob: string }>> {
	if (!await readRef(projectRoot, rev)) { return new Map(); }
	// "<mode> <type> <blob>\t<path>", NUL-terminated.
	return new Map((await run(projectRoot, 'person', ['ls-tree', '-r', '-z', '--full-tree', rev])).split('\0').filter(Boolean).map(line => {
		const [mode, , blob] = line.slice(0, line.indexOf('\t')).split(' ');
		return [line.slice(line.indexOf('\t') + 1), { mode, blob }] as const;
	}));
}

/** What stands at a path of the folder: a file, by git's mode and blob; nothing (null); or a folder or anything else. */
export type DiskState = { readonly mode: string; readonly blob: string } | null | 'folder';

/** The blob a disk state holds there, or null where no file does. */
export const blobOf = (state: DiskState | undefined): string | null => state && state !== 'folder' ? state.blob : null;

/**
 * What the folder holds at each of `paths`, each file by git's own id of its bytes and its mode (git hash-object, the
 * paths given as arguments, so a name is never read as git's quoted form; with `store`, -w writes each into the
 * repository, so a commit can name it).
 */
export async function onDisk(projectRoot: string, paths: readonly string[], store = false): Promise<Map<string, DiskState>> {
	const found = new Map<string, DiskState>();
	const files: { path: string; mode: string }[] = [];
	for (const path of paths) {
		try {
			const stat = lstatSync(join(projectRoot, path));
			if (stat.isFile()) { files.push({ path, mode: stat.mode & 0o100 ? '100755' : '100644' }); } else { found.set(path, 'folder'); }
		} catch {
			found.set(path, null);
		}
	}
	await ensureRepository(projectRoot);
	for (let i = 0; i < files.length; i += 200) {
		const batch = files.slice(i, i + 200);
		const ids = (await run(projectRoot, 'person', ['hash-object', ...store ? ['-w'] : [], '--', ...batch.map(f => f.path)])).trim().split('\n');
		batch.forEach((file, j) => found.set(file.path, { mode: file.mode, blob: ids[j] }));
	}
	return found;
}

/** Pine's own ids of a turn: its Computer, its session (Pine names a session by its name) and the turn. */
export interface PineTurnIds {
	readonly computer: string;
	readonly session: string;
	readonly turn: string;
}

/** The trailer of a turn's result by which history names the turn; Use and the Versions list read it. */
const TURN_ID = 'Pine-Turn-Id';

/** The trailers a turn's result is committed with: where on Pine it was made. */
export const turnTrailers = (ids: PineTurnIds): Readonly<Record<string, string>> => ({ 'Pine-Computer-Id': ids.computer, 'Pine-Session-Id': ids.session, [TURN_ID]: ids.turn });

/** One commit of a history: who made it, when, the turn whose result it landed if any, and the files it changed. */
export interface HistoryEntry {
	readonly commit: string;
	readonly author: string;
	readonly committedAt: string;
	readonly turnId: string | null;
	/**
	 * Each file under the path asked that the commit changed, with git's id of its bytes there (a local id, doc/protocol.md
	 * section 1), or null where the commit deleted it.
	 */
	readonly files: ReadonlyMap<string, string | null>;
}

/**
 * The history of `path`, a file or a folder, newest first: every commit of HEAD's history that changed a file there
 * (git log -- <path>), each with the files it changed there and their blobs, from git's raw diff output (git log --raw),
 * which reads no file's bytes. The one history lister: an object's shown file and a conversion's check read it.
 */
export async function listHistory(projectRoot: string, path: string): Promise<HistoryEntry[]> {
	if (!existsSync(join(projectRoot, '.git')) || !await hasHead(projectRoot)) { return []; }
	const log = await run(projectRoot, 'person', ['log', '-z', '--raw', '--no-renames', '--no-abbrev',
		`--format=%x1e%H%x1f%an%x1f%cI%x1f%(trailers:key=${TURN_ID},valueonly)`, '--', path]);
	// Each commit starts with a record separator and its fields, then NUL-separated pairs: a raw line
	// (":<mode> <mode> <blob before> <blob after> <status>") and its path. A blob of zeros is no file.
	return log.split('\x1e').filter(Boolean).map(record => {
		const [head, ...raw] = record.split('\0');
		const [commit, author, committedAt, turnId] = head.split('\x1f').map(field => field.trim());
		const files = new Map<string, string | null>();
		for (let i = 0; i + 1 < raw.length; i += 2) {
			const after = raw[i].trim().split(' ')[3];
			files.set(raw[i + 1], /^0+$/.test(after) ? null : after);
		}
		return { commit, author, committedAt, files, turnId: turnId || null };
	});
}

/** One result of an object: the commit that first wrote it, its file then, its blob, and whether the object shows it now. */
export interface ShownFileHistoryEntry extends Omit<HistoryEntry, 'files'> {
	readonly file: string;
	readonly blob: string;
	readonly shown: boolean;
}

/**
 * `object`'s results, newest first: each content its shown file has had, under every name its object.json gave it (an
 * import keeps the name with the person's extension, doc/protocol.md section 3), once, at the commit that first wrote
 * it; `shown` marks the one its history shows now, which a Use makes an earlier one again. A commit's shown file is
 * the one its object.json names after that commit. The strip, Versions and Use read it.
 */
export async function listHistoryOfShownFile(projectRoot: string, object: string): Promise<ShownFileHistoryEntry[]> {
	const oldestFirst = (await listHistory(projectRoot, object)).reverse();
	// The shown file each commit's object.json names, where the commit changed it; an object.json that is no JSON names none.
	const named = await Promise.all(oldestFirst.map(async ({ files }) => {
		const blob = files.get(`${object}/${OBJECT_FILE}`);
		if (blob === undefined) { return undefined; }
		try {
			const shown = blob === null ? null : Object(JSON.parse((await blobBytes(projectRoot, blob)).toString('utf8'))).shown_file;
			return typeof shown === 'string' ? shown : null;
		} catch {
			return null;
		}
	}));
	let shown: string | null = null;
	// Each file's blob after the commits walked so far, and each result by its file and blob.
	const blobs = new Map<string, string | null>();
	const results = new Map<string, Omit<ShownFileHistoryEntry, 'shown'>>();
	const resultNow = () => {
		const file = shown === null ? null : `${object}/${shown}`;
		const blob = file === null ? null : blobs.get(file) ?? null;
		return file === null || blob === null ? null : { key: `${file}\0${blob}`, file, blob };
	};
	for (const [i, { files, ...entry }] of oldestFirst.entries()) {
		for (const [path, blob] of files) { blobs.set(path, blob); }
		if (named[i] !== undefined) { shown = named[i]!; }
		const result = resultNow();
		if (result && !results.has(result.key)) { results.set(result.key, { ...entry, file: result.file, blob: result.blob }); }
	}
	const now = resultNow()?.key;
	return [...results].reverse().map(([key, result]) => ({ ...result, shown: key === now }));
}

/** The bytes `path` held at commit `commit`, or null where it held no such file. */
export async function readFileAtCommit(projectRoot: string, commit: string, path: string): Promise<Buffer | null> {
	return (await exec(projectRoot, 'person', ['cat-file', '-e', `${commit}:${path}`])).exitCode === 0 ? blobBytes(projectRoot, `${commit}:${path}`) : null;
}

/**
 * The files commit `commit` changed in `object`'s own folder, each with its bytes there, or null where it deleted the
 * file: what a "Use" of that result restores (doc/protocol.md section 5). A folder below holding an object.json, in the
 * commit or among what it changed, is an object of its own (a variant) and is left out. git diff-tree names them, the
 * first commit's too (--root).
 */
export async function readChangeOfObject(projectRoot: string, commit: string, object: string): Promise<Map<string, Buffer | null>> {
	const listed = (await run(projectRoot, 'person', ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--name-status', '--no-renames', commit, '--', object])).split('\0').filter(Boolean);
	const changed = new Map<string, boolean>();
	for (let i = 0; i + 1 < listed.length; i += 2) { changed.set(listed[i + 1], listed[i] === 'D'); }
	const tree = (await run(projectRoot, 'person', ['ls-tree', '-r', '-z', '--name-only', commit, '--', object])).split('\0').filter(Boolean);
	const objects = [...tree, ...changed.keys()].filter(path => basename(path) === OBJECT_FILE).map(dirname).filter(folder => folder !== object);
	const files = new Map<string, Buffer | null>();
	for (const [path, deleted] of changed) {
		if (objects.some(folder => path.startsWith(`${folder}/`))) { continue; }
		files.set(path, deleted ? null : await blobBytes(projectRoot, `${commit}:${path}`));
	}
	return files;
}

/** The modes of a file of the project: a regular file, executable or not; a link (120000) or a gitlink (160000) is none (section 1). */
const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** A path the drama does not hold: one with a part starting with "." (section 1). */
export const hiddenPath = (path: string): boolean => path.split('/').some(part => part.startsWith('.'));

/** A file of a change between two trees: its path, git's mode and blob there, or null where the change deletes it. */
export interface TreeEntry {
	readonly path: string;
	readonly mode: string;
	readonly blob: string | null;
}

/**
 * Inside the project's write queue: a commit of HEAD's files as they go to a Pine Computer, hidden ones and links left out
 * (section 1), at `ref`, with `parent` as its one parent or none. It is made of git's own objects (a temporary index,
 * write-tree, commit-tree), so its bytes are HEAD's whatever the folder holds meanwhile. Returns its id.
 */
export async function commitSnapshotOfHead(projectRoot: string, ref: string, parent: string | null, message: string): Promise<string> {
	await ensureRepository(projectRoot);
	// "<mode> <type> <blob>\t<path>", NUL-terminated (git ls-tree -z), which update-index --index-info reads as it is.
	const files = await hasHead(projectRoot) ? (await run(projectRoot, 'person', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])).split('\0')
		.filter(line => line && FILE_MODES.has(line.split(' ')[0]) && !hiddenPath(line.slice(line.indexOf('\t') + 1))) : [];
	const tree = await withIndex(async index => {
		await run(projectRoot, 'person', ['read-tree', '--empty'], { index });
		if (files.length) { await run(projectRoot, 'person', ['update-index', '-z', '--index-info'], { index, stdin: `${files.join('\0')}\0` }); }
		return (await run(projectRoot, 'person', ['write-tree'], { index })).trim();
	});
	const commit = (await run(projectRoot, 'person', ['commit-tree', tree, ...parent ? ['-p', parent] : [], '-m', message])).trim();
	await run(projectRoot, 'person', ['update-ref', ref, commit]);
	return commit;
}

/** The commit `ref` names, or null where there is none. */
export async function readRef(projectRoot: string, ref: string): Promise<string | null> {
	if (!existsSync(join(projectRoot, '.git'))) { return null; }
	const result = await exec(projectRoot, 'person', ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Writes `ref` and the commits it needs that `have` already holds not, as a bundle at `file` (git bundle create). */
export async function bundleRef(projectRoot: string, file: string, ref: string, have: string | null): Promise<void> {
	await run(projectRoot, 'person', ['bundle', 'create', file, ref, ...have ? [`^${have}`] : []]);
}

/** Fetches `ref` of the bundle at `file` into the repository as `into` (git fetch from a bundle); returns the commit. */
export async function fetchBundle(projectRoot: string, file: string, ref: string, into: string): Promise<string> {
	await run(projectRoot, 'person', ['fetch', '-q', '--no-tags', file, `+${ref}:${into}`]);
	return (await run(projectRoot, 'person', ['rev-parse', '--verify', `${into}^{commit}`])).trim();
}

/** What changed from commit `from` to commit `to`, path by path, with no rename detection (git diff-tree -r -z --no-renames). */
export async function treeChanges(projectRoot: string, from: string, to: string): Promise<TreeEntry[]> {
	// ":<mode before> <mode after> <blob before> <blob after> <status>" and the path, each NUL-terminated.
	const fields = (await run(projectRoot, 'person', ['diff-tree', '-r', '-z', '--no-renames', from, to])).split('\0');
	const entries: TreeEntry[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [, mode, , blob, status] = fields[i].slice(1).split(' ');
		entries.push({ path: fields[i + 1], mode, blob: status === 'D' ? null : blob });
	}
	return entries;
}


/**
 * Inside the project's write queue, once its folder holds them: commits exactly `entries` onto HEAD as `author`, with
 * `message` and `trailers`, from a temporary index made from HEAD, so nothing else staged or changed goes in; HEAD and
 * every ref of `refs` move together in one transaction (git update-ref --stdin), and the person's index takes the same
 * entries, so those paths show no change. With no entries only `refs` move. A file and a folder may change places:
 * the deletions go into the index first.
 */
export async function commitEntriesToHistory(projectRoot: string, author: CommitAuthor, entries: readonly TreeEntry[], message: string,
	trailers: Readonly<Record<string, string>>, refs: Readonly<Record<string, string>> = {}): Promise<void> {
	await ensureRepository(projectRoot);
	const head = await readRef(projectRoot, 'HEAD');
	const lines = indexLines(entries);
	const moves = { ...refs };
	if (entries.length) {
		const tree = await withIndex(async index => {
			await run(projectRoot, author, head ? ['read-tree', head] : ['read-tree', '--empty'], { index });
			await run(projectRoot, author, ['update-index', '-z', '--index-info'], { index, stdin: lines });
			return (await run(projectRoot, author, ['write-tree'], { index })).trim();
		});
		const paragraphs = [message, Object.entries(trailers).map(([key, value]) => `${key}: ${value}`).join('\n')].filter(Boolean);
		moves.HEAD = (await run(projectRoot, author, ['commit-tree', tree, ...head ? ['-p', head] : [], ...paragraphs.flatMap(text => ['-m', text])])).trim();
	}
	// HEAD only where it still is what the commit was made on, none for an unborn one (an "update <ref> <new> <old>"
	// line, an all-zero old value for a ref that must not exist yet).
	const transaction = ['start', ...Object.entries(moves).map(([ref, commit]) => ref === 'HEAD' ? `update HEAD ${commit} ${head ?? '0'.repeat(40)}` : `update ${ref} ${commit}`), 'commit', ''].join('\n');
	await run(projectRoot, author, ['update-ref', '--stdin'], { stdin: transaction });
	if (entries.length) { await run(projectRoot, author, ['update-index', '-z', '--index-info'], { stdin: lines }); }
}

/** `entries` as git update-index --index-info reads them, NUL-terminated, deletions first, so a file and a folder can change places. */
const indexLines = (entries: readonly TreeEntry[]): string => [...entries].sort((a, b) => Number(a.blob !== null) - Number(b.blob !== null))
	.map(e => e.blob === null ? `0 ${'0'.repeat(40)}\t${e.path}` : `${e.mode} ${e.blob}\t${e.path}`).join('\0') + '\0';

/**
 * Runs `use` with a temporary index, removed after (GIT_INDEX_FILE): outside the folder, as `.git` may be a file (a
 * linked worktree, git-worktree) that holds no index.
 */
async function withIndex<T>(use: (index: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'pine-drama-index-'));
	try { return await use(join(dir, 'index')); } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Writes the blob `blob` to `file` whole, streamed from the repository (git cat-file) into a sibling temporary file
 * that is then renamed, so a large take is never held in memory; `executable` sets its mode 755.
 */
export async function writeBlob(projectRoot: string, blob: string, file: string, executable = false): Promise<void> {
	const temp = join(dirname(file), `.${randomUUID()}.tmp`);
	try {
		const child = gitStream([...ISOLATED_CONFIG, 'cat-file', 'blob', blob], projectRoot, isolatedEnv('person'));
		// A process that cannot start (EMFILE, EAGAIN) emits `error`, never `close`.
		const [, code] = await Promise.all([pipeline(child.stdout, createWriteStream(temp, { mode: executable ? 0o755 : 0o644 })),
			new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); })]);
		if (code !== 0) { throw new Error(`git cat-file: blob ${blob} could not be read`); }
		await rename(temp, file);
	} finally {
		await rm(temp, { force: true });
	}
}

/** Writes the blob `blob` to `file`, once: a past version's picture, for a thumbnail outside the project's folder. */
export async function writeBlobToFile(projectRoot: string, blob: string, file: string): Promise<void> {
	if (existsSync(file)) { return; }
	await mkdir(dirname(file), { recursive: true });
	await writeBlob(projectRoot, blob, file);
}

/** A blob's bytes, by any name git resolves to one (`<commit>:<path>` or its id); latin1 maps each byte to one character. */
export async function blobBytes(projectRoot: string, name: string): Promise<Buffer> {
	return Buffer.from(await run(projectRoot, 'person', ['cat-file', 'blob', name], { encoding: 'latin1' }), 'latin1');
}

/** Whether the repository has a commit yet. */
async function hasHead(projectRoot: string): Promise<boolean> {
	return (await exec(projectRoot, 'person', ['rev-parse', '--verify', '-q', 'HEAD'])).exitCode === 0;
}

/**
 * Git as `author`. The same result whatever the person's own git setup: no global config (signing, identity), no hooks
 * of a repository the folder already was (core.hooksPath to nothing: git runs no prepare-commit-msg, commit-msg or
 * post-commit either), and the folder's own repository whatever the environment names (REPOSITORY_UNSET). Paths are
 * literal, never patterns (git, --literal-pathspecs).
 */
function exec(projectRoot: string, author: CommitAuthor, args: readonly string[], { index, ...call }: { readonly stdin?: string; readonly encoding?: BufferEncoding; readonly index?: string } = {}) {
	return git([...ISOLATED_CONFIG, ...args], projectRoot, { env: { ...isolatedEnv(author), ...index ? { GIT_INDEX_FILE: index } : {} }, ...call });
}

const ISOLATED_CONFIG = ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${devNull}`];
const isolatedEnv = (author: CommitAuthor) => ({ ...REPOSITORY_UNSET, GIT_CONFIG_GLOBAL: devNull, GIT_LITERAL_PATHSPECS: '1', GIT_AUTHOR_NAME: author,
	GIT_AUTHOR_EMAIL: `${author}@pine-drama.invalid`, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@pine-drama.invalid` });

/** exec, its stdout; a non-zero exit is thrown. */
async function run(projectRoot: string, author: CommitAuthor, args: readonly string[], call: Parameters<typeof exec>[3] = {}): Promise<string> {
	const result = await exec(projectRoot, author, args, call);
	if (result.exitCode !== 0) { throw new Error(`git ${args[0]}: ${result.stderr.trim() || result.stdout.trim()}`); }
	return result.stdout;
}

/**
 * Makes the folder's repository on first use, with the byte rules in its own info/attributes and the Studio's temporary
 * files in its info/exclude. A folder's own repository is kept as it is.
 */
async function ensureRepository(projectRoot: string): Promise<void> {
	if (existsSync(join(projectRoot, '.git'))) { return; }
	await run(projectRoot, 'person', ['init', '-q', '-b', 'main']);
	await mkdir(join(projectRoot, '.git', 'info'), { recursive: true });
	await writeFile(join(projectRoot, '.git', 'info', 'attributes'), ATTRIBUTES);
	await writeFile(join(projectRoot, '.git', 'info', 'exclude'), EXCLUDED);
}
