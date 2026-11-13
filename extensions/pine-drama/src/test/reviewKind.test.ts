import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { reviewKindOf } from '../core/reviews';

// A stop's review is named by the types of the objects its return asks the person to choose (doc/protocol.md, 5.1).
test('a review\'s kind follows its objects\' types, the later pipeline step first; none is a question', () => {
	assert.equal(reviewKindOf(['character', 'take']), 'takes');
	assert.equal(reviewKindOf(['keyframe']), 'storyboards');
	assert.equal(reviewKindOf(['scene', 'character']), 'references');
	assert.equal(reviewKindOf(['character']), 'looks');
	assert.equal(reviewKindOf(['screenplay']), 'files');
	assert.equal(reviewKindOf([]), 'question');
});
