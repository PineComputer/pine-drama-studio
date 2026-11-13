import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { activityRow } from '../core/activityRow';

test('a running step shows its title; no past-tense message yet', () => {
	assert.deepEqual(activityRow({ id: 'a1', text: 'Run drama-cli jobs', state: 'running' }), { toolCallId: 'a1', isComplete: false, invocationMessage: 'Run drama-cli jobs', pastTenseMessage: undefined });
});

test('a completed step ends with its title; any other end says how it ended', () => {
	assert.equal(activityRow({ id: 'a1', text: 'Run drama-cli jobs', state: 'completed' }).pastTenseMessage, 'Run drama-cli jobs');
	for (const state of ['failed', 'declined', 'interrupted']) {
		const row = activityRow({ id: 'a1', text: 'Run drama-cli jobs', state });
		assert.equal(row.isComplete, true);
		assert.equal(row.pastTenseMessage, `Run drama-cli jobs (${state})`);
	}
});

test('a state the SDK does not list is not an end', () => {
	assert.equal(activityRow({ id: 'a1', text: 'x', state: 'paused' }).isComplete, false);
});
