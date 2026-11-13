import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { linkFiles, localProjectFile } from '../core/chatLinks';
import { Library } from '../core/library';
import { Store } from '../core/store';

// The agent's own words, as pine-dev returned them on 2026-11-03: links to files of its Computer, which Chat cannot resolve.

const KEY = 'pine-computer:/local-1';
const T1 = 'turn-1';

/**
 * A drama folder on disk, and the way a stop's file arrives in it: recorded for its turn, and installed in the folder by
 * the task's publication (core/resultImporter.ts). Also a file outside the folder, and a link that leads out.
 */
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'pine-links-'));
	const store = new Store(join(dir, 'studio.sqlite'));
	store.insertChat({ key: KEY, env: 'dev', endpoint: 'http://x', label: 'Night Ward', secret_ref: 'x' });
	const library = new Library(store, join(dir, 'library'));
	const folder = join(dir, 'Night Ward');
	const root = join(folder, 'drama');
	mkdirSync(root, { recursive: true });
	const src = { store, has: (sha: string) => library.has(sha), root, boundary: folder, key: KEY };
	/** The turn's stop returns `drama/<rel>` with these bytes. */
	const arrive = async (turn: string, rel: string, text: string) => {
		const { sha, size } = await library.put(new TextEncoder().encode(text));
		const kept = { chat_key: KEY, turn_id: turn, sha, rel_path: `drama/${rel}`, size, type: 'text/markdown', kind: 'other' };
		store.insertLibraryFile(kept);
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), text);
	};
	await arrive(T1, 'screenplay/v2/screenplay.fountain', 'x');
	await arrive(T1, 'screenplay/v2/review.md', 'x');
	writeFileSync(join(dir, 'outside.txt'), 'secret');
	mkdirSync(join(dir, 'elsewhere'));
	writeFileSync(join(dir, 'elsewhere', 'a.txt'), 'x');
	symlinkSync(join(dir, 'elsewhere'), join(root, 'leak'));
	return { dir, store, library, root, src, arrive };
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const reply = [
	'\u5267\u672c\u5df2\u6574\u7406\u5e76\u901a\u8fc7\u683c\u5f0f\u68c0\u67e5\uff0c\u5c1a\u672a\u5f00\u59cb\u751f\u6210\u3002\u8bf7\u5ba1\u6838 [\u7b2c1—10\u96c6\u5267\u672c](drama/screenplay/v2/screenplay.fountain) \u548c [\u9010\u884c\u5bf9\u7167\u62a5\u544a](drama/screenplay/v2/review.md)\uff0c\u544a\u8bc9\u6211\u662f\u5426\u540c\u610f\u3002',
	'',
	'\u539f\u6587\u4eba\u7269\u5c0f\u4f20\u5df2\u9010\u5b57\u6536\u5165 [\u5236\u4f5c\u7b80\u62a5](drama/brief.md)\u3002',
	'',
	'\u9879\u76ee\u8bb0\u5f55\uff1a[\u8bb0\u5f55\u5305](handoff/project.tar.part-aa) · [\u9879\u76ee\u6eaf\u6e90](handoff/lineage.json)',
].join('\n');

