// Workbench navigation only. No Chat, executor or Computer is created by opening a project.
import { assertProjectRoot } from './core/projectPlace';
import type { ProjectSessions } from './core/projectSessions';
import type { Chat } from './core/store';

/** Native prepareProjectChat reply: draft eligibility is derived by the workbench, before first-send materialization. */
export interface RestoredProjectChat {
	readonly resource: string;
	readonly isUntitledDraft: boolean;
}

/** A named destination wins; otherwise preserve a related restored Chat and default only when none is selected. */
export function initialProjectChat(project: ProjectSessions | undefined, restored?: RestoredProjectChat, requested?: string): string | undefined {
	if (!project) { return undefined; }
	const contains = (key: string | undefined) => key === project.mainKey || project.chats.some(c => c.key === key);
	if (requested && contains(requested)) { return requested; }
	return restored?.isUntitledDraft || contains(restored?.resource) ? undefined : project.mainKey;
}

/** One window's startup/focus sequence: the restored or default Chat, then a named destination, then a Review asked for. */
export function projectWindowRestorer(window: {
	scope(): ProjectSessions | undefined;
	prepare(mainKey: string): Promise<RestoredProjectChat | undefined>;
	takeRequested(root: string): string | undefined;
	show(key: string): Promise<unknown>;
	review(): Promise<unknown>;
	failed(error: unknown): void;
}): () => Promise<void> {
	// What must not repeat is the default selection, not a successful startup: it is consumed when chosen, before
	// show, so a later failure is reported and never re-applies it, as a Code-OSS window passes
	// LifecyclePhase.Restored once (lifecycle.ts:188-216 at the pin). A named request is still honoured on every focus.
	let defaultChosen = false;
	let pending = Promise.resolve();
	return () => {
		pending = pending.then(async () => {
			let project = window.scope();
			const restored = !defaultChosen && project ? await window.prepare(project.mainKey) : undefined;
			project = window.scope();
			const requested = project && window.takeRequested(project.root);
			const key = defaultChosen ? undefined : initialProjectChat(project, restored);
			defaultChosen = true;
			if (!requested && key) { await window.show(key); }
			if (requested) { await window.show(requested); }
			await window.review();
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
	if (project && (project.mainKey === key || project.chats.some(c => c.key === key))) {
		// The unsent main entry is valid here without fabricating a persisted Chat.
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
