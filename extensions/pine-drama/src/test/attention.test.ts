import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { destinationOf, statusText, waitingItems } from '../core/attention';
import { Store, type Chat } from '../core/store';

const conv = (key: string, state: string, updated: string): Chat => ({ key, label: key.toUpperCase(), state, updated_at: updated } as unknown as Chat);

test('only sessions that need input wait, most recently active first; a review with items is a decision, else a question', () => {
	const all = [conv('a', 'needs_input', '2026-11-02T10:00:00Z'), conv('b', 'running', '2026-11-02T11:00:00Z'), conv('c', 'needs_input', '2026-11-02T12:00:00Z')];
	const reviews: Record<string, { id: string; items: number }> = { a: { id: 'ra', items: 3 }, c: { id: 'rc', items: 0 } };
	const items = waitingItems(all, key => reviews[key], c => `why ${c.key}`);
	assert.deepEqual(items, [
		{ key: 'c', label: 'C', reason: 'why c' },
		{ key: 'a', label: 'A', reason: 'why a', reviewId: 'ra' },
	]);
});

test('a click goes where the waiting item is: Review in this project, Chat for a question, the project window for another project', () => {
	const decision = { key: 'a', label: 'A', reason: '', reviewId: 'ra' };
	const question = { key: 'a', label: 'A', reason: '' };
	assert.deepEqual(destinationOf(decision, ['a'], true), { to: 'review', reviewId: 'ra' }, "the Chat's own project window");
	assert.deepEqual(destinationOf(decision, ['b'], true), { to: 'window', reviewId: 'ra' }, "another project's window: Review here does not show it");
	assert.deepEqual(destinationOf(decision, [], true), { to: 'window', reviewId: 'ra' }, 'a window with no project has an empty Review index (D38): its project window');
	assert.deepEqual(destinationOf(decision, ['b'], false), { to: 'chat' }, 'no project folder to open: its chat, which links the review');
	assert.deepEqual(destinationOf(question, [], true), { to: 'chat' }, 'a question in words is only in its chat, never an empty Review');
	assert.deepEqual(destinationOf(question, ['b'], true), { to: 'chat' });
});

// A window's scope is a project with several Chats, not the one Chat that owns its folder.
test("a review waiting in another Chat of this window's project is shown in this window's Review", () => {
	const episode = { key: 'episode', label: 'EP002', reason: '', reviewId: 'r-ep' };
	assert.deepEqual(destinationOf(episode, ['main', 'episode'], true), { to: 'review', reviewId: 'r-ep' });
});

test('the status text counts sessions, running and waiting, in words', () => {
	assert.equal(statusText(1, 0, 0), 'Pine · 1 session');
	assert.equal(statusText(3, 1, 2), 'Pine · 3 sessions · 1 running · 2 waiting for you');
});

test("a reveal request is taken once, by its project's window, and only while it is fresh", () => {
	let now = 1_000_000;
	const store = new Store(join(mkdtempSync(join(tmpdir(), 'pine-reveal-')), 'studio.sqlite'), () => now);
	for (const key of ['a', 'b', 'c']) {
		store.insertChat({ key, env: 'dev', endpoint: 'http://x', label: key, secret_ref: key });
	}
	store.requestReveal('a', 'r1');
	store.requestReveal('a', 'r2'); // a newer request replaces the older one
	assert.equal(store.takeReveal(['c'], 60_000), undefined, "another project's window does not take it");
	assert.equal(store.takeReveal(['b', 'a'], 60_000), 'r2', "a project's window takes a request for any of its Chats");
	assert.equal(store.takeReveal(['a', 'b'], 60_000), undefined, 'taken once');
	store.requestReveal('a', 'r3');
	now += 1;
	store.requestReveal('b', 'r4');
	assert.equal(store.takeReveal(['a', 'b'], 60_000), 'r4', 'the newest request of the project wins');
	assert.equal(store.takeReveal(['a', 'b'], 60_000), undefined, "every request of the project is consumed");
	store.requestReveal('a', 'r5');
	now += 61_000;
	assert.equal(store.takeReveal(['a'], 60_000), undefined, 'a stale request is dropped, so a later focus reveals nothing unasked');
	assert.equal(store.takeReveal(['a'], 60_000), undefined);
	assert.equal(store.takeReveal([], 60_000), undefined, 'a window with no project takes nothing');
});

test('a waiting session is named as the sessions list names it', () => {
	const items = waitingItems([conv('a', 'needs_input', '2026-11-02T10:00:00Z')], () => undefined, c => `why ${c.key}`, c => (c.key === 'a' ? 'The Last Shift' : c.label));
	assert.equal(items[0].label, 'The Last Shift');
});
