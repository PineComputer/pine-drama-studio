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
const never: EntryAsk = { description: () => Promise.reject(new Error('not asked')), file: () => Promise.reject(new Error('not asked')) };

test('each card action lands in choices.json at once; doing it again changes nothing and says so', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cards-'));
	try {
		await cp(FIXTURE, root, { recursive: true });
		assert.deepEqual(await runCardAction(root, { action: 'choose', object: 'assets/characters/lin', version: 'v2' }, never), { already: false });
		assert.deepEqual(await runCardAction(root, { action: 'choose', object: 'assets/characters/lin', version: 'v2' }, never), { already: true });
		await runCardAction(root, { action: 'discard', object: 'assets/characters/lin', version: 'v1' }, never);
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
