// Native session presentation scoped to one explicitly opened production root: every Chat of the project is a peer.
// No vscode import.
import { assertProjectRoot, projectIdentity } from './projectPlace';
import type { Chat } from './store';

export interface ProjectSessions {
	readonly root: string;
	readonly chats: readonly Chat[];
}

/** Pin only at explicit workspace entry; ordinary file/Chat refresh must not retarget a changed alias. */
export function sessionProjectRoot(folders: readonly string[]): string | undefined {
	if (folders.length !== 1) { return undefined; }
	const root = projectIdentity(folders[0]);
	assertProjectRoot(root, root);
	return root;
}

export function projectSessions(root: string, all: readonly Chat[]): ProjectSessions {
	// Read saved identity even when local files are temporarily unreachable; admission validates the root separately.
	return { root, chats: all.filter(c => c.folder === root) };
}
