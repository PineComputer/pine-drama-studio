import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Latest } from '../core/latest';

const after = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the last request wins: an older lookup that finishes late applies nothing (auto-reveal.md, section 6)', async () => {
	const latest = new Latest();
	const applied: string[] = [];
	const lookup = async (name: string, ms: number) => {
		const current = latest.next();
		await after(ms);
		if (current()) {
			applied.push(name);
		}
	};
	// Cassie's lookup is slow; the person has already moved on to Natalie.
	await Promise.all([lookup('cassie', 30), lookup('natalie', 5)]);
	assert.deepEqual(applied, ['natalie']);
	await lookup('cast', 0);
	assert.deepEqual(applied, ['natalie', 'cast']);
});
