import { strict as assert } from 'node:assert';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readChoices } from '../core/choices';
import { runCardAction, unchangedLine, USE_AS_MAIN, type EntryAsk } from '../core/entryActions';

// A card action is the person's choice, written to choices.json at the click (doc/protocol.md, section 3); the fixture
// is test-fixtures/protocol/drama.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol', 'drama');
const never: EntryAsk = { description: () => Promise.reject(new Error('not asked')), file: () => Promise.reject(new Error('not asked')),
	confirm: () => Promise.reject(new Error('not asked')) };
const yes: EntryAsk = { ...never, confirm: () => Promise.resolve(true) };

test('each card action lands in choices.json at once; doing it again changes nothing and says so', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cards-'));
	try {
		await cp(FIXTURE, root, { recursive: true });
		assert.deepEqual(await runCardAction(root, { action: 'choose', object: 'assets/characters/lin', version: 'v2' }, never), { already: false });
		assert.deepEqual(await runCardAction(root, { action: 'choose', object: 'assets/characters/lin', version: 'v2' }, never), { already: true });
		await runCardAction(root, { action: 'discard', object: 'assets/characters/lin', version: 'v1' }, yes);
		await runCardAction(root, { action: 'prompt', object: 'assets/characters/lin', text: 'Lin, rain-soaked' }, never);
		await runCardAction(root, { action: 'add', type: 'prop', name: 'Umbrella', text: 'Black.' }, never);
		const picture = join(root, 'assets', 'characters', 'lin', 'v1', 'image-1.png');
		await runCardAction(root, { action: 'import', object: 'assets/props/umbrella', file: picture }, never);
		const choices = await readChoices(root);
		assert.deepEqual(choices?.objects['assets/characters/lin'], { chosen: { version: 'v2', words: USE_AS_MAIN }, discarded: ['v1'], prompt: 'Lin, rain-soaked' });
		assert.equal(choices?.added.length, 1);
		const imported = choices!.imports.find(i => i.object === 'assets/props/umbrella')!;
		assert.deepEqual(choices?.objects['assets/props/umbrella'], { chosen: { import: imported.id } });
		assert.deepEqual(await readFile(join(root, ...imported.file.split('/'))), await readFile(picture), 'the picture is copied unchanged');
		assert.equal(await runCardAction(root, { action: 'import', object: 'assets/props/umbrella', file: null }, { ...never, file: () => Promise.resolve(undefined) }), undefined);
		assert.equal(unchangedLine(undefined), 'Cancelled: nothing was changed.');
	} finally { await rm(root, { recursive: true }); }
});

// Delete vN was instant (worker-06's monkey test, 2026-11-14): it asks first, as the Explorer does before a delete, and a
// No writes nothing.
test('Delete vN asks first: a No changes nothing and says so, a Yes discards the version', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cards-'));
	try {
		await cp(FIXTURE, root, { recursive: true });
		const discard = { action: 'discard', object: 'assets/characters/lin', version: 'v1' } as const;
		let asked: string | undefined;
		const no: EntryAsk = { ...never, confirm: question => { asked = question; return Promise.resolve(false); } };
		assert.equal(await runCardAction(root, discard, no), undefined);
		assert.equal(asked, 'Delete v1 of assets/characters/lin?');
		assert.equal((await readChoices(root))?.objects['assets/characters/lin']?.discarded, undefined, 'a No writes nothing');
		assert.deepEqual(await runCardAction(root, discard, yes), { already: false });
		assert.deepEqual((await readChoices(root))?.objects['assets/characters/lin']?.discarded, ['v1']);
	} finally { await rm(root, { recursive: true }); }
});
