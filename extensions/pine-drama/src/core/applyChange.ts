// The ways files land in the project folder: a turn's result, from git's own objects, and the person's change, a "Use"
// of a past result among them (doc/protocol.md sections 3 and 4): the newest result lands, and the file's history keeps
// every earlier one. It is the write half of Codex's cloud apply (codex-rs git-utils/src/apply.rs) with no preflight,
// since media replaces whole files and history keeps what it replaces. It runs in the project's one write queue (projectHistory.ts), with the person's other writes.
// No vscode import.

import { existsSync, lstatSync } from 'node:fs';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { throughNoLink, writeWhole } from './placement';
import { commitEntriesToHistory, commitPathsToHistory, listPathsOfHead, runInProjectWriteQueue, turnTrailers, writeBlob, type PineTurnIds, type TreeEntry } from './projectHistory';
import { matches, RECEIPT_SUFFIX } from './protocol';
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
		const bytes = new Map([...await files()].map(([path, given]) => [path, typeof given === 'string' ? Buffer.from(given) : given] as const));
		const paths = [...bytes.keys()];
		const keys = paths.map(path => path.toLowerCase());
		// Two names that differ only by case are one path (section 1), so a change naming one twice is not the project's.
		// A path through a link is not the project's (placement.ts throughNoLink).
		const notPaths = paths.filter((path, i) => !validPath(path) || !throughNoLink(projectRoot, path) || keys.indexOf(keys[i]) !== i);
		if (notPaths.length) { throw new NotAProjectPathError(notPaths); }
		// A path to delete is as the change wants it when nothing is there, so what goes is never read (git rm -r).
		const asWanted = async (path: string) => { const got = bytes.get(path)!; return got === null ? !existsSync(join(projectRoot, path)) : await sha256OfFile(join(projectRoot, path)) === sha256(got); };
		if ((await Promise.all(paths.map(asWanted))).every(Boolean)) { return 'already on disk'; }
		// Receipts before the outputs they describe (2.3), so an output is never on disk without its receipt.
		for (const path of [...paths].sort((a, b) => Number(!a.endsWith(RECEIPT_SUFFIX)) - Number(!b.endsWith(RECEIPT_SUFFIX)))) {
			const file = join(projectRoot, path);
			const got = bytes.get(path)!;
			if (got === null) {
				await rm(file, { recursive: true, force: true });
			} else {
				await mkdir(dirname(file), { recursive: true });
				await writeWhole(file, got);
			}
		}
		await commitPathsToHistory(projectRoot, 'person', paths, commitMessage);
		return 'written and committed';
	});
}

/** Why a path of a turn's result was left out of the project, said to the person. */
export type LeftOut = 'no path of the project' | 'a link' | 'the same name as another but for case' | 'reached through a link' | 'in the way of a folder or a file';

/**
 * Lands a turn's result in the project folder, in its write queue: `entries`, the paths it changed in git's own objects
 * (projectHistory.ts treeChanges), each on its own, so no one path keeps the rest out. A path is left out, and named
 * with why, when it is no path of the project (section 1), a link or another repository (its mode is no file's), the same
 * name as another but for case, reached through a link at the destination, or in the way: a folder that is not empty
 * where it writes a file, or a file where it needs a folder. Deletions go first, each with the folders it leaves empty
 * (as git does, dir.c remove_path), so a file and a folder can change places; then each file is streamed from its blob.
 * One `pine-computer` commit of exactly what landed, with the turn's trailers, moves HEAD and `refs` together.
 */
