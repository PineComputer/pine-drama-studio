import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { statusText, waitingItems } from '../core/attention';
import type { Chat } from '../core/store';

const conv = (key: string, state: string, updated: string): Chat => ({ key, label: key.toUpperCase(), state, updated_at: updated } as unknown as Chat);

test('only sessions that need input wait, most recently active first', () => {
	const all = [conv('a', 'needs_input', '2026-11-02T10:00:00Z'), conv('b', 'running', '2026-11-02T11:00:00Z'), conv('c', 'needs_input', '2026-11-02T12:00:00Z')];
	assert.deepEqual(waitingItems(all, c => `why ${c.key}`), [
		{ key: 'c', label: 'C', reason: 'why c' },
		{ key: 'a', label: 'A', reason: 'why a' },
	]);
});

test('the status text counts sessions, running and waiting, in words', () => {
	assert.equal(statusText(1, 0, 0), 'Pine · 1 session');
	assert.equal(statusText(3, 1, 2), 'Pine · 3 sessions · 1 running · 2 waiting for you');
});

test('a waiting session is named as the sessions list names it', () => {
	const items = waitingItems([conv('a', 'needs_input', '2026-11-02T10:00:00Z')], c => `why ${c.key}`, c => (c.key === 'a' ? 'The Last Shift' : c.label));
	assert.equal(items[0].label, 'The Last Shift');
});
