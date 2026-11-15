import { strict as assert } from 'node:assert';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { writeWhole } from '../core/placement';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentVersion, readChoices, readVersions, UnsupportedMajor, versionRecordOf, type Choices } from '../core/major1';

// What a major-1 project's choices and versions resolve to, as the conversion reads them (core/major1.ts,
// convertMajor1ProjectToMajor2.ts), on a fixture drama of major 1 (test-fixtures/protocol/README.md).
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');

async function copy(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'choices-'));
	await cp(join(FIXTURE, 'drama'), dir, { recursive: true });
	return dir;
}

test('the current version is the person\'s choice, else the newest not discarded; a discarded or removed choice is no choice', async () => {
	const root = await copy();
	try {
		const versions = await readVersions(root, 'assets/characters/lin');
		const choices = (entry: Choices['objects'][string]): Choices => ({ schema: 1, objects: { 'assets/characters/lin': entry }, added: [], imports: [] });
		assert.equal(currentVersion(versions, null, 'assets/characters/lin'), 'v2', 'nothing chosen: the newest');
		assert.equal(currentVersion(versions, choices({ chosen: { version: 'v1', words: 'This one.' } }), 'assets/characters/lin'), 'v1');
		assert.equal(currentVersion(versions, choices({ chosen: { version: 'v2' }, discarded: ['v2'] }), 'assets/characters/lin'), 'v1');
		assert.equal(currentVersion(versions, choices({ chosen: { version: 'v1', words: 'Yes.' }, removed: true }), 'assets/characters/lin'), 'v2', 'a removed object keeps no choice');
		assert.equal(currentVersion(await readVersions(root, 'assets/scenes/office'), await readChoices(root), 'assets/scenes/office'), 'v1', 'the person\'s own import, chosen');
	} finally { await rm(root, { recursive: true }); }
});

test('a choices.json hand-edited, synced or written by another Studio is read as it is, keeping every choice it holds', async () => {
	const root = await copy();
	try {
		await writeWhole(join(root, 'choices.json'), JSON.stringify({ schema: 1, objects: { 'assets/characters/lin': { discarded: ['v2'], chosen: {}, pinned: 'later' }, 'assets/props/gone': null }, added: {} }));
		const choices = await readChoices(root);
		assert.deepEqual(choices?.objects['assets/characters/lin']?.discarded, ['v2']);
		assert.deepEqual([choices?.added, choices?.imports, choices?.objects['assets/props/gone']], [[], [], {}], 'a part it lacks, or gives as something else, is empty');
		await writeWhole(join(root, 'choices.json'), JSON.stringify({ schema: 2, objects: {} }));
		await assert.rejects(readChoices(root), UnsupportedMajor, 'only another major cannot be read');
	} finally { await rm(root, { recursive: true }); }
});

test('a choice without the words it needs, or naming a version the client lacks, is no choice', () => {
	const version = (id: string, reviewed: boolean) => ({ id, record: { schema: 1 as const, made_at: '2026-11-12T09:00:00Z', file: null, inputs: [], prompt: null, from_import: null },
		reviews: reviewed ? [{ schema: 1 as const, accepted_at: '2026-11-12T09:01:00Z', reason: 'ok' }] : [] });
	const versions = [version('v1', true), version('v2', false), version('v3', false)];
	const choices = (chosen: Choices['objects'][string]['chosen']): Choices => ({ schema: 1, objects: { o: { chosen } }, added: [], imports: [] });
	assert.equal(currentVersion(versions, choices({ version: 'v2' }), 'o'), 'v3', 'v2 needs words: no choice, so the newest');
	assert.equal(currentVersion(versions, choices({ version: 'v2', words: 'Yes.' }), 'o'), 'v2');
	assert.equal(currentVersion(versions, choices({ version: 'v1' }), 'o'), 'v1', 'a reviewed version needs no words');
	assert.equal(currentVersion(versions, choices({ version: 'v7', words: 'Yes.' }), 'o'), 'v3', 'an unknown version is no choice');
	// An older record names no `from_import` at all: it is not the person's own, so it needs words too.
	const older = { ...version('v4', false), record: versionRecordOf({ schema: 1, made_at: '2026-11-12T09:02:00Z', file: null, inputs: [], prompt: null, from_choice: null }) };
	assert.equal(currentVersion([...versions, older], choices({ version: 'v3' }), 'o'), 'v4');
});
