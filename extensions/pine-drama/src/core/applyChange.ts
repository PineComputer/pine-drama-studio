// The ways files land in the project folder: a turn's result, from git's own objects, and the person's change, a "Use"
// of a past result among them (doc/protocol.md sections 3 and 4): the newest result lands, and the file's history keeps
// every earlier one. It is the write half of Codex's cloud apply (codex-rs git-utils/src/apply.rs) with no preflight,
// since media replaces whole files and history keeps what it replaces. It runs in the project's one write queue (projectHistory.ts), with the person's other writes.
// No vscode import.

import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { throughNoLink, writeWhole } from './placement';
import { commitEntriesToHistory, commitPathsToHistory, listPathsOfIndex, recordFilesFoundOnDisk, runInProjectWriteQueue, turnTrailers, writeBlob, type PineTurnIds, type TreeEntry } from './projectHistory';
import { isProtocolPath, RECEIPT_SUFFIX } from './protocol';
import { sha256, sha256OfFile } from './sha256';

/** What landing a person's change did. */
export type ChangeApplied =
	| 'written and committed'
	/** Every path held what the change gives it already: nothing was written. */
	| 'already on disk';

/** A change names a file that is not a path of the project (doc/protocol.md, section 1): nothing of it is written. */
export class NotAProjectPathError extends Error {
	constructor(readonly paths: readonly string[]) { super(`not a path of the project: ${paths.join(', ')}`); }
}

/**
 * The person's change (doc/protocol.md section 3), landed as one `person` change of exactly its paths: `files` gives
 * each path with its new bytes or text, or null to delete what is there (a file, or a folder whole). It runs inside the
 * write queue, so the names it picks and what it reads of the folder are as the folder is when it lands: every file
 * written whole (a temporary sibling, then a rename; receipts before their outputs), then one commit of those paths.
 */
export function applyPersonChange(projectRoot: string, commitMessage: string,
	files: () => Promise<Iterable<readonly [string, Buffer | string | null]>>): Promise<ChangeApplied> {
	return runInProjectWriteQueue(projectRoot, async () => {
		// What the person saved by hand and no commit holds is recorded first, as a turn's landing does, so a change
		// written over it never loses it from history, and the change is read against a HEAD that holds the folder.
		await recordFilesFoundOnDisk(projectRoot, 'Changes found on disk before the person\'s change');
		const bytes = new Map([...await files()].map(([path, given]) => [path, typeof given === 'string' ? Buffer.from(given) : given] as const));
		const paths = [...bytes.keys()];
		const keys = paths.map(path => path.toLowerCase());
		// Two names that differ only by case are one path (section 1), so a change naming one twice is not the project's.
		// A path through a link is not the project's (placement.ts throughNoLink).
		const notPaths = paths.filter((path, i) => !validPath(path) || !throughNoLink(projectRoot, path) || keys.indexOf(keys[i]) !== i);
		if (notPaths.length) { throw new NotAProjectPathError(notPaths); }
		// A path to delete is as the change wants it when nothing is there, so what goes is never read (git rm -r).
		const asWanted = async (path: string) => {
			const got = bytes.get(path)!;
			return got === null ? !existsSync(join(projectRoot, path)) : statSync(join(projectRoot, path), { throwIfNoEntry: false })?.isFile() === true && await sha256OfFile(join(projectRoot, path)) === sha256(got);
		};
		if ((await Promise.all(paths.map(asWanted))).every(Boolean)) { return 'already on disk'; }
		// Deletions first, each with the folders it leaves empty (git's dir.c remove_path), so a file and a folder may change
		// places; then receipts before the outputs they describe (2.3), so an output is never on disk without its receipt.
		const order = (path: string) => bytes.get(path) === null ? 0 : path.endsWith(RECEIPT_SUFFIX) ? 1 : 2;
		for (const path of [...paths].sort((a, b) => order(a) - order(b))) {
			const file = join(projectRoot, path);
			const got = bytes.get(path)!;
			if (got === null) {
				await rm(file, { recursive: true, force: true });
				await removeEmptiedFolders(projectRoot, dirname(path));
			} else {
				await mkdir(dirname(file), { recursive: true });
				// An empty folder where the file goes, which git does not hold, makes way (rmdir refuses one that is not empty).
				if (statSync(file, { throwIfNoEntry: false })?.isDirectory()) { await rmdir(file); }
				await writeWhole(file, got);
			}
		}
		await commitPathsToHistory(projectRoot, 'person', paths, commitMessage);
		return 'written and committed';
	});
}

/** Why a path of a turn's result was left out of the project, said to the person. */
export type LeftOut = 'no path of the project' | 'a link' | 'the same name as another but for case' | 'reached through a link' | 'in the way of a folder or a file'
	| 'not allowed to write there' | 'a name too long for this disk' | 'its receipt was left out';

/**
 * Brings what one collection of a turn changed into the project folder (collectTurn), in its write queue, path by path,
 * so no one path keeps the rest out, by git's 3-way rule per file: `entries` are the files the turn changed since it last
 * saw them, so a file only the folder changed is in none and stays. What the folder holds that no commit records (a hand
 * edit) is committed first, as `client-found-changes-on-disk`, so where both changed history keeps the folder's version
 * and the turn's lands after it, never blocked (codex-rs git-utils/src/apply.rs runs `git apply --3way`; media does not
 * merge). Then the landed entries go in one `pine-computer` commit with the turn's trailers, and `refs` move with it.
 *
 * A path is left out, and named with why, when it is no path of the project (section 1), a link or another repository
 * (its mode is no file's), the same name as another but for case, reached through a link at the destination, or when
 * the folder will not take it there (pathError): a folder that is not empty where it writes a file, a file where it
 * needs a folder, a folder it may not write, a name too long. Only an error that is about no one path (git's, a full
 * disk) fails the landing. Deletions go first, each with the folders it leaves empty (as git does, dir.c
 * remove_path), so a file and a folder can change places; then each file is streamed from its blob, receipts before
 * their outputs (2.3).
 */
