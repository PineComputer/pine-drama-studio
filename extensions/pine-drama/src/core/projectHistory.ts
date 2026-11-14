// The project's history (doc/protocol.md 2.1): every write to the project folder goes through its one write queue, and
// every commit through this module, with the git the Studio ships (git.ts). Codex's cloud apply lands a task's diff
// through the git CLI in the same way (codex-rs git-utils/src/apply.rs); unlike Codex, the Studio commits by itself,
// since the people who make dramas don't use git, and every version stays recoverable, as Claude Code's checkpoints
// keep each edit for a rewind. No vscode import.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { git } from './git';
import { projectIdentity } from './projectPlace';

/**
 * A commit's author (doc/protocol.md 2.1): a turn's result, the person's own change through the Studio, or what the
 * folder held that no commit recorded (a hand edit, or a write a crash cut off).
 */
export type CommitAuthor = 'pine-computer' | 'person' | 'client-found-changes-on-disk';

// Written when the Studio makes the repository, to .gitattributes when the folder has none and always to the repository's
// own info/attributes, which a folder's .gitattributes cannot override (gitattributes, "the highest precedence"); a
// folder that has its own repository keeps it as it is (doc/protocol.md 2.1).
// `-text`: no line-ending conversion of any file, so a file's bytes are the bytes its hash names (gitattributes, "text").
// `-filter`, `-ident`, `-working-tree-encoding`: no clean or smudge filter, no $Id$ expansion and no re-encoding
// (gitattributes, "filter", "ident", "working-tree-encoding").
// `-delta`: no delta compression of media, which recompressed bytes don't gain from (gitattributes, "delta").
const ATTRIBUTES = ['* -text -filter -ident -working-tree-encoding', ...['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'wav', 'mp3', 'm4a']
	.map(ext => `*.${ext} -delta`)].join('\n') + '\n';
// The Studio's own temporary files, a whole write's sibling (choices.ts, writeWhole), gone once its rename is done; and
// the Finder's. A name starting with '.' is never a path of the protocol (doc/protocol.md, section 1).
const IGNORED = '.*.tmp\n.DS_Store\n';

// Every variable git reads to choose a repository other than the folder's (git rev-parse --local-env-vars), unset: a
// child process is given no variable whose value is undefined (Node child_process, options.env).
const REPOSITORY_UNSET = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
	'GIT_SHALLOW_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_NO_REPLACE_OBJECTS'].map(name => [name, undefined]));

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
	// git refuses a whole command for one path it does not know. A path on disk or in the index is staged; one only HEAD
	// has is a deletion already staged (a commit cut off after its `git add`), which the commit still takes (git commit
	// --only reads its paths against HEAD too); one in none of them was never there.
	const named = (listed: string) => (p: string) => listed.split('\0').some(t => t === p || t.startsWith(`${p}/`));
	const inIndex = paths === 'all' ? () => true : named(await run(projectRoot, author, ['ls-files', '-z', '--', ...paths]));
	const inHead = paths === 'all' || !await hasHead(projectRoot) ? () => false : named(await run(projectRoot, author, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths]));
	const staging = paths === 'all' ? ['.'] : paths.filter(p => existsSync(join(projectRoot, p)) || inIndex(p));
	const spec = paths === 'all' ? ['.'] : paths.filter(p => staging.includes(p) || inHead(p));
	if (!spec.length && !record) { return; }
	// --force: a path the Studio wrote is committed even where a .gitignore of the folder's names it.
	if (staging.length) { await run(projectRoot, author, ['add', '-A', ...(paths === 'all' ? [] : ['--force']), '--', ...staging]); }
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

/** The trailers a turn's change is committed with (doc/protocol.md 4.4), by which it is found in history. */
export const turnChangeTrailers = (turnId: string, changeNumber: number): Readonly<Record<string, string>> =>
	({ 'Pine-Turn-Id': turnId, 'Pine-Change-Number': String(changeNumber) });

