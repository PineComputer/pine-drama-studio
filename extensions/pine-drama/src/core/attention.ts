// What waits for the person: a session whose agent asks a question, which its chat holds. No vscode import.

import type { Chat } from './store';

export interface WaitingItem {
	readonly key: string;
	readonly label: string;
	/** What it waits for, in the status bar's words. */
	readonly reason: string;
}

/** The sessions that wait for the person, most recently active first, as the pickers order them. */
export function waitingItems(
	chats: readonly Chat[],
	reason: (conv: Chat) => string,
	title: (conv: Chat) => string = conv => conv.label,
): WaitingItem[] {
	return chats
		.filter(conv => conv.state === 'needs_input')
		.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
		.map(conv => ({ key: conv.key, label: title(conv), reason: reason(conv) }));
}

/** The status bar's text: how many sessions, how many running, how many wait. */
export function statusText(total: number, running: number, waiting: number): string {
	return `Pine · ${total} ${total === 1 ? 'session' : 'sessions'}${running ? ` · ${running} running` : ''}${waiting ? ` · ${waiting} waiting for you` : ''}`;
}