export function landTurnResult(projectRoot: string, ids: PineTurnIds, entries: readonly TreeEntry[], refs: Readonly<Record<string, string>>):
	Promise<{ readonly landed: readonly string[]; readonly leftOut: ReadonlyMap<string, LeftOut> }> {
	return runInProjectWriteQueue(projectRoot, async () => {
		const leftOut = new Map<string, LeftOut>();
		const writes = entries.filter(e => e.blob !== null);
		const gone = new Set(entries.filter(e => e.blob === null).map(e => e.path));
		// The project's paths once this lands, by case-folded name: a write whose name another holds but for case is left out.
		const byKey = new Map<string, Set<string>>();
		for (const path of [...(await listPathsOfHead(projectRoot)).filter(path => !gone.has(path)), ...writes.map(e => e.path)]) {
			byKey.set(path.toLowerCase(), new Set([...byKey.get(path.toLowerCase()) ?? [], path]));
		}
		for (const { path, mode, blob } of entries) {
			const why: LeftOut | undefined = !validPath(path) ? 'no path of the project' : blob === null ? undefined : mode !== '100644' && mode !== '100755' ? 'a link'
				: byKey.get(path.toLowerCase())!.size > 1 ? 'the same name as another but for case' : undefined;
			if (why) { leftOut.set(path, why); }
		}
		const landing = entries.filter(e => !leftOut.has(e.path));
		// A file the person edited by hand there is recorded first, so the result replaces a version history keeps.
		const edited = landing.map(e => e.path).filter(path => { try { return lstatSync(join(projectRoot, path)).isFile(); } catch { return false; } });
		if (edited.length) { await commitPathsToHistory(projectRoot, 'client-found-changes-on-disk', edited, 'Changes found on disk before a turn\'s result'); }
		const landed: TreeEntry[] = [];
		for (const entry of landing.filter(e => e.blob === null)) {
			try {
				if (!throughNoLink(projectRoot, entry.path)) { leftOut.set(entry.path, 'reached through a link'); continue; }
				await rm(join(projectRoot, entry.path), { force: true });
			} catch (error) {
				if (!inTheWay(error)) { throw error; }
				leftOut.set(entry.path, 'in the way of a folder or a file');
				continue;
			}
			await removeEmptiedFolders(projectRoot, dirname(entry.path));
			landed.push(entry);
		}
		// Each write's destination is judged once the deletions are done, as the folder then is (placement.ts throughNoLink);
		// receipts go before the outputs they describe (2.3), so an output is never on disk without its receipt.
		const receiptsFirst = (a: TreeEntry, b: TreeEntry) => Number(!a.path.endsWith(RECEIPT_SUFFIX)) - Number(!b.path.endsWith(RECEIPT_SUFFIX));
		for (const entry of landing.filter(e => e.blob !== null).sort(receiptsFirst)) {
			const file = join(projectRoot, entry.path);
			try {
				if (!throughNoLink(projectRoot, entry.path)) { leftOut.set(entry.path, 'reached through a link'); continue; }
				await mkdir(dirname(file), { recursive: true });
				await writeBlob(projectRoot, entry.blob!, file, entry.mode === '100755');
			} catch (error) {
				if (!inTheWay(error)) { throw error; }
				leftOut.set(entry.path, 'in the way of a folder or a file');
				continue;
			}
			landed.push(entry);
		}
		await commitEntriesToHistory(projectRoot, 'pine-computer', landed, `Turn ${ids.turn}`, turnTrailers(ids), refs);
		return { landed: landed.map(e => e.path), leftOut };
	});
}

/** A file system error that says something else stands where a path goes: a folder for a file, a file for a folder. */
const inTheWay = (error: unknown): boolean => ['EISDIR', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY', 'ERR_FS_EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/**
 * Removes `folder` and each folder above it that is left empty, up to the project's root, as git does when it removes a
 * file (dir.c remove_path: "unlink and remove leading directories if empty"). A folder that holds anything stays.
 */
async function removeEmptiedFolders(projectRoot: string, folder: string): Promise<void> {
	for (let at = folder; at !== '.'; at = dirname(at)) {
		try {
			await rmdir(join(projectRoot, at));
		} catch (error) {
			if (['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return; }
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
	return path.normalize('NFC') === path && matches('path', path) && path.split('/').every(segment => !RESERVED.test(segment) && !/[. ]$/.test(segment));
}