export function landTurnFiles(projectRoot: string, ids: PineTurnIds, entries: readonly TreeEntry[], refs: Readonly<Record<string, string>>):
	Promise<{ readonly landed: readonly string[]; readonly leftOut: ReadonlyMap<string, LeftOut> }> {
	return runInProjectWriteQueue(projectRoot, async () => {
		await recordFilesFoundOnDisk(projectRoot, 'Changes found on disk before a turn\'s result');
		const leftOut = new Map<string, LeftOut>();
		const writes = entries.filter(e => e.blob !== null);
		const gone = new Set(entries.filter(e => e.blob === null).map(e => e.path));
		// The folder's paths once this lands (the index's: HEAD's, and what is staged), by case-folded name: a write whose
		// name another holds but for case is left out.
		const byKey = new Map<string, Set<string>>();
		for (const path of [...(await listPathsOfIndex(projectRoot)).filter(path => !gone.has(path)), ...writes.map(e => e.path)]) {
			byKey.set(path.toLowerCase(), new Set([...byKey.get(path.toLowerCase()) ?? [], path]));
		}
		for (const { path, mode, blob } of entries) {
			const why: LeftOut | undefined = !validPath(path) ? 'no path of the project' : blob === null ? undefined : mode !== '100644' && mode !== '100755' ? 'a link'
				: byKey.get(path.toLowerCase())!.size > 1 ? 'the same name as another but for case' : undefined;
			if (why) { leftOut.set(path, why); }
		}
		const landing = entries.filter(e => !leftOut.has(e.path));
		const landed: TreeEntry[] = [];
		for (const entry of landing.filter(e => e.blob === null)) {
			try {
				if (!throughNoLink(projectRoot, entry.path)) { leftOut.set(entry.path, 'reached through a link'); continue; }
				await rm(join(projectRoot, entry.path), { force: true });
			} catch (error) {
				leftOut.set(entry.path, pathError(error));
				continue;
			}
			await removeEmptiedFolders(projectRoot, dirname(entry.path));
			landed.push(entry);
		}
		// Each write's destination is judged once the deletions are done, as the folder then is (placement.ts throughNoLink).
		// Receipts go first, and an output whose receipt this turn changed but could not write is left out with it (2.3).
		const receiptsFirst = (a: TreeEntry, b: TreeEntry) => Number(!a.path.endsWith(RECEIPT_SUFFIX)) - Number(!b.path.endsWith(RECEIPT_SUFFIX));
		for (const entry of landing.filter(e => e.blob !== null).sort(receiptsFirst)) {
			const file = join(projectRoot, entry.path);
			if (leftOut.has(`${entry.path}${RECEIPT_SUFFIX}`)) { leftOut.set(entry.path, 'its receipt was left out'); continue; }
			try {
				if (!throughNoLink(projectRoot, entry.path)) { leftOut.set(entry.path, 'reached through a link'); continue; }
				await mkdir(dirname(file), { recursive: true });
				await writeBlob(projectRoot, entry.blob!, file, entry.mode === '100755');
			} catch (error) {
				leftOut.set(entry.path, pathError(error));
				continue;
			}
			landed.push(entry);
		}
		// Exactly the entries that landed, from their blobs: one left out holds what someone else put there.
		return { landed: await commitEntriesToHistory(projectRoot, 'pine-computer', landed, `Turn ${ids.turn}`, turnTrailers(ids), refs), leftOut };
	});
}

/** What a file system error says about the one path it was raised for (Node's error codes, POSIX errno). */
const ABOUT_ONE_PATH: Readonly<Record<string, LeftOut>> = {
	EISDIR: 'in the way of a folder or a file', ERR_FS_EISDIR: 'in the way of a folder or a file', ENOTDIR: 'in the way of a folder or a file',
	EEXIST: 'in the way of a folder or a file', ENOTEMPTY: 'in the way of a folder or a file',
	EACCES: 'not allowed to write there', EPERM: 'not allowed to write there',
	ENAMETOOLONG: 'a name too long for this disk', ELOOP: 'reached through a link',
};

/** Why one path was left out, from the error writing or deleting it; an error about no one path is thrown on. */
function pathError(error: unknown): LeftOut {
	const why = ABOUT_ONE_PATH[(error as NodeJS.ErrnoException).code ?? ''];
	if (!why) { throw error; }
	return why;
}

/**
 * Removes `folder` and each folder above it that is left empty, up to the project's root, as git does when it removes a
 * file (dir.c remove_path: "unlink and remove leading directories if empty"). A folder that holds anything, or that
 * may not be removed, stays.
 */
async function removeEmptiedFolders(projectRoot: string, folder: string): Promise<void> {
	for (let at = folder; at !== '.'; at = dirname(at)) {
		try {
			await rmdir(join(projectRoot, at));
		} catch (error) {
			if (['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { return; }
			throw error;
		}
	}
}

/** A Windows reserved name, with or without an extension (doc/protocol.md section 1). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A path as doc/protocol.md section 1 defines it: NFC, the schema's `$defs/path` (relative, `/`-separated, no empty or
 * hidden segment, no `\` or control character, at most 240 characters), and what a pattern does not hold there: no
 * segment is a Windows reserved name or ends with `.` or a space.
 */
export function validPath(path: string): boolean {
	return path.normalize('NFC') === path && isProtocolPath(path) && path.split('/').every(segment => !RESERVED.test(segment) && !/[. ]$/.test(segment));
}
