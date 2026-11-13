import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { REVIEW_APPROVAL_STATEMENT, REVIEW_CARD_OPEN_PROJECT, reviewCardAction, type ReviewCardUpdate } from '../core/reviewCardProtocol';

test('review cards accept explicit versioned actions, never natural-language verdicts or file paths', () => {
	assert.deepEqual(reviewCardAction({ version: 1, action: 'approveAll' }), { version: 1, action: 'approveAll' });
	assert.deepEqual(reviewCardAction({ version: 1, action: 'decide', item: 'one', verdict: 'revise', reason: '' }),
		{ version: 1, action: 'decide', item: 'one', verdict: 'revise', reason: '' });
	assert.deepEqual(reviewCardAction({ version: 1, action: 'submit', notes: { one: 'x' }, words: 'Skip the props.' }),
		{ version: 1, action: 'submit', notes: { one: 'x' }, words: 'Skip the props.' }, 'Anything else goes with Submit');
	for (const input of [null, '1 2 3 approved', { version: 2, action: 'submit' }, { version: 1, action: 'submit', notes: {} },
		{ version: 1, action: 'open', path: '/private/file' }, { version: 1, action: 'open', item: 'one', file: -1 },
		{ version: 1, action: 'decide', item: 'one', verdict: 'yes' }]) {
		assert.throws(() => reviewCardAction(input));
	}
});

test('host-to-card messages have one typed shape (checked by tsc, with the webview through tsconfig.media.json)', () => {
	const state: ReviewCardUpdate = { version: 1, review: undefined, thumbnails: {}, approvalStatement: REVIEW_APPROVAL_STATEMENT, ready: false, locked: true, continuing: false };
	const refusal: ReviewCardUpdate = { version: 1, error: REVIEW_CARD_OPEN_PROJECT };
	// @ts-expect-error a state message states whether the card is locked
	const incomplete: ReviewCardUpdate = { version: 1, review: undefined, thumbnails: {}, approvalStatement: '', ready: false };
	// @ts-expect-error the protocol has one version
	const unversioned: ReviewCardUpdate = { error: 'untyped' };
	assert.deepEqual([state.version, refusal.version, incomplete.version, unversioned.version], [1, 1, 1, undefined]);
});

test('a webview report is a bounded string and nothing else', () => {
	assert.deepEqual(reviewCardAction({ version: 1, action: 'report', message: 'x'.repeat(900) }), { version: 1, action: 'report', message: 'x'.repeat(500) });
	assert.throws(() => reviewCardAction({ version: 1, action: 'report', message: 3 }), /Invalid review action/);
});