/** Whether a commit of HEAD's history carries a turn's change's trailers: the change is resolved (doc/protocol.md 4.4). */
export async function historyHasTurnChange(projectRoot: string, turnId: string, changeNumber: number): Promise<boolean> {
	if (!existsSync(join(projectRoot, '.git')) || !await hasHead(projectRoot)) { return false; }
	// A trailer is a line of its own: each pattern is anchored to a line, so `Pine-Change-Number: 1` is not `…: 10`
	// (git log --grep matches per line; --all-match wants every pattern in one commit).
	const grep = Object.entries(turnChangeTrailers(turnId, changeNumber)).map(([key, value]) => `--grep=^${escapeRegex(key)}: ${escapeRegex(value)}$`);
	// The grep finds the candidates; git's own trailer parsing decides, so text quoted in a message body is no trailer.
	const found = await run(projectRoot, 'person', ['log', '-z', '--all-match', '-E', ...grep,
		'--format=%(trailers:key=Pine-Turn-Id,valueonly,separator=%x2C)%x1f%(trailers:key=Pine-Change-Number,valueonly,separator=%x2C)']);
	return found.split('\0').some(entry => entry.trim() === `${turnId}\x1f${changeNumber}`);
}

/** One commit of a file's history: who made it, the turn's change it applied if any, and the file's bytes there by hash. */
export interface FileHistoryEntry {
	readonly commit: string;
	readonly author: string;
	readonly committedAt: string;
	readonly turnChange: { readonly turnId: string; readonly changeNumber: number } | null;
	/** The sha256 of the file's bytes at this commit, or null where the commit deletes it. */
	readonly sha256: string | null;
}

/**
 * `path`'s history, newest first: every commit of HEAD's history that changed it (git log -- <path>), with the sha256 of
 * its bytes there. `git cat-file --batch-check` names each commit's blob; each blob is then read and hashed on its own,
 * so memory holds one revision at a time, never a take's whole history. The version strip, "Use" and a conversion's
 * check read it.
 */
export async function listHistoryOfFile(projectRoot: string, path: string): Promise<FileHistoryEntry[]> {
	if (!existsSync(join(projectRoot, '.git')) || !await hasHead(projectRoot)) { return []; }
	const log = await run(projectRoot, 'person', ['log', '-z', '--format=%H%x1f%an%x1f%cI%x1f%(trailers:key=Pine-Turn-Id,valueonly)%x1f%(trailers:key=Pine-Change-Number,valueonly)', '--', path]);
	const commits = log.split('\0').filter(Boolean).map(entry => entry.split('\x1f').map(field => field.trim()));
	if (!commits.length) { return []; }
	const asked = commits.map(([commit]) => `${commit}:${path}`);
	// One line per name asked: "<oid> blob <size>", or "<name asked> missing" where the commit holds no such file. A
	// missing reply is known by the name asked, so a file named like a reply is never read as one.
	const lines = (await run(projectRoot, 'person', ['cat-file', '--batch-check'], { stdin: asked.map(name => `${name}\n`).join('') })).split('\n');
	const entries: FileHistoryEntry[] = [];
	for (const [i, [commit, author, committedAt, turnId, changeNumber]] of commits.entries()) {
		const blob = lines[i] === `${asked[i]} missing` ? null : lines[i].split(' ')[0];
		// latin1 maps each byte to one character and back, so the blob's bytes come through the string unchanged.
		const sha256 = blob === null ? null : createHash('sha256').update(Buffer.from(await run(projectRoot, 'person', ['cat-file', 'blob', blob], { encoding: 'latin1' }), 'latin1')).digest('hex');
		entries.push({ commit, author, committedAt, sha256, turnChange: turnId && changeNumber ? { turnId, changeNumber: Number(changeNumber) } : null });
	}
	return entries;
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
 * Makes the folder's repository on first use. Its own info/attributes gets the byte rules, which a folder's
 * .gitattributes cannot override; .gitattributes and .gitignore are written when the folder has none. A folder's own
 * repository is kept as it is.
 */
async function ensureRepository(projectRoot: string): Promise<void> {
	if (existsSync(join(projectRoot, '.git'))) { return; }
	await run(projectRoot, 'person', ['init', '-q', '-b', 'main']);
	await mkdir(join(projectRoot, '.git', 'info'), { recursive: true });
	await writeFile(join(projectRoot, '.git', 'info', 'attributes'), ATTRIBUTES);
	for (const [name, text] of [['.gitattributes', ATTRIBUTES], ['.gitignore', IGNORED]]) {
		if (!existsSync(join(projectRoot, name))) { await writeFile(join(projectRoot, name), text); }
	}
}
