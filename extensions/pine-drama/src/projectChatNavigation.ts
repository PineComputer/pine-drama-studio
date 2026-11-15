// Workbench navigation only. No Chat, executor or Computer is created by opening a project.
import { assertProjectRoot } from './core/projectPlace';
import type { ProjectSessions } from './core/projectSessions';
import type { Chat } from './core/store';

/** Native prepareProjectChat reply: the Chat the window restored, and whether it is a draft not sent yet. */
export interface RestoredProjectChat {
	readonly resource: string;
	readonly isUntitledDraft: boolean;
}

/**
 * One window's startup/focus sequence. The native Chat view restores the window's own last Chat (prepare). A draft or a
 * Chat of this project stays; another project's would leave the window on a Chat it cannot send from, so a fresh one
 * opens instead. No Chat is chosen by default: every Chat is a peer. A named destination is shown on every focus that
 * brings one.
 */
export function projectWindowRestorer(window: {
	scope(): ProjectSessions | undefined;
	prepare(): Promise<RestoredProjectChat | undefined>;
	fresh(): Promise<unknown>;
	takeRequested(root: string): string | undefined;
	show(key: string): Promise<unknown>;
	failed(error: unknown): void;
}): () => Promise<void> {
	let prepared = false;
	let pending = Promise.resolve();
	return () => {
		pending = pending.then(async () => {
			if (!window.scope()) { return; }
			const restored = prepared ? undefined : await window.prepare();
			prepared = true;
			// Read again: the window's folders may have changed while the native view restored.
			const project = window.scope();
			if (!project) { return; }
			if (restored && !restored.isUntitledDraft && !project.chats.some(c => c.key === restored.resource)) { await window.fresh(); }
			const requested = window.takeRequested(project.root);
			if (requested) { await window.show(requested); }
		}).catch(window.failed);
		return pending;
	};
}

export async function openProjectChat(key: string, navigation: {
	scope(): ProjectSessions | undefined;
	chat(key: string): Chat | undefined;
	show(key: string): Promise<unknown>;
	request(key: string): string;
	clear(token: string): void;
	open(root: string): Promise<void>;
}): Promise<void> {
	const project = navigation.scope();
	if (project?.chats.some(c => c.key === key)) {
		await navigation.show(key);
		return;
	}
	const conv = navigation.chat(key);
	if (!conv?.folder) { throw new Error('This conversation has no associated local project.'); }
	assertProjectRoot(conv.folder, conv.folder);
	const token = navigation.request(key);
	try { await navigation.open(conv.folder); }
	catch (error) { navigation.clear(token); throw error; }
}
