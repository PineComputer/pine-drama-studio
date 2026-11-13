import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { lockOf, sectionLines, START_EPISODE, startEpisodeRequest } from '../core/threeSteps';

// B8: the locked 3. Episodes said only that it opens after a breakdown, and nothing showed where an episode starts.
test('the locked 3. Episodes points to Start Episode on the episode rows under 1. Script', () => {
	const lock = lockOf('episodes', { assets: true, episodes: false });
	assert.ok(lock?.tooltip.includes(`under 1. Script (${START_EPISODE})`), lock?.tooltip);
	assert.equal(lockOf('episodes', { assets: true, episodes: true }), null);
});

test("Start Episode's request names the episode, which is all an episode session needs to begin", () => {
	assert.equal(startEpisodeRequest('EP003'), 'Make episode EP003.');
});

// #73: an episode row under 1. Script opens the screenplay at its section. Fountain marks a section with `#` and a
// subsection with `##`; the Nth top-level section is the Nth episode, whatever language its words are in.
test('the screenplay\'s top-level sections, by line, which the episodes match by order', () => {
	const text = ['Title: A', '', '# 1', '', 'INT. ROOM - DAY', '## part', '', '# 2', 'EXT. ROAD - NIGHT', '#3 no space', ''].join('\n');
	assert.deepEqual(sectionLines(text), [2, 7, 9], 'a ## subsection is not an episode');
	assert.deepEqual(sectionLines('INT. ROOM - DAY\r\nA line.'), [], 'no sections');
	assert.deepEqual(sectionLines('x\r\n# 1\r\n'), [1], 'CRLF lines');
	assert.deepEqual(sectionLines(['/* # old', '# cut */', '# 1', '/* # inline */ text', '# 2'].join('\n')), [2, 4], 'the boneyard is not read');
});
