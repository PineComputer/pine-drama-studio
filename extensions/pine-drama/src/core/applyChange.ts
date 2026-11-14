// The one way files land in the project folder from a turn's result, a "Use" of a past result, or an Undo
// (doc/protocol.md 4.4): the newest result lands, and the file's history keeps every earlier one. It is the write half of
// Codex's cloud apply (codex-rs git-utils/src/apply.rs) with no preflight, since media replaces whole files and history
// keeps what it replaces. It runs in the project's one write queue (projectHistory.ts), with the person's other writes.
// No vscode import.

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeWhole } from './choices';
import { throughNoLink } from './placement';
import { commitPathsToHistory, historyHasTurnChange, runInProjectWriteQueue, turnChangeTrailers } from './projectHistory';
import { matches, RECEIPT_SUFFIX } from './protocol';
import { sha256, sha256OfFileOnDisk } from './sha256';

/** Files to land: each path with the sha256 of its new bytes, or null to delete it. */
export interface ProjectFolderChange {
	readonly filesAfterChange: Readonly<Record<string, string | null>>;
	readonly author: 'pine-computer' | 'person';
	readonly commitMessage: string;
	/** A turn's change (4.3): its commit carries Pine-Turn-Id and Pine-Change-Number, by which it is found resolved. */
	readonly turnChange?: { readonly turnId: string; readonly changeNumber: number };
}

/** What applying a change did. */
export type ChangeApplied =
	| 'written and committed'
	/** A commit carries its trailers already: nothing was written. */
	| 'already in history'
	/** Every file held its bytes already (a crash's files a found-on-disk commit took): recorded by a commit of its trailers. */
	| 'already on disk, recorded';

/** A change names a file that is not a path of the project (doc/protocol.md, section 1): nothing of it is written. */
export class NotAProjectPathError extends Error {
	constructor(readonly paths: readonly string[]) { super(`not a path of the project: ${paths.join(', ')}`); }
}

/**
 * Applies `change` to the project folder at `projectRoot` (4.4), in its write queue: resolved already, else every file
 * written (a temporary sibling, then a rename; receipts before their outputs; null deletes) and one commit of exactly
 * those paths. `readFileBytesBySha256` gives a file's bytes: the store's for a turn's change, the history's for a Use or
 * an Undo; each is checked against its hash, and all are read before anything is written.
 */
export function applyChangeToProjectFolder(projectRoot: string, change: ProjectFolderChange,
	readFileBytesBySha256: (sha256: string) => Promise<Buffer>): Promise<ChangeApplied> {
	return runInProjectWriteQueue(projectRoot, async () => {
		// Resolved first (4.4 step 1): a change applied before is skipped whatever the folder holds now.
		if (change.turnChange && await historyHasTurnChange(projectRoot, change.turnChange.turnId, change.turnChange.changeNumber)) {
			return 'already in history';
		}
		const paths = Object.keys(change.filesAfterChange);
		const keys = paths.map(path => path.toLowerCase());
		// Two names that differ only by case are one path (section 1), so a change naming one twice is not the project's.
		// A path through a link is not the project's (placement.ts throughNoLink).
		const notPaths = paths.filter((path, i) => !validPath(path) || !throughNoLink(projectRoot, path) || keys.indexOf(keys[i]) !== i);
		if (notPaths.length) { throw new NotAProjectPathError(notPaths); }
		const trailers = change.turnChange ? turnChangeTrailers(change.turnChange.turnId, change.turnChange.changeNumber) : {};
		const onDisk = paths.map(path => sha256OfFileOnDisk(join(projectRoot, path)));
		if (change.turnChange && paths.every((path, i) => onDisk[i] === change.filesAfterChange[path])) {
			await commitPathsToHistory(projectRoot, change.author, paths, change.commitMessage, trailers);
			return 'already on disk, recorded';
		}
		const bytes = new Map(await Promise.all(paths.map(async path => {
			const hash = change.filesAfterChange[path];
			if (hash === null) { return [path, null] as const; }
			const got = await readFileBytesBySha256(hash);
			if (sha256(got) !== hash) { throw new Error(`${path}: the bytes given for ${hash} do not match it`); }
			return [path, got] as const;
		})));
		// Receipts before the outputs they describe (2.3), so an output is never on disk without its receipt.
		for (const path of [...paths].sort((a, b) => Number(!a.endsWith(RECEIPT_SUFFIX)) - Number(!b.endsWith(RECEIPT_SUFFIX)))) {
			const file = join(projectRoot, path);
			const got = bytes.get(path)!;
			if (got === null) {
				await rm(file, { force: true });
			} else {
				await mkdir(dirname(file), { recursive: true });
				await writeWhole(file, got);
			}
		}
		await commitPathsToHistory(projectRoot, change.author, paths, change.commitMessage, trailers);
		return 'written and committed';
	});
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
