// Shows a Chat in this window's Chat view: the right region holds every human–AI exchange of the window the
// person works in. The extension API opens a chat session only as an editor (`vscode.open`
// on its resource). Code-OSS's "Move Chat into Side Bar" (workbench.action.chat.openInSidebar, chatMoveActions.ts,
// moveToSidebar) then moves the active chat editor into the Chat view with IChatWidgetService.openSession(resource,
// ChatViewPaneTarget), the call the Agent Sessions list makes on click, and closes the editor. No command takes a
// session resource for the view directly.
// When the Chat view already shows the session (a restored window), `vscode.open` still opens a second chat editor
// on it and the move keeps the view as it is and leaves that editor open (chatWidgetService.ts, prepareSessionForMove);
// that editor is closed here, so the Chat stays in one place.
// No vscode import, so it is tested without the workbench (src/test/chatView.test.ts).

export const OPEN = 'vscode.open';
export const MOVE_INTO_CHAT_VIEW = 'workbench.action.chat.openInSidebar';
/** Code-OSS's Chat: Open, whose `query` with `isPartialQuery` fills the input without sending (chatActions.ts). */
export const CHAT_OPEN = 'workbench.action.chat.open';

export type Execute = (command: string, ...args: unknown[]) => PromiseLike<unknown>;

/** The editor tabs, as vscode.window.tabGroups shows them. */
export interface Tabs<T> {
	active(): T | undefined;
	isOpen(tab: T): boolean;
	close(tab: T): PromiseLike<unknown>;
}

/** Opens the Chat's chat, then moves it from the editor area into the Chat view. */
export async function showInChatView<T>(execute: Execute, tabs: Tabs<T>, resource: unknown): Promise<void> {
	await execute(OPEN, resource);
	const opened = tabs.active();
	await execute(MOVE_INTO_CHAT_VIEW);
	if (opened !== undefined && tabs.isOpen(opened)) {
		await tabs.close(opened);
	}
}

/**
 * Shows the Chat's chat in the Chat view with `query` in its input, not sent: sending stays the person's action, as
 * the canvas's and the seg editor's Generate leave it (episodeCanvas.ts, segEditor.ts).
 */
export async function startInChatView<T>(execute: Execute, tabs: Tabs<T>, resource: unknown, query: string): Promise<void> {
	await showInChatView(execute, tabs, resource);
	await execute(CHAT_OPEN, { query, isPartialQuery: true });
}
