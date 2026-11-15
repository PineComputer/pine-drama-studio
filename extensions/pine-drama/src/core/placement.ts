// Containment for the drama's project: a place is judged by its real path,
// the real path of its deepest existing ancestor, then the rest, so a symlinked drama/ or subfolder that points out is
// refused, never followed. No vscode import.

import { randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** A session's project root, and the folder nothing it settles may leave: its bound folder, or the root itself. */
/** Whether a file system error says there is no file at the path: none there, or a file where a folder of it would be. */
export const noFileThere = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** The real path `path` has or would have once created; undefined when it passes through a link that leads nowhere. */
function realTarget(path: string): string | undefined {
	const rest: string[] = [];
	let existing = resolve(path);
	for (;;) {
		try {
			return join(realpathSync(existing), ...rest);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		try {
			lstatSync(existing);
			return undefined; // it is there but does not resolve: a dangling link
		} catch {
			// not there: judge its parent
		}
		const parent = dirname(existing);
		if (parent === existing) {
			return join(existing, ...rest);
		}
		rest.unshift(basename(existing));
		existing = parent;
	}
}

/**
 * Whether `path`, by its real path, is the boundary or inside it: a project root in its bound folder, which may be
 * reached through a link (an alias of the folder).
 */
export function within(boundary: string, path: string): boolean {
	const real = realTarget(path);
	const base = realTarget(boundary);
	return real !== undefined && base !== undefined && (real === base || real.startsWith(base + sep));
}

/**
 * Whether the project-relative `path` passes through no link below `root`, so it is where its name says: the one rule
 * for a path written or read inside the project (git refuses a path beyond a symbolic link, and a folder linked to .git
 * must never be written through). The root itself may be reached through one (within).
 */
export function throughNoLink(root: string, path: string): boolean {
	const real = realTarget(root);
	return !!real && realTarget(join(root, ...path.split('/'))) === join(real, ...path.split('/'));
}

/**
 * Writes `file` whole: a sibling temporary file, fsync, then rename. The temporary file's name is unique to the write
 * (a random UUID, as npm's write-file-atomic makes one per call): two writes in the same folder at the same millisecond,
 * such as two sessions recording the same holder (B9), named one file, so one rename found it gone.
 */
export async function writeWhole(file: string, text: string | Uint8Array): Promise<void> {
	const temp = join(dirname(file), `.${randomUUID()}.tmp`);
	const handle = await open(temp, 'w');
	try {
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

/**
 * The first of `name`, `numbered(2)`, `numbered(3)`, … that no entry of the folder `folder` holds and `planned` does not
 * name, by any case: two names that differ only by case are one path (doc/protocol.md section 1).
 */
export function unusedName(folder: string, name: string, numbered: (n: number) => string, planned: Iterable<string> = []): string {
	const taken = new Set([...existsSync(folder) ? readdirSync(folder) : [], ...planned].map(entry => entry.toLowerCase()));
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? name : numbered(n);
		if (!taken.has(candidate.toLowerCase())) { return candidate; }
	}
}

/** Copies `source` to `target` whole, as writeWhole writes: a clone where the file system has them (APFS), a copy otherwise, then a rename into place. */
export async function copyWhole(source: string, target: string): Promise<void> {
	const temp = join(dirname(target), `.${randomUUID()}.tmp`);
	await copyFile(source, temp, constants.COPYFILE_FICLONE);
	try {
		await rename(temp, target);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}
