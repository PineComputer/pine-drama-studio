// One explicit project root; no child-layout discovery or migration. No vscode import.

import { sha256 } from './sha256';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
	return join(projectsRoot, `${name}-${sha256(key).slice(0, 8)}`);
}

/**
 * The opened project folder is its production root. No child-layout discovery or migration.
 */
export function projectRootOf(projectsRoot: string, conv: { readonly key: string; readonly folder: string | null }): string {
	return conv.folder ?? projectFolder(projectsRoot, conv.key);
}

/** The folder nothing the session settles may leave: its project root, checked when the session is bound to a folder. */
export function projectBoundaryOf(projectsRoot: string, conv: { readonly key: string; readonly folder: string | null }): string {
	const root = projectRootOf(projectsRoot, conv);
	if (conv.folder) { assertProjectRoot(root, root); }
	return root;
}

