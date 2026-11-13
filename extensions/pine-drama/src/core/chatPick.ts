import type { Chat } from './store';

// The rows of every "which Chat?" pick: Attach Files, Send Project, Open Session's Project. The Chat
// shown in Chat cannot be read: the one API that names it, window.activeChatPanelSessionResource (vscode.proposed.chatParticipantPrivate.d.ts), is set
// only for local chat sessions (Code-OSS mainThreadChatAgents2.ts, _acceptActiveChatSession) and is undefined for a
// Pine Chat. So the person always chooses, and the rows come newest activity first (the store's updated_at, set
// on every change of the Chat, store.ts updateChat): the Chat just written to is the highlighted
// row, where the store's own order (created_at) put the oldest one there (2026-11-02, a new drama's brief went to
// yesterday's Chat).

interface ChatRow {
	key: string;
	label: string;
	description: string;
}

/** The sessions to choose from, the most recently active first, titled as the sessions list titles them (`title`, change 8). */
export function chatRows(chats: readonly Chat[], title: (key: string) => string | undefined = () => undefined): ChatRow[] {
	return [...chats]
		.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
		.map(conv => ({
			key: conv.key,
			label: title(conv.key) ?? conv.label,
			description: `last active ${conv.updated_at.slice(0, 16).replace('T', ' ')} UTC`,
		}));
}

/** Why the chat open in Chat may not be listed: a Chat exists once its first message is sent (pineSessions.ts, newChatSessionItemHandler). */
export const NOT_LISTED_YET = 'A chat you have not written to yet is not listed: send it a first message, then attach.';
