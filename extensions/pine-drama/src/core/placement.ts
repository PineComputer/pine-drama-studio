// Containment for the drama's project: a place is judged by its real path,
// the real path of its deepest existing ancestor, then the rest, so a symlinked drama/ or subfolder that points out is
// refused, never followed. No vscode import.

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** A session's project root, and the folder nothing it settles may leave: its bound folder, or the root itself. */
export interface ProjectPlace {
	readonly root: string;
	readonly boundary: string;
}

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

/** Whether `path`, by its real path, is the boundary or inside it. */
export function within(boundary: string, path: string): boolean {
	const real = realTarget(path);
	const base = realTarget(boundary);
	return real !== undefined && base !== undefined && (real === base || real.startsWith(base + sep));
}
