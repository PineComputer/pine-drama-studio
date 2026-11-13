// Native session presentation scoped to one explicitly opened production root.
// A missing primary is a local entry, not fabricated history or execution admission. No vscode import.
import { createHash } from 'node:crypto';
import { assertProjectRoot, projectIdentity } from './projectPlace';
import type { Chat } from './store';

export interface ProjectSessions {
	readonly root: string;
	readonly chats: readonly Chat[];
	readonly mainKey: string;
	readonly main: Chat | undefined;
}

/** Pin only at explicit workspace entry; ordinary file/Chat refresh must not retarget a changed alias. */
export function sessionProjectRoot(folders: readonly string[]): string | undefined {
	if (folders.length !== 1) { return undefined; }
	const root = projectIdentity(folders[0]);
	assertProjectRoot(root, root);
	return root;
}

/** Stable entry URI: two windows get the same unsent main without storing a Chat on navigation. */
export function projectSessions(root: string, all: readonly Chat[]): ProjectSessions {
	// Read saved identity even when local files are temporarily unreachable; admission validates the root separately.
	const chats = all.filter(c => c.folder === root);
	const main = chats.find(c => c.project_role === 'main');
	const mainKey = main?.key ?? `pine-computer:/project-${createHash('sha256').update(root).digest('hex')}`;
	// A first send can leave a reserved but unbound row. It grants no history/authority until explicit admission.
	const conflict = all.find(c => c.key === mainKey && c.folder !== null && c.folder !== root);
	if (conflict) { throw new Error('The Project Chat entry belongs to another conversation. Open the intended project explicitly.'); }
	return { root, chats, mainKey, main };
}
