// One resolver from a returned path to the mirror, with five states, each from
// its source. Fixture folders only.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveReturned } from '../core/resolve';
import { Store } from '../core/store';

const KEY = 'pine-computer:/local-1';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function setup(library: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), 'pine-resolve-'));
	const store = new Store(join(dir, 'studio.sqlite'));
	store.insertChat({ key: KEY, env: 'dev', endpoint: 'e', label: 'l', secret_ref: 'x' });
	const root = join(dir, 'Night Ward', 'drama');
	mkdirSync(join(root, 'bible', 'v1'), { recursive: true });
	writeFileSync(join(root, 'bible', 'v1', 'bible.md'), 'B1');
	const src = { store, root, boundary: join(dir, 'Night Ward'), key: KEY, has: (s: string) => library.includes(s) };
	return { dir, store, root, src };
}

test('arrived: the mirror holds the file, with the SHA-256 asked for', () => {
	const { root, src } = setup();
	const path = join(root, 'bible', 'v1', 'bible.md');
	assert.deepEqual(resolveReturned(src, 'drama/bible/v1/bible.md'), { state: 'arrived', where: 'folder', path });
	assert.deepEqual(resolveReturned(src, 'drama/bible/v1/bible.md', sha('B1')), { state: 'arrived', where: 'folder', path });
	assert.deepEqual(resolveReturned(src, 'drama/bible/v1/bible.md', sha('B1'), true), { state: 'arrived', where: 'folder', path });
});

test('a version the Computer has since updated opens from the library, and a newer copy is said', () => {
	const { src } = setup([sha('B0')]);
	assert.deepEqual(resolveReturned(src, 'drama/bible/v1/bible.md', sha('B0'), true), { state: 'arrived', where: 'library', sha: sha('B0'), newer: true });
	assert.deepEqual(resolveReturned(src, 'drama/looks/ann.png', sha('B0'), true), { state: 'arrived', where: 'library', sha: sha('B0'), newer: false });
});

test('arriving, failed and not returned come from the stops\' listings, never from a file being absent', () => {
	const { store, src } = setup();
	assert.deepEqual(resolveReturned(src, 'drama/looks/ann.png'), { state: 'notReturned' });
	store.startTurnFollowUp(KEY, 't1', 'needs_input', 'look');
	store.updateTurnFollowUp('t1', { returned: JSON.stringify(['drama/looks/ann.png']) });
	assert.deepEqual(resolveReturned(src, 'drama/looks/ann.png'), { state: 'arriving' });
	store.updateTurnFollowUp('t1', { save_error: 'Pine: FileNotFound (drama/looks/ann.png)' });
	assert.deepEqual(resolveReturned(src, 'drama/looks/ann.png'), { state: 'failed', error: 'Pine: FileNotFound (drama/looks/ann.png)' });
	assert.deepEqual(resolveReturned(src, 'drama/looks/lin.png'), { state: 'notReturned' }, 'a file no stop listed');
});

test('refused: a path that leaves drama/, by name or through a link', () => {
	const { dir, root, src } = setup();
	assert.equal(resolveReturned(src, 'drama/../outside.txt').state, 'refused');
	assert.equal(resolveReturned(src, 'handoff/lineage.json').state, 'refused');
	assert.equal(resolveReturned(src, '/etc/passwd').state, 'refused');
	mkdirSync(join(dir, 'elsewhere'));
	writeFileSync(join(dir, 'elsewhere', 'x.md'), 'X');
	symlinkSync(join(dir, 'elsewhere'), join(root, 'out'));
	assert.deepEqual(resolveReturned(src, 'drama/out/x.md'), { state: 'refused', reason: 'out/x.md leads outside the drama\'s folder through a link' });
});

test('refused: a drama/ that is itself a link out of the bound folder, though both ends resolve through it', () => {
	const { dir, store } = setup();
	const bound = join(dir, 'Linked');
	mkdirSync(join(dir, 'external', 'bible'), { recursive: true });
	writeFileSync(join(dir, 'external', 'bible', 'b.md'), 'B');
	mkdirSync(bound);
	symlinkSync(join(dir, 'external'), join(bound, 'drama'));
	const src = { store, root: join(bound, 'drama'), boundary: bound, key: KEY, has: () => false };
	assert.equal(resolveReturned(src, 'drama/bible/b.md').state, 'refused');
});
