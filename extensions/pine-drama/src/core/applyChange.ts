// The one way files land in the project folder: a turn's result, the person's change, a "Use" of a past result, or an
// Undo (doc/protocol.md sections 3 and 4.4): the newest result lands, and the file's history keeps every earlier one. It is the write half of
// Codex's cloud apply (codex-rs git-utils/src/apply.rs) with no preflight, since media replaces whole files and history
// keeps what it replaces. It runs in the project's one write queue (projectHistory.ts), with the person's other writes.
// No vscode import.

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { throughNoLink, writeWhole } from './placement';
import { commitPathsToHistory, historyHasTurn, runInProjectWriteQueue, turnTrailers } from './projectHistory';
import { matches, RECEIPT_SUFFIX } from './protocol';
import { sha256, sha256OfFile } from './sha256';

/** Files to land: each path with the sha256 of its new bytes, or null to delete what is there (a file, or a folder whole). */
export interface ProjectFolderChange {
	readonly filesAfterChange: Readonly<Record<string, string | null>>;
	readonly author: 'pine-computer' | 'person';
	readonly commitMessage: string;
	/** The turn whose result it is: its commit carries Pine-Turn-Id, by which it is found landed. */
	readonly turnId?: string;
}

/** What applying a change did. */
export type ChangeApplied =
	| 'written and committed'
	/** A commit carries the turn's trailer already: nothing was written. */
	| 'already in history'
	/**
	 * Every path held what the change gives it already: nothing was written. A turn's result (a crash's files a
	 * found-on-disk commit took) is recorded by a commit of its trailer alone.
	 */
	| 'already on disk';

/** A change names a file that is not a path of the project (doc/protocol.md, section 1): nothing of it is written. */
export class NotAProjectPathError extends Error {
	constructor(readonly paths: readonly string[]) { super(`not a path of the project: ${paths.join(', ')}`); }
}

/**
 * Applies `change` to the project folder at `projectRoot`, in its write queue: landed already, else every file
 * written (a temporary sibling, then a rename; receipts before their outputs; null deletes) and one commit of exactly
 * those paths. `readFileBytesBySha256` gives a file's bytes: the Computer's for a turn's result, the history's for a Use or
 * an Undo; each is checked against its hash, and all are read before anything is written.
 */
export function applyChangeToProjectFolder(projectRoot: string, change: ProjectFolderChange,
	readFileBytesBySha256: (sha256: string) => Promise<Buffer>): Promise<ChangeApplied> {
	return runInProjectWriteQueue(projectRoot, () => land(projectRoot, change, readFileBytesBySha256));
}

/** applyChangeToProjectFolder's work, inside the project's write queue. */
async function land(projectRoot: string, change: ProjectFolderChange, readFileBytesBySha256: (sha256: string) => Promise<Buffer>): Promise<ChangeApplied> {
	// A turn's result landed before is skipped whatever the folder holds now, so landing it again is a no-op.
	if (change.turnId && await historyHasTurn(projectRoot, change.turnId)) {
		return 'already in history';
	}
	const paths = Object.keys(change.filesAfterChange);
	const keys = paths.map(path => path.toLowerCase());
	// Two names that differ only by case are one path (section 1), so a change naming one twice is not the project's.
	// A path through a link is not the project's (placement.ts throughNoLink).
	const notPaths = paths.filter((path, i) => !validPath(path) || !throughNoLink(projectRoot, path) || keys.indexOf(keys[i]) !== i);
	if (notPaths.length) { throw new NotAProjectPathError(notPaths); }
	const trailers = change.turnId ? turnTrailers(change.turnId) : {};
	// A path to delete is as the change wants it when nothing is there, so what goes is never read (git rm -r).
	const asWanted = async (path: string) => change.filesAfterChange[path] === null ? !existsSync(join(projectRoot, path)) : await sha256OfFile(join(projectRoot, path)) === change.filesAfterChange[path];
	if ((await Promise.all(paths.map(asWanted))).every(Boolean)) {
		if (change.turnId) { await commitPathsToHistory(projectRoot, change.author, paths, change.commitMessage, trailers); }
		return 'already on disk';
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
			await rm(file, { recursive: true, force: true });
		} else {
			await mkdir(dirname(file), { recursive: true });
			await writeWhole(file, got);
		}
	}
	await commitPathsToHistory(projectRoot, change.author, paths, change.commitMessage, trailers);
	return 'written and committed';
}

/**
 * The person's change (doc/protocol.md section 3), landed as one `person` change of exactly its paths: `files` gives
 * each path with its new bytes or text, or null to delete what is there. It runs inside the write queue, so the names it
 * picks and what it reads of the folder are as the folder is when it lands.
 */
export function applyPersonChange(projectRoot: string, commitMessage: string,
	files: () => Promise<Iterable<readonly [string, Buffer | string | null]>>): Promise<ChangeApplied> {
	return runInProjectWriteQueue(projectRoot, async () => {
		const bytes = new Map([...await files()].map(([path, given]) => [path, typeof given === 'string' ? Buffer.from(given) : given] as const));
		const bySha = new Map([...bytes.values()].filter((b): b is Buffer => b !== null).map(b => [sha256(b), b]));
		return land(projectRoot, {
			filesAfterChange: Object.fromEntries([...bytes].map(([path, b]) => [path, b === null ? null : sha256(b)])),
			author: 'person', commitMessage,
		}, async hash => bySha.get(hash)!);
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
