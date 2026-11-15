import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { linkFiles } from '../core/chatLinks';

// The agent's own words, as pine-dev returned them on 2026-11-03: links to files of its Computer, which Chat cannot resolve.

const reply = [
	'\u5267\u672c\u5df2\u6574\u7406\u5e76\u901a\u8fc7\u683c\u5f0f\u68c0\u67e5\uff0c\u5c1a\u672a\u5f00\u59cb\u751f\u6210\u3002\u8bf7\u5ba1\u6838 [\u7b2c1—10\u96c6\u5267\u672c](drama/screenplay/v2/screenplay.fountain) \u548c [\u9010\u884c\u5bf9\u7167\u62a5\u544a](drama/screenplay/v2/review.md)\uff0c\u544a\u8bc9\u6211\u662f\u5426\u540c\u610f\u3002',
	'',
	'\u9879\u76ee\u8bb0\u5f55\uff1a[\u8bb0\u5f55\u5305](handoff/project.tar.part-aa) · [\u9879\u76ee\u6eaf\u6e90](handoff/lineage.json)',
].join('\n');

test('a link to the Computer\'s project file is its plain title; the plumbing links are gone; the words are the agent\'s', () => {
	const shown = linkFiles(reply);
	assert.ok(shown.includes('\u8bf7\u5ba1\u6838 \u7b2c1—10\u96c6\u5267\u672c \u548c \u9010\u884c\u5bf9\u7167\u62a5\u544a\uff0c\u544a\u8bc9\u6211\u662f\u5426\u540c\u610f\u3002'), shown);
	assert.ok(!/\]\(drama\//.test(shown) && !/handoff|\u8bb0\u5f55\u5305|\u9879\u76ee\u6eaf\u6e90/.test(shown), shown);
});

test('plumbing is removed with its separators and nothing else: a mixed line keeps the words, the review instruction stays', () => {
	// Project links and records-pack links on one line, in every order.
	assert.equal(linkFiles('[\u5267\u672c](drama/a.md) · [\u8bb0\u5f55\u5305](handoff/project.tar.part-aa) · [\u62a5\u544a](drama/b.md)'), '\u5267\u672c · \u62a5\u544a');
	assert.equal(linkFiles('[\u8bb0\u5f55\u5305](handoff/x), [\u5267\u672c](drama/a.md)'), '\u5267\u672c');
	assert.equal(linkFiles('[\u5267\u672c](drama/a.md); [\u8bb0\u5f55\u5305](handoff/x)'), '\u5267\u672c');
	// A line that ends in the review instruction and a plumbing link keeps the instruction.
	assert.equal(linkFiles('Please review the screenplay: [records](handoff/project.tar.part-aa)'), 'Please review the screenplay:');
	assert.equal(linkFiles('\u8bf7\u5ba1\u6838\u5267\u672c\uff1a[\u8bb0\u5f55\u5305](handoff/project.tar.part-aa)'), '\u8bf7\u5ba1\u6838\u5267\u672c\uff1a');
	// A line of plumbing only goes; the words around a plumbing link stay.
	assert.equal(linkFiles('Done.\n\n[Records: part 1](handoff/project.tar.part-aa) · [part 2](handoff/project.tar.part-ab)'), 'Done.');
	assert.equal(linkFiles('Saved ([pack](handoff/x)) for the studio.'), 'Saved () for the studio.');
});

test('other links and text without links are untouched', () => {
	assert.equal(linkFiles('See [the docs](https://example.com/a) and [notes](notes/a.md).'), 'See [the docs](https://example.com/a) and [notes](notes/a.md).');
	assert.equal(linkFiles('No links here.'), 'No links here.');
});
