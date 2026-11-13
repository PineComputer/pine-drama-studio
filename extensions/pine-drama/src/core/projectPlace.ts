// One explicit project root; no child-layout discovery or migration. No vscode import.

import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import type { ProjectPlace } from './placement';

/** One shared identity even when two windows reach the same folder through different aliases. */
export function projectIdentity(root: string): string {
	root = resolve(root);
	return existsSync(root) ? realpathSync(root) : join(projectIdentity(dirname(resolve(root))), basename(root));
}

/** A pinned admission must remain an existing directory at the same canonical path. */
export function assertProjectRoot(root: string, expected: string): void {
	if (!existsSync(root) || !statSync(root).isDirectory() || projectIdentity(root) !== expected) {
		throw new Error(`The project root ${root} is missing or its real path changed. Open the intended project explicitly.`);
	}
}

/** The session's project folder: one per Chat, under the folder the caller gives. */
export function projectFolder(projectsRoot: string, key: string): string {
	const name = key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
	return join(projectsRoot, `${name}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`);
}

/**
 * The opened project folder is its production root. No child-layout discovery or migration.
 */
export function projectRootOf(projectsRoot: string, conv: { readonly key: string; readonly folder: string | null }): string {
	return conv.folder ?? projectFolder(projectsRoot, conv.key);
}

/** The session's project root, and the folder nothing it settles may leave: the bound folder, else the root itself. */
export function projectPlaceOf(projectsRoot: string, conv: { readonly key: string; readonly folder: string | null }): ProjectPlace {
	const root = projectRootOf(projectsRoot, conv);
	if (conv.folder) { assertProjectRoot(root, root); }
	return { root, boundary: root };
}

/**
 * The view's Chat for the window's project. A sole matching history remains viewable; with several, the Project Chat
 * rather than a guess from creation order. Scoped native navigation is S2.
 */
export function owningChat<T extends { readonly key: string; readonly folder: string | null; readonly project_role?: 'main' | null }>(chats: readonly T[], projectsRoot: string, windowFolders: readonly string[]): T | undefined {
	const open = new Set(windowFolders.map(projectIdentity));
	const matches = chats.filter(c => open.has(projectIdentity(projectRootOf(projectsRoot, c))));
	return matches.length === 1 ? matches[0] : matches.find(c => c.project_role === 'main');
}

/** A file's SHA-256, streamed. */
export function hashFile(path: string): string {
	const hash = createHash('sha256');
	const fd = openSync(path, 'r');
	try {
		const chunk = Buffer.alloc(1 << 20);
		for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
			hash.update(chunk.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest('hex');
}

/** Why a returned path cannot be installed, or undefined: it must stay inside the drama's folder (containment, drama-folder section 3). */
export function refusedPath(rel: string): string | undefined {
	if (isAbsolute(rel) || rel.includes('\\')) {
		return `${rel} is not a path inside the drama's folder`;
	}
	const clean = posix.normalize(rel);
	if (clean !== rel || clean.startsWith('../') || clean === '..' || clean.startsWith('/')) {
		return `${rel} leaves the drama's folder`;
	}
	return undefined;
}
