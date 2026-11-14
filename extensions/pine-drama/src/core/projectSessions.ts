// Native session presentation scoped to one explicitly opened production root.
// A missing primary is a local entry, not fabricated history or execution admission. No vscode import.
import { createHash } from 'node:crypto';
import { episodeIn } from './project';
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

/** The project's entry URI, fixed by its root: two windows get the same unsent main without storing a Chat on navigation. */
const entryKey = (root: string) => `pine-computer:/project-${createHash('sha256').update(root).digest('hex')}`;

/**
 * The session that owns the item `id` of the project, where its Generate asks: an episode's items its
 * episode's one session, every other item, shared, the Project Chat, which may add to any shared object (doc/protocol.md, section 1). An episode's key is
 * fixed by the project and the episode as the entry's is, so asking again, sent or not, opens the same session, as
 * Code-OSS reveals a chat session already open rather than opening it again (chatWidgetService.ts, openSession).
 */
export function ownerOf(project: ProjectSessions, id: string): string {
	const episode = episodeIn(id);
	return episode ? `${entryKey(project.root)}/${episode}` : project.mainKey;
}

export function projectSessions(root: string, all: readonly Chat[]): ProjectSessions {
	// Read saved identity even when local files are temporarily unreachable; admission validates the root separately.
	const chats = all.filter(c => c.folder === root);
	const main = chats.find(c => c.project_role === 'main');
	const mainKey = main?.key ?? entryKey(root);
	// A first send can leave a reserved but unbound row. It grants no history/authority until explicit admission.
	const conflict = all.find(c => c.key === mainKey && c.folder !== null && c.folder !== root);
	if (conflict) { throw new Error('The Project Chat entry belongs to another conversation. Open the intended project explicitly.'); }
	return { root, chats, mainKey, main };
}
