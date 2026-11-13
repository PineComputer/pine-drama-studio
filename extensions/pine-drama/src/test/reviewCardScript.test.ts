import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { card, type Node } from './reviewCardPage';

// The card's own script (media/reviewCard.js) in a minimal DOM: only what it touches. Fix plan item 4: typing in a note
// sends nothing to the host; the note is sent on change and with Submit.
test('typing ten characters in a note sends no decide; the note is sent on change', () => {
	const c = card();
	c.render({ version: 1, ready: false, locked: false, approvalStatement: 'I approve the versions marked Approve.', thumbnails: {},
		review: { id: 'r', turnId: 't', kind: 'files', subject: 'files', question: '', state: 'open', submitted: false,
			items: [{ key: 'one', label: 'One', files: [] }], verdicts: { one: { verdict: 'revise', reason: '' } } } });
	const note = c.root.all().find(n => n.tag === 'textarea')!;
	const before = c.posted.length;
	for (const ch of 'Make it re') { note.value += ch; note.oninput!(); }
	assert.deepEqual(c.posted.slice(before), [], 'no message per keystroke');
	note.onchange!();
	assert.deepEqual(c.posted.slice(before), [{ version: 1, action: 'decide', item: 'one', verdict: 'revise', reason: 'Make it re' }]);
});

// The person's run, 2026-11-06: a submitted card in Chat became an empty frame after the Review tab was shown and Chat
// shown again. Upstream reloads a chat output webview when its Chat is shown again and gives it back its state
// (chatMarkdownContentPart.ts, reinitialize on visibility; chatOutputItemRenderer.ts, webview.state). The card paints the
// card the host last confirmed from that state at once, and still asks the host for the current one.
const review = (submitted: boolean) => ({ version: 1, ready: true, locked: submitted, approvalStatement: 'I approve the versions marked Approve.', thumbnails: {},
	review: { id: 'r', turnId: 't', kind: 'takes', subject: 'the takes', question: '', state: submitted ? 'answered' : 'open', submitted,
		items: [{ key: 'seg06/t01', label: 'seg06 t01', files: [] }, { key: 'seg07/t01', label: 'seg07 t01', files: [] }],
		verdicts: submitted ? { 'seg06/t01': { verdict: 'approve', reason: '' }, 'seg07/t01': { verdict: 'approve', reason: '' } } : { 'seg07/t01': { verdict: 'revise', reason: '' } } } });
const text = (root: Node) => root.all().map(n => n.textContent).join(' ');

test('a reloaded card paints the receipt the host last confirmed, before any host message, and still asks for the current card', () => {
	const first = card();
	first.render(review(true));
	assert.match(text(first.root), /✓ Reviewed · the takes · 2 items/);
	const again = card({ state: first.state() });
	assert.match(text(again.root), /✓ Reviewed · the takes · 2 items/, 'not an empty frame');
	assert.deepEqual(again.posted, [{ version: 1, action: 'ready' }], 'the current card is still asked for');
});

test('a reloaded open card keeps its unsent note and its verdicts', () => {
	const first = card();
	first.render(review(false));
	const note = first.root.all().find(n => n.tag === 'textarea')!;
	for (const ch of 'warmer light') { note.value += ch; note.oninput!(); }
	const again = card({ state: first.state() });
	assert.equal(again.root.all().find(n => n.tag === 'textarea')!.value, 'warmer light', 'the draft note survives');
	assert.ok(again.root.all().some(n => n.tag === 'button' && /Changes requested/.test(n.textContent)), 'the verdict shows');
});

// The person's run, 2026-11-06: right after Submit, the receipt showed "Retry continuation" for a few seconds while the
// continuation was still being sent; nothing had failed. The card shows a continuation being sent in progress; Retry only
// once nothing is sending it (a send that failed, or a window reloaded since).
test('a submitted review whose continuation is being sent shows it in progress, never Retry; once nothing sends it, Retry', () => {
	const sending = card();
	sending.render({ ...review(true), locked: true, continuing: true, review: { ...review(true).review, state: 'open' } });
	const buttons = (c: ReturnType<typeof card>) => c.root.all().filter(n => n.tag === 'button').map(n => n.textContent);
	assert.ok(!buttons(sending).some(b => /Retry continuation/.test(b)), 'no Retry while it is being sent');
	assert.match(text(sending.root), /Sending your decisions to the agent…/);
	const failed = card();
	failed.render({ ...review(true), locked: true, continuing: false, review: { ...review(true).review, state: 'open' } });
	assert.ok(buttons(failed).some(b => /Retry continuation/.test(b)), 'Retry once nothing sends it');
	assert.doesNotMatch(text(failed.root), /Sending your decisions/);
});

// The guard is held for the whole turn, often many minutes; the review leaves `open` seconds after Submit, when its
// continuation is recorded. From then the receipt is the plain one, whatever the guard says.
test('once the continuation is recorded (the review answered), the receipt is plain while the turn still runs', () => {
	const answered = card();
	answered.render({ ...review(true), locked: true, continuing: true });
	assert.equal(review(true).review.state, 'answered');
	assert.doesNotMatch(text(answered.root), /Sending your decisions/);
	assert.ok(!answered.root.all().some(n => n.tag === 'button' && /Retry continuation|Submit and continue/.test(n.textContent)));
	assert.match(text(answered.root), /✓ Reviewed · the takes/);
});

test('a card whose render throws reports it to the host instead of staying silent', () => {
	const c = card();
	const broken = review(false);
	c.render({ ...broken, review: { ...broken.review, items: [{ key: 'one', label: 'One', files: [{ relPath: undefined }] }] } });
	assert.ok(c.posted.some(m => m.action === 'report' && /render failed/.test((m as unknown as { message: string }).message)));
});
