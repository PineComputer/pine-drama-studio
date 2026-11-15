// The ways files land in the project folder: a turn's result, from git's own objects, and the person's change, a "Use"
// of a past result among them (doc/protocol.md sections 3 and 4): the newest result lands, and the file's history keeps
// every earlier one. It is the write half of Codex's cloud apply (codex-rs git-utils/src/apply.rs) with no preflight,
// since media replaces whole files and history keeps what it replaces. It runs in the project's one write queue (projectHistory.ts), with the person's other writes.
// No vscode import.

import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { throughNoLink, writeWhole } from './placement';
import { blobOf, commitEntriesToHistory, commitPathsToHistory, commitTreeWith, filesOf, onDisk, runInProjectWriteQueue, treeChanges, turnTrailers, writeBlob, writtenByRunningTurns, type PineTurnIds, type SessionRefs, type TreeEntry } from './projectHistory';
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
export type LeftOut = 'no path of the project' | 'a link' | 'the same name as another but for case' | 'reached through a link' | 'in the way of a folder or a file'
	| 'not allowed to write there' | 'a name too long for this disk';

/**
 * Brings a turn's capture `to` into the project folder, in its write queue: while the turn runs (`last` false), on a
 * timer, and at its Pine turn's end (`last` true), which is the last word. The folder moves from what the turn has
 * written so far (`written`, a commit of it, projectHistory.ts sessionRefs) to the capture, path by path (writeEntries),
 * and `written` records only what was written, so a path skipped or left out is tried again.
 *
 * A path the person changed by hand is one whose disk state is not what it should be: what the turn wrote there, for a
 * path it has written; else HEAD's, or what another running turn wrote (writtenByRunningTurns). While the turn runs it is
 * not written over; at the end it is committed first, as `client-found-changes-on-disk`, so history keeps it.
 *
 * Only at the end does history move: one `pine-computer` commit, with the turn's trailers, of every path the turn
 * changed as the folder now holds it, against HEAD as it then is; a file the turn wrote and removed again is in none.
 * HEAD and the session's refs (`acked`, `captured`, `written` all at `to`) move in one transaction; while the turn runs
 * only `captured` and `written` move.
 */
export function landTurnFiles(projectRoot: string, turn: { readonly ids: PineTurnIds; readonly refs: SessionRefs; readonly acked: string; readonly written: string; readonly to: string; readonly last: boolean }):
	Promise<{ readonly landed: readonly string[]; readonly leftOut: ReadonlyMap<string, LeftOut> }> {
	const { ids, refs, acked, written, to, last } = turn;
	return runInProjectWriteQueue(projectRoot, async () => {
		const entries = await treeChanges(projectRoot, written, to);
		const own = new Map((await treeChanges(projectRoot, acked, written)).map(e => [e.path, e.blob] as const));
		const others = (await writtenByRunningTurns(projectRoot)).filter(t => t.written !== refs.written);
		const head = await filesOf(projectRoot, 'HEAD');
		// Every path the turn has touched, at the end; the ones it writes now, while it runs.
		const touched = [...new Set([...last ? own.keys() : [], ...entries.map(e => e.path)])];
		const disk = await onDisk(projectRoot, touched);
		const othersWrote = (path: string, blob: string | null) => others.some(t => t.files.has(path) && t.files.get(path) === blob);
		// A folder standing at a path is no hand edit: what is in it is judged at its own paths, and a write there is left out
		// as in the way. What another running turn wrote there is that turn's, never the person's.
		const edited = touched.filter(path => {
			const state = disk.get(path);
			return state !== 'folder' && !othersWrote(path, blobOf(state)) && (own.has(path) ? own.get(path) : head.get(path)?.blob ?? null) !== blobOf(state);
		});
		if (last && edited.length) { await commitPathsToHistory(projectRoot, 'client-found-changes-on-disk', edited, 'Changes found on disk before a turn\'s result'); }
		// The folder's names once this lands, for the case check: HEAD's, and what the turn has written so far.
		const present = [...new Set([...head.keys(), ...(await filesOf(projectRoot, written)).keys()])];
		const { landed, leftOut } = await writeEntries(projectRoot, last ? entries : entries.filter(e => !edited.includes(e.path)), present);
		if (!last) {
			await commitEntriesToHistory(projectRoot, 'pine-computer', [], '', {}, { [refs.captured]: to, [refs.written]: await commitTreeWith(projectRoot, written, landed) });
			return { landed: landed.map(e => e.path), leftOut };
		}
		// The turn's one commit: each path it touched, as the folder now holds it, where HEAD (with the hand edits recorded)
		// differs; a file another running turn wrote there is that turn's.
		const now = await filesOf(projectRoot, 'HEAD');
		const held = await onDisk(projectRoot, touched, true);
		const committed: TreeEntry[] = touched.flatMap(path => {
			const state = held.get(path);
			const file = state && state !== 'folder' ? state : null;
			const was = now.get(path);
			if ((was?.blob ?? null) === (file?.blob ?? null) && (!file || was!.mode === file.mode)) { return []; }
			if (file && othersWrote(path, file.blob)) { return []; }
			return [{ path, mode: file?.mode ?? '000000', blob: file?.blob ?? null }];
		});
		await commitEntriesToHistory(projectRoot, 'pine-computer', committed, `Turn ${ids.turn}`, turnTrailers(ids), { [refs.acked]: to, [refs.captured]: to, [refs.written]: to });
		return { landed: committed.map(e => e.path), leftOut };
	});
}

/**
 * Writes `entries` into the folder, each path on its own, so no one path keeps the rest out. A path is left out, and
 * named with why, when it is no path of the project (section 1), a link or another repository (its mode is no file's),
 * the same name as another but for case, reached through a link at the destination, or when the folder will not take
 * it there (pathError): a folder that is not empty where it writes a file, a file where it needs a folder, a folder it
 * may not write, a name too long. Only an error that is about no one path (git's, a full disk) is thrown. Deletions go
 * first, each with the folders it leaves empty (as git does, dir.c remove_path), so a file and a folder can change
 * places; then each file is streamed from its blob, receipts before their outputs (2.3).
 */
async function writeEntries(projectRoot: string, entries: readonly TreeEntry[], present: readonly string[]): Promise<{ readonly landed: TreeEntry[]; readonly leftOut: Map<string, LeftOut> }> {
	const leftOut = new Map<string, LeftOut>();
	const writes = entries.filter(e => e.blob !== null);
	const gone = new Set(entries.filter(e => e.blob === null).map(e => e.path));
	// The folder's paths once this lands (`present`, its names now), by case-folded name: a write whose name another holds
	// but for case is left out.
	const byKey = new Map<string, Set<string>>();
	for (const path of [...present.filter(path => !gone.has(path)), ...writes.map(e => e.path)]) {
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
	const receiptsFirst = (a: TreeEntry, b: TreeEntry) => Number(!a.path.endsWith(RECEIPT_SUFFIX)) - Number(!b.path.endsWith(RECEIPT_SUFFIX));
	for (const entry of landing.filter(e => e.blob !== null).sort(receiptsFirst)) {
		const file = join(projectRoot, entry.path);
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
	return { landed, leftOut };
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
	return path.normalize('NFC') === path && matches('path', path) && path.split('/').every(segment => !RESERVED.test(segment) && !/[. ]$/.test(segment));
}
