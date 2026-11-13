import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chatLine, codeSpan, commandLink, enabledCommands, givenBack, quoted, refusalLine, refusalOf, type RefusalCommands } from '../core/refusal';

// A refused send is one line in the chat with its actions as links: no modal over it, no paragraph,
// no stream buttons. The message itself comes back under the line, quoted.

const COMMANDS: RefusalCommands = { openFolder: 'x.openFolder', newFolder: 'x.newFolder', openGivenFolder: 'x.openGiven' };
const BELOW = 'Your message is below, to send again.';

test('no folder: one chat line with the two folder actions, and the message given back under it', () => {
	const refusal = refusalOf({ kind: 'none' }, COMMANDS, 'make EP001');
	assert.equal(refusal.line, `Not sent: this window has no folder. ${BELOW}`);
	assert.deepEqual(refusal.actions.map(a => a.label), ['Open Folder…', 'New Folder…']);
	const [line, message] = chatLine(refusal).split('\n\n');
	assert.equal(line, `_Not sent: this window has no folder. ${BELOW}_ [Open Folder…](command:x.openFolder) · [New Folder…](command:x.newFolder)`);
	assert.ok(!line.includes('\n'), 'one line');
	assert.equal(message, '```text\nmake EP001\n```', 'the message as typed');
	assert.deepEqual(enabledCommands(refusal), ['x.openFolder', 'x.newFolder'], 'only these commands are enabled in the trusted Markdown');
	assert.ok(!('title' in refusal) && !('detail' in refusal), 'nothing for a modal');
});

test('each other refusal has its own line, which says what the modal said, and keeps the two folder actions', () => {
	const several = refusalOf({ kind: 'several', count: 3 }, COMMANDS, 'm');
	assert.equal(several.line, `Not sent: this window has 3 folders; open one. ${BELOW}`);
	const elsewhere = refusalOf({ kind: 'elsewhere', folder: '/work/night-ward' }, COMMANDS, 'm');
	assert.equal(elsewhere.line, `Not sent: this session's drama is in another folder, \`/work/night-ward\`. ${BELOW}`);
	assert.deepEqual(elsewhere.actions[0], { label: 'Open Its Folder', command: 'x.openGiven', args: ['/work/night-ward'] });
	const inside = refusalOf({ kind: 'inside', folder: '/work/dramas', project: '/work/dramas/old/Night Ward' }, COMMANDS, 'm');
	assert.equal(inside.line, `Not sent: this folder holds a drama-cli project, \`/work/dramas/old/Night Ward\`; open it to continue it, or choose another folder for this drama. Nothing is touched. ${BELOW}`);
	assert.deepEqual(inside.actions[0], { label: 'Open That Project', command: 'x.openGiven', args: ['/work/dramas/old/Night Ward'] });
	const changed = refusalOf({ kind: 'rootChanged' }, COMMANDS, 'm');
	assert.match(changed.line, /^Not sent: the opened project folder changed\. Open the intended project explicitly\./);
	for (const r of [several, elsewhere, inside, changed]) {
		assert.ok(r.actions.some(a => a.label === 'Open Folder…') && r.actions.some(a => a.label === 'New Folder…'));
		assert.ok(!r.line.includes('\n'));
	}
});

test('the message\'s attachments are named in the line to add again; a refusal found again at the send gives no message', () => {
	assert.match(refusalOf({ kind: 'none' }, COMMANDS, 'd1', ['image.png', 'a b.png']).line, / These attachments need adding again: `image\.png`, `a b\.png`\.$/);
	assert.equal(refusalLine({ kind: 'inside', folder: '/w', project: '/w/p' }), 'Not sent: this folder holds a drama-cli project, `/w/p`; open it to continue it, or choose another folder for this drama. Nothing is touched.');
	// Paths and names are code spans, so Markdown in them shows as typed: `*pilot*` stays literal.
	assert.match(refusalOf({ kind: 'elsewhere', folder: '/work/*pilot*_[a](b)' }, COMMANDS, 'd1').line, /`\/work\/\*pilot\*_\[a\]\(b\)`/);
	assert.equal(commandLink({ label: 'Open "X"', command: 'c', args: ['a b', 1] }), '[Open "X"](command:c?%5B%22a%20b%22%2C1%5D)');
	assert.equal(commandLink({ label: 'Go', command: 'c', args: [] }), '[Go](command:c)');
});

test('no Pine environment set up (#111): the setup reply as the one line, with no actions', () => {
	const text = '**No Pine environment is set up, so nothing was sent.** `/home/a/.env` does not say which Pine environment to use: x. Fix the file, then quit and reopen the Studio.';
	const refusal = refusalOf({ kind: 'pine', text }, COMMANDS);
	assert.equal(chatLine(refusal), `_${text}_`);
	assert.deepEqual(refusal.actions, []);
	assert.deepEqual(enabledCommands(refusal), []);
});

test('the message comes back exactly as typed: a fence longer than any backtick run in it (CommonMark 4.5)', () => {
	assert.equal(quoted('make it *rain*'), '```text\nmake it *rain*\n```');
	assert.equal(quoted('use ```yaml``` here'), '````text\nuse ```yaml``` here\n````');
	assert.equal(quoted('two\nlines'), '```text\ntwo\nlines\n```');
});

// A name could close a one-backtick span and add a link to a line trusted for the refusal's commands.
test('a name is a code span it cannot close: a longer fence, padded when it starts or ends with a backtick, on one line', () => {
	assert.equal(codeSpan('a b.png'), '`a b.png`');
	assert.equal(codeSpan('x`](command:evil)`y.png'), '``x`](command:evil)`y.png``');
	assert.equal(codeSpan('`edge`'), '`` `edge` ``');
	assert.equal(codeSpan('two\nlines.txt'), '`two lines.txt`');
	assert.match(refusalOf({ kind: 'none' }, COMMANDS, 'm', ['x`](command:evil)`.png']).line, /``x`\]\(command:evil\)`\.png``/);
});

// Markdown streamed after the block in the same reply ran into its closing fence.
test('the message given back ends with a blank line, after the attachments to add again', () => {
	assert.equal(givenBack('hello'), '```text\nhello\n```\n\n');
	assert.equal(givenBack('hello', ['a.txt']), '_These attachments need adding again: `a.txt`._\n\n```text\nhello\n```\n\n');
});

test('unassigned project history names missing admission without fabricating runtime state or execution actions', () => {
	const refusal = refusalOf({ kind: 'unassigned' }, COMMANDS, 'continue', ['unreadable.pdf']);
	assert.equal(refusal.line, `Not sent: this project has no admitted executor. Its files remain available for inspection. ${BELOW} These attachments need adding again: \`unreadable.pdf\`.`);
	assert.doesNotMatch(refusal.line, /session.*ended|Computer.*stopped/);
	assert.deepEqual(refusal.actions, []);
	assert.deepEqual(enabledCommands(refusal), []);
});
