// The project's history (doc/protocol.md 2.1): every write to the project folder goes through its one write queue, and
// every commit through this module, with the git the Studio ships (git.ts). Codex's cloud apply lands a task's diff
// through the git CLI in the same way (codex-rs git-utils/src/apply.rs); unlike Codex, the Studio commits by itself,
// since the people who make dramas don't use git, and every version stays recoverable, as Claude Code's checkpoints
// keep each edit for a rewind. No vscode import.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { git } from './git';
import { writeWhole } from './placement';
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
	trailers: Readonly<Record<string, string>> = {}): Promise<void> {
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
 * `client-found-changes-on-disk`
 * (doc/protocol.md 2.1): at opening, and before a turn's seed (4.2).
 */
export function commitFilesFoundOnDisk(projectRoot: string, message: string): Promise<void> {
	return runInProjectWriteQueue(projectRoot, () => commitPathsToHistory(projectRoot, 'client-found-changes-on-disk', 'all', message));
}

/** The two trailers a turn's change is committed with (doc/protocol.md 4.4), by which it is found in history. */
const TURN_ID = 'Pine-Turn-Id';
const CHANGE_NUMBER = 'Pine-Change-Number';

export const turnChangeTrailers = (turnId: string, changeNumber: number): Readonly<Record<string, string>> =>
	({ [TURN_ID]: turnId, [CHANGE_NUMBER]: String(changeNumber) });

/** Whether a commit of HEAD's history carries a turn's change's trailers: the change is resolved (doc/protocol.md 4.4). */
export async function historyHasTurnChange(projectRoot: string, turnId: string, changeNumber: number): Promise<boolean> {
	if (!existsSync(join(projectRoot, '.git')) || !await hasHead(projectRoot)) { return false; }
	// A trailer is a line of its own: each pattern is anchored to a line, so `Pine-Change-Number: 1` is not `…: 10`
	// (git log --grep matches per line; --all-match wants every pattern in one commit).
	const grep = Object.entries(turnChangeTrailers(turnId, changeNumber)).map(([key, value]) => `--grep=^${escapeRegex(key)}: ${escapeRegex(value)}$`);
	// The grep finds the candidates; git's own trailer parsing decides, so text quoted in a message body is no trailer.
	const found = await run(projectRoot, 'person', ['log', '-z', '--all-match', '-E', ...grep,
		`--format=%(trailers:key=${TURN_ID},valueonly,separator=%x2C)%x1f%(trailers:key=${CHANGE_NUMBER},valueonly,separator=%x2C)`]);
	return found.split('\0').some(entry => entry.trim() === `${turnId}\x1f${changeNumber}`);
}

/** One commit of a history: who made it, when, the turn's change it applied if any, and the files it changed. */
export interface HistoryEntry {
	readonly commit: string;
	readonly author: string;
	readonly committedAt: string;
	readonly turnChange: { readonly turnId: string; readonly changeNumber: number } | null;
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
		`--format=%x1e%H%x1f%an%x1f%cI%x1f%(trailers:key=${TURN_ID},valueonly)%x1f%(trailers:key=${CHANGE_NUMBER},valueonly)`, '--', path]);
	// Each commit starts with a record separator and its fields, then NUL-separated pairs: a raw line
	// (":<mode> <mode> <blob before> <blob after> <status>") and its path. A blob of zeros is no file.
	return log.split('\x1e').filter(Boolean).map(record => {
		const [head, ...raw] = record.split('\0');
		const [commit, author, committedAt, turnId, changeNumber] = head.split('\x1f').map(field => field.trim());
		const files = new Map<string, string | null>();
		for (let i = 0; i + 1 < raw.length; i += 2) {
			const after = raw[i].trim().split(' ')[3];
			files.set(raw[i + 1], /^0+$/.test(after) ? null : after);
		}
		return { commit, author, committedAt, files, turnChange: turnId && changeNumber ? { turnId, changeNumber: Number(changeNumber) } : null };
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

/** Writes the blob `blob` to `file`, once: a past version's picture, for a thumbnail outside the project's folder. */
export async function writeBlobToFile(projectRoot: string, blob: string, file: string): Promise<void> {
	if (existsSync(file)) { return; }
	await mkdir(dirname(file), { recursive: true });
	await writeWhole(file, await blobBytes(projectRoot, blob));
}

/** A blob's bytes, by any name git resolves to one (`<commit>:<path>` or its id); latin1 maps each byte to one character. */
async function blobBytes(projectRoot: string, name: string): Promise<Buffer> {
	return Buffer.from(await run(projectRoot, 'person', ['cat-file', 'blob', name], { encoding: 'latin1' }), 'latin1');
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
function exec(projectRoot: string, author: CommitAuthor, args: readonly string[], call: { readonly stdin?: string; readonly encoding?: BufferEncoding } = {}) {
	const env = { ...REPOSITORY_UNSET, GIT_CONFIG_GLOBAL: devNull, GIT_LITERAL_PATHSPECS: '1', GIT_AUTHOR_NAME: author,
		GIT_AUTHOR_EMAIL: `${author}@pine-drama.invalid`, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@pine-drama.invalid` };
	return git(['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${devNull}`, ...args], projectRoot, { env, ...call });
}

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
