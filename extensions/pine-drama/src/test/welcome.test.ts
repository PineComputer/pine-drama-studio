import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXTRACTED } from '../core/extract';

// The Chat welcome message names the files the Studio takes. Since the Studio read .doc and .rtf, and the list had not
// followed. It is pinned to what the Studio actually reads, so the two cannot drift again.

/** Text files go up as they are: the Studio reads nothing of them (core/uplink.ts). Every other kind is in EXTRACTED. */
const SENT_AS_THEY_ARE = ['.txt', '.md', '.fountain'];

/** The extensions `EXTRACTED` accepts, read from the pattern itself: `/\.(docx|pdf|doc|rtf)$/i` is `.docx`, `.pdf`, `.doc`, `.rtf`. */
function extracted(): string[] {
	const group = /^\\\.\(([^)]+)\)\$$/.exec(EXTRACTED.source);
	assert.ok(group, `EXTRACTED has changed shape: ${EXTRACTED.source}; teach this test to read it`);
	return group[1].split('|').map(ext => `.${ext}`);
}

function welcomeList(): string[] {
	const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { chatSessions: { welcomeMessage: string }[] } };
	const message = pkg.contributes.chatSessions[0].welcomeMessage;
	const list = /message box: ([^\n]*?)\.(?:\n|$)/.exec(message);
	assert.ok(list, `the welcome message no longer names the files: ${message}`);
	return list[1].split(/, | or /).map(ext => ext.trim());
}

test('the welcome message names exactly the files the Studio takes: text as it is, and every kind it extracts', () => {
	assert.deepEqual([...welcomeList()].sort(), [...SENT_AS_THEY_ARE, ...extracted()].sort());
});