test('a file this stop kept becomes a file link with the agent\'s own words; one that is not here is its plain name; the plumbing links are gone', async () => {
	const { src, root } = await fixture();
	const shown = linkFiles(reply, rel => localProjectFile(src, T1, rel));
	assert.match(shown, new RegExp(`\\[\u7b2c1—10\u96c6\u5267\u672c\\]\\(${escape(pathToFileURL(join(root, 'screenplay/v2/screenplay.fountain')).href)}\\)`));
	assert.ok(shown.includes(`[\u9010\u884c\u5bf9\u7167\u62a5\u544a](${pathToFileURL(join(root, 'screenplay/v2/review.md')).href})`));
	assert.ok(shown.includes('\u6536\u5165 \u5236\u4f5c\u7b80\u62a5\u3002'), 'brief.md is not here: the plain name, no state claimed, no dead link');
	assert.ok(!/arriving|not returned/.test(shown));
	assert.ok(!/\]\(drama\//.test(shown) && !/handoff|\u8bb0\u5f55\u5305|\u9879\u76ee\u6eaf\u6e90/.test(shown), shown);
	assert.ok(shown.includes('\u8bf7\u5ba1\u6838 ') && shown.includes('\u544a\u8bc9\u6211\u662f\u5426\u540c\u610f\u3002'), 'the words are the agent\'s');
});

test('plumbing is removed with its separators and nothing else: a mixed line keeps the person\'s links and words, the review instruction stays', () => {
	const here = (rel: string) => `/p/${rel.slice('drama/'.length)}`;
	const f = (title: string, rel: string) => `[${title}](${pathToFileURL(`/p/${rel}`).href})`;
	// Project links and records-pack links on one line, in every order.
	assert.equal(linkFiles('[\u5267\u672c](drama/a.md) · [\u8bb0\u5f55\u5305](handoff/project.tar.part-aa) · [\u62a5\u544a](drama/b.md)', here), `${f('\u5267\u672c', 'a.md')} · ${f('\u62a5\u544a', 'b.md')}`);
	assert.equal(linkFiles('[\u8bb0\u5f55\u5305](handoff/x), [\u5267\u672c](drama/a.md)', here), f('\u5267\u672c', 'a.md'));
	assert.equal(linkFiles('[\u5267\u672c](drama/a.md); [\u8bb0\u5f55\u5305](handoff/x)', here), f('\u5267\u672c', 'a.md'));
	// A line that ends in the review instruction and a plumbing link keeps the instruction.
	assert.equal(linkFiles('Please review the screenplay: [records](handoff/project.tar.part-aa)', here), 'Please review the screenplay:');
	assert.equal(linkFiles('\u8bf7\u5ba1\u6838\u5267\u672c\uff1a[\u8bb0\u5f55\u5305](handoff/project.tar.part-aa)', here), '\u8bf7\u5ba1\u6838\u5267\u672c\uff1a');
	// A line of plumbing only goes; the words around a plumbing link stay.
	assert.equal(linkFiles('Done.\n\n[Records: part 1](handoff/project.tar.part-aa) · [part 2](handoff/project.tar.part-ab)', here), 'Done.');
	assert.equal(linkFiles('Saved ([pack](handoff/x)) for the studio.', here), 'Saved () for the studio.');
});

test('other links and text without links are untouched', () => {
	const none = () => undefined;
	assert.equal(linkFiles('See [the docs](https://example.com/a) and [notes](notes/a.md).', none), 'See [the docs](https://example.com/a) and [notes](notes/a.md).');
	assert.equal(linkFiles('No links here.', none), 'No links here.');
});

test('a path is judged by where it really leads: `..` and a link out of the project are refused, with no link', async () => {
	const { store, src, root, dir, library } = await fixture();
	const link = (rel: string) => localProjectFile(src, T1, rel);
	assert.equal(link('drama/screenplay/v2/review.md'), join(root, 'screenplay/v2/review.md'));
	assert.equal(link('drama/screenplay/../screenplay/v2/review.md'), undefined, 'the stop kept `drama/screenplay/v2/review.md`, not this spelling of it');
	// An outside file the stop even "kept" and the Studio even holds a record for is still outside.
	for (const [rel, text] of [['drama/../outside.txt', 'secret'], ['drama/leak/a.txt', 'x']]) {
		const { sha, size } = await library.put(new TextEncoder().encode(text));
		store.insertLibraryFile({ chat_key: KEY, turn_id: T1, sha, rel_path: rel, size, type: 'text/plain', kind: 'other' });
	}
	assert.equal(link('drama/../outside.txt'), undefined, 'it exists, outside the project');
	assert.equal(link('drama/screenplay/../../outside.txt'), undefined);
	assert.equal(link('drama/leak/a.txt'), undefined, 'a symlink that leads out of the project');
	assert.equal(link('drama/screenplay/v2/nothing.md'), undefined, 'not here');
	assert.equal(link('drama/'), undefined, 'the project itself is not a file');
	assert.equal(link('handoff/lineage.json'), undefined);
	assert.equal(linkFiles('[x](drama/../outside.txt)', link), 'x', `no link to ${join(dir, 'outside.txt')}`);
});

test('the project root is itself a link out of the bound folder: nothing in it is linked, though both ends resolve through the link', async () => {
	const { dir, store, library } = await fixture();
	const bound = join(dir, 'bound');
	mkdirSync(bound);
	mkdirSync(join(dir, 'external', 'screenplay'), { recursive: true });
	writeFileSync(join(dir, 'external', 'screenplay', 'review.md'), 'external');
	const { sha, size } = await library.put(new TextEncoder().encode('external'));
	store.insertLibraryFile({ chat_key: KEY, turn_id: T1, sha, rel_path: 'drama/screenplay/review.md', size, type: 'text/markdown', kind: 'other' });
	symlinkSync(join(dir, 'external'), join(bound, 'drama'));
	const src = { store, has: (s: string) => library.has(s), root: join(bound, 'drama'), boundary: bound, key: KEY };
	assert.equal(localProjectFile(src, T1, 'drama/screenplay/review.md'), undefined);
});

test('a mirror file changed here, or replaced by a later turn, is not this turn\'s bytes: no link; nor for a turn that did not bring it, or no turn', async () => {
	const { src, root, arrive } = await fixture();
	const rel = 'drama/screenplay/v3/review.md';
	await arrive('turn-2', 'screenplay/v3/review.md', 'v1 from the Computer');
	const file = join(root, 'screenplay/v3/review.md');
	assert.equal(localProjectFile(src, 'turn-2', rel), file);
	// A later turn's version replaces it in the mirror: the earlier reply no longer links to bytes that are not its own.
	await arrive('turn-3', 'screenplay/v3/review.md', 'v2 from the Computer');
	assert.equal(localProjectFile(src, 'turn-3', rel), file);
	assert.equal(localProjectFile(src, 'turn-2', rel), undefined);
	// Someone forces an edit past the read-only mode: neither reply links to bytes the Computer did not return.
	chmodSync(file, 0o644);
	writeFileSync(file, 'an edit, longer than before');
	assert.equal(localProjectFile(src, 'turn-3', rel), undefined);
	assert.equal(linkFiles(`[the review](${rel})`, r => localProjectFile(src, 'turn-3', r)), 'the review');
	assert.equal(localProjectFile(src, 'turn-9', 'drama/screenplay/v2/review.md'), undefined, 'turn-9 brought nothing');
	assert.equal(localProjectFile(src, undefined, 'drama/screenplay/v2/review.md'), undefined, 'a reply drawn while its turn runs');
});
