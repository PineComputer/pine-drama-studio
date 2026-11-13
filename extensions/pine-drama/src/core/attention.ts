// What waits for the person, and where a click on "waiting for you" takes them. No vscode import.
//
// A session waits either on a decision, an open review with items, which the Review view shows, or on a question in
// words, which only its chat holds. The status bar counts every session, while a session's project window shows only
// its own in Review. So a click goes to the waiting item by its kind and this window's scope, never to a Review that
// does not show it.

import type { Chat } from './store';

export interface WaitingItem {
	readonly key: string;
	readonly label: string;
	/** What it waits for, in the status bar's words (`waitingReason`). */
	readonly reason: string;
	/** The open review it waits on; absent for a question in words. */
	readonly reviewId?: string;
}

export type Destination =
	/** The review is in this window's Review view: reveal it there. */
	| { readonly to: 'review'; readonly reviewId: string }
	/** A question in words, or a review no window can show: open the session in this window's Chat. */
	| { readonly to: 'chat' }
	/** The review belongs to another session's project window: open or focus that window and reveal it there. */
	| { readonly to: 'window'; readonly reviewId: string };

/** The sessions that wait for the person, most recently active first, as the pickers order them. */
export function waitingItems(
	chats: readonly Chat[],
	review: (key: string) => { id: string; items: number } | undefined,
	reason: (conv: Chat) => string,
	title: (conv: Chat) => string = conv => conv.label,
): WaitingItem[] {
	return chats
		.filter(conv => conv.state === 'needs_input')
		.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
		.map(conv => {
			const open = review(conv.key);
			return { key: conv.key, label: title(conv), reason: reason(conv), ...(open && open.items > 0 ? { reviewId: open.id } : {}) };
		});
}

/**
 * Where a waiting item is shown. `members` are the Chats of this window's project (projectSessions; none in a window
 * with no project): its Review index holds every review of the project, so a review of any of them is shown
 * here (fix plan, item 9). `hasProject` says whether the item's session has a project folder a window can open.
 */
export function destinationOf(item: WaitingItem, members: readonly string[], hasProject: boolean): Destination {
	if (!item.reviewId) {
		return { to: 'chat' };
	}
	if (members.includes(item.key)) {
		return { to: 'review', reviewId: item.reviewId };
	}
	return hasProject ? { to: 'window', reviewId: item.reviewId } : { to: 'chat' };
}

/** The status bar's text: how many sessions, how many running, how many wait. */
export function statusText(total: number, running: number, waiting: number): string {
	return `Pine · ${total} ${total === 1 ? 'session' : 'sessions'}${running ? ` · ${running} running` : ''}${waiting ? ` · ${waiting} waiting for you` : ''}`;
}
