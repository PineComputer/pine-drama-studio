import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { itemTiming } from '../core/sessionTiming';

// A Sessions row with no timing is dated to 1970 by Code-OSS (agentSessionsModel.ts:1315, `created ?? 0`): "57 yrs ago", under
// "Older". The row of a session whose first message was refused has no turn yet.

const NOW = Date.parse('2026-11-03T09:00:00Z');

test('a new row, made before any request, is dated now and has no last request', () => {
	assert.deepEqual(itemTiming(undefined, undefined, NOW), { created: NOW });
	assert.ok(itemTiming(undefined, undefined, NOW).created > 0);
});

test('a saved session keeps its times; an unreadable or empty time is not 1970', () => {
	assert.deepEqual(itemTiming('2026-11-02T10:00:00.000Z', '2026-11-02T11:30:00.000Z', NOW), { created: Date.parse('2026-11-02T10:00:00Z'), lastRequestStarted: Date.parse('2026-11-02T11:30:00Z') });
	assert.deepEqual(itemTiming('', '', NOW), { created: NOW });
	assert.deepEqual(itemTiming('not a date', 'also not', NOW), { created: NOW });
});
