import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chatRows } from '../core/chatPick';
import { Store } from '../core/store';

test('the conversation written to last is the first row, though the store lists the oldest first', () => {
	const clock = { now: Date.parse('2026-11-01T09:00:00Z') };
	const store = new Store(join(mkdtempSync(join(tmpdir(), 'pine-pick-')), 'studio.sqlite'), () => clock.now);
	store.insertChat({ key: 'pine-computer:/yesterday', env: 'dev', endpoint: 'https://pine.test', label: 'Double life', secret_ref: 'a' });
	clock.now = Date.parse('2026-11-02T10:00:00Z');
	store.insertChat({ key: 'pine-computer:/today', env: 'dev', endpoint: 'https://pine.test', label: 'New drama', secret_ref: 'b' });
	clock.now = Date.parse('2026-11-02T10:05:00Z');
	store.updateChat('pine-computer:/today', { state: 'running' });

	assert.deepEqual(store.chats().map(c => c.key), ['pine-computer:/yesterday', 'pine-computer:/today']);
	const rows = chatRows(store.chats());
	assert.deepEqual(rows.map(r => r.label), ['New drama', 'Double life']);
	assert.equal(rows[0].key, 'pine-computer:/today');
	assert.equal(rows[0].description, 'last active 2026-11-02 10:05 UTC');

	// Activity in the older Chat brings it back to the top.
	clock.now = Date.parse('2026-11-02T11:00:00Z');
	store.updateChat('pine-computer:/yesterday', { state: 'running' });
	assert.deepEqual(chatRows(store.chats()).map(r => r.label), ['Double life', 'New drama']);
	store.close();
});
