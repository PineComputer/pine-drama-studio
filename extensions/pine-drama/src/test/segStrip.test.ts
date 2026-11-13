import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { stripDelta } from '../core/segStrip';

// The person's bug of 2026-11-08: the seg strip cut off after seg06, so later segs could not be reached.
test('a wheel turn over the seg strip scrolls it sideways; a sideways swipe is left to the browser, never doubled', () => {
	assert.equal(stripDelta(0, 120), 120, 'a mouse wheel turned down scrolls the strip right');
	assert.equal(stripDelta(0, -40), -40);
	assert.equal(stripDelta(30, 4), 0, 'a trackpad swipe sideways scrolls natively (overflow-x)');
	assert.equal(stripDelta(-50, 10), 0);
	assert.equal(stripDelta(0, 0), 0);
});
