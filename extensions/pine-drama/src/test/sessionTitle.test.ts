import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chatRows } from '../core/chatPick';
import { briefTitle, projectTitle, sessionTitles } from '../core/sessionTitle';
import { Store } from '../core/store';
import { projectFolder } from '../core/projectPlace';


test("a brief's Title: line names the work", () => {
	assert.equal(briefTitle('# Brief\n\n## From the producer\n\nTitle: The Last Shift\nEpisode length: about 90 seconds\n'), 'The Last Shift');
	assert.equal(briefTitle('Title:   Double Life  \n'), 'Double Life');
	assert.equal(briefTitle('# Brief\nNo title here.\n'), undefined);
	assert.equal(briefTitle('Title:\n'), undefined);
});

test("a brief's title is read in the common Markdown forms: a list item, bold", () => {
	const real = 'Brief\n\n- Title: Never Divorce a Secret Billionaire Heiress\n- Episode length: about 90 seconds\n';
	assert.equal(briefTitle(real), 'Never Divorce a Secret Billionaire Heiress');
	assert.equal(briefTitle('* Title: The Last Shift\n'), 'The Last Shift');
	assert.equal(briefTitle('**Title:** The Last Shift\n'), 'The Last Shift');
	assert.equal(briefTitle('  - Title:   Double Life  \n'), 'Double Life');
	assert.equal(briefTitle('- **Title:** The Last Shift\n'), 'The Last Shift');
	assert.equal(briefTitle('- Working title: not this\n'), undefined, 'only a Title: line');
});

test("a session's title is its drama's brief title, once the brief is in the folder", () => {
	const root = mkdtempSync(join(tmpdir(), 'pine-title-'));
	const folder = projectFolder(root, 'pine-computer:/a');
	assert.equal(projectTitle(folder), undefined, 'no drama yet: the row keeps its first message');
	mkdirSync(join(folder, 'inputs'), { recursive: true });
	assert.equal(projectTitle(folder), undefined, 'no brief yet');
	writeFileSync(join(folder, 'inputs', 'brief.md'), '# Brief\n\nTitle: The Last Shift\n');
	assert.equal(projectTitle(folder), 'The Last Shift');
});

test('a brief that does not read is logged, and the row keeps its first message; pickers show the same title', () => {
	const root = mkdtempSync(join(tmpdir(), 'pine-title-'));
	const folder = projectFolder(root, 'pine-computer:/b');
	mkdirSync(join(folder, 'inputs', 'brief.md'), { recursive: true }); // a folder where the brief should be: reading it fails
	const logged: string[] = [];
	const titleOf = sessionTitles(key => projectFolder(root, key), line => logged.push(line));
	assert.equal(titleOf('pine-computer:/b'), undefined);
	assert.match(logged[0], /^title of pine-computer:\/b: its project's brief does not read: /);

	const store = new Store(join(root, 'studio.sqlite'));
	store.insertChat({ key: 'pine-computer:/a', env: 'dev', endpoint: 'https://pine.test', label: 'We are starting a new short drama', secret_ref: 'a' });
	store.updateChat('pine-computer:/a', { pine_session_state: 'ended' });
	const rows = chatRows(store.chats(), key => key === 'pine-computer:/a' ? 'The Last Shift' : undefined);
	assert.equal(rows[0].label, 'The Last Shift');
	assert.match(rows[0].description, /^last active /);
	assert.ok(!rows[0].description.includes('session ended'), "an ended Pine session is not the person's to act on");
});
