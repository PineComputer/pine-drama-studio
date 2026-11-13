import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// One word per concept on screen: what a row of the sessions list is,
// the person's work with one agent, is a "session", VS Code's word; "Chat" is only the code's name for it.
// The run Pine keeps on a Computer is never called a session on screen.
const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
	contributes: { commands: { command: string; title: string }[]; chatSessions: { welcomeMessage: string; inputPlaceholder: string; description: string }[] };
};

test('commands and the Pine Computer welcome say "session", never "conversation"', () => {
	const shown = [
		...manifest.contributes.commands.map(c => c.title),
		...manifest.contributes.chatSessions.flatMap(s => [s.welcomeMessage, s.inputPlaceholder, s.description]),
	];
	assert.deepEqual(shown.filter(text => /conversation/i.test(text)), []);
	const titles = new Map(manifest.contributes.commands.map(c => [c.command, c.title]));
	assert.equal(titles.get('pineDrama.showConversations'), 'Show Sessions');
	assert.equal(titles.get('pineDrama.attachFiles'), 'Attach Files to Session…');
});

test('the Pine Computer welcome reads right in a project and without one, in three short native paragraphs', () => {
	// Review instructions belong at the pending decision, not in the empty Chat's onboarding copy. Code-OSS shows one static
	// welcome per session type (chatWidget.ts:1815-1831), so it serves a project's new session and an empty window alike.
	assert.equal(manifest.contributes.chatSessions[0].welcomeMessage,
		'Tell Pine what to make. In a project, say what to work on, for example: do episode 3.\n\n' +
		'No project yet? Create or open one, then drop a screenplay or brief into the message box: .txt, .md, .fountain, .docx, .pdf, .doc or .rtf.\n\n' +
		"Sending starts remote work, billed by Pine.");
});
