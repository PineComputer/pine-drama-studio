import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { lockOf, START_EPISODE, startEpisodeRequest } from '../core/threeSteps';

// B8: the locked 3. Episodes said only that it opens after a breakdown, and nothing showed where an episode starts.
test('the locked 3. Episodes points to Start Episode on the episode rows under 1. Script', () => {
	const lock = lockOf('episodes', { assets: true, episodes: false });
	assert.ok(lock?.tooltip.includes(`under 1. Script (${START_EPISODE})`), lock?.tooltip);
	assert.equal(lockOf('episodes', { assets: true, episodes: true }), null);
});

test("Start Episode's request names the episode, which is all an episode session needs to begin", () => {
	assert.equal(startEpisodeRequest('EP003'), 'Make episode EP003.');
});
