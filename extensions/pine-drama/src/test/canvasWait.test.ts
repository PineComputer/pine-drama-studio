import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { waitingText } from '../core/canvasWait';
import { CANVAS_WAIT_LIMIT_SECONDS } from '../core/tuning';

// The person's report of 2026-11-08: the EP001 canvas was blank, with nothing in the log.
test('until its message comes, the canvas says it is reading, then that nothing came', () => {
	assert.equal(waitingText('EP001', 23), 'Reading EP001… 23 s');
	assert.match(waitingText('EP001', CANVAS_WAIT_LIMIT_SECONDS), /^Nothing of EP001 has come after 120 s\. The Output panel \(Pine Drama Studio\) says why/);
});
