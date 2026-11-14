import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CHAT_OPEN, MOVE_INTO_CHAT_VIEW, OPEN, showInChatView, startInChatView, type Tabs } from '../chatView';

// A workbench stand-in: `vscode.open` opens a chat editor tab; the move closes it unless the Chat view already shows
// the session (chatWidgetService.ts, prepareSessionForMove).
function workbench(viewShows: boolean) {
	const calls: unknown[][] = [];
	const open = new Set<string>(['brief.md']);
	let active: string | undefined = 'brief.md';
	const tabs: Tabs<string> = {
		active: () => active,
		isOpen: tab => open.has(tab),
		close: async tab => { calls.push(['close', tab]); open.delete(tab); },
	};
	const execute = async (command: string, ...args: unknown[]) => {
		await new Promise(resolve => setTimeout(resolve, 5));
		calls.push([command, ...args]);
		if (command === OPEN) {
			open.add('chat');
			active = 'chat';
		} else if (command === MOVE_INTO_CHAT_VIEW) {
			assert.equal(active, 'chat', 'moved before the chat editor was open');
			if (!viewShows) {
				open.delete('chat');
				active = 'brief.md';
			}
		}
	};
	return { calls, open, execute, tabs };
}

test('a conversation opens as a chat, then moves into the Chat view, in that order', async () => {
	const w = workbench(false);
	await showInChatView(w.execute, w.tabs, 'pine-computer:/local-1');
	assert.deepEqual(w.calls, [['vscode.open', 'pine-computer:/local-1'], ['workbench.action.chat.openInSidebar']]);
	assert.deepEqual([...w.open], ['brief.md']);
});

test('when the Chat view already shows the conversation, the second chat editor the open made is closed', async () => {
	const w = workbench(true);
	await showInChatView(w.execute, w.tabs, 'pine-computer:/local-1');
	assert.deepEqual(w.calls, [['vscode.open', 'pine-computer:/local-1'], ['workbench.action.chat.openInSidebar'], ['close', 'chat']]);
	assert.deepEqual([...w.open], ['brief.md']);
});

// Generate opens the session that owns the item in the Chat view and leaves the request in its input: nothing is sent,
// so no Computer starts until the person sends it.
test('Generate shows the owner session in the Chat view, then puts the request in its input without sending it', async () => {
	const w = workbench(false);
	await startInChatView(w.execute, w.tabs, 'pine-computer:/session-1', 'Draw EP003 seg01 shot 01 keyframe.');
	assert.deepEqual(w.calls, [['vscode.open', 'pine-computer:/session-1'], ['workbench.action.chat.openInSidebar'],
		[CHAT_OPEN, { query: 'Draw EP003 seg01 shot 01 keyframe.', isPartialQuery: true }]]);
});
