import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetsLineage } from '../core/lineage';
import { describeStage, detailOf, readDrama, versionRows, type ScopedSnapshot, type StageDetail, type Version } from '../core/project';
import type { Snapshot } from '../core/protocol';

const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const snapshot = (name: string): ScopedSnapshot => ({ scope: name.includes('episodes') ? 'episodes' : 'project', task: name,
	snapshot: JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Snapshot, sent: '2026-11-12T13:00:00Z', installed: '2026-11-12T13:01:00Z' });

/** The fixture's drama, with Lin's v2 record changed by `change` (Lin has v1 and v2; v2 is current). */
async function linWith(change: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), 'pds-continues-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	const file = join(root, 'assets/characters/lin/v2/version.json');
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...change }));
	return readDrama(root, () => [snapshot('snapshot-project.json'), snapshot('snapshot-episodes.json')]);
}

// A bible written in ranges is one piece of work in parts: each range's version continues the one before
// (doc/protocol.md 2.1, `continues`). The parts are one entry; a revision, and an older record with no field, are not.
test('a chain of continues is one entry written in parts; a revision or an older record is a version of its own', async () => {
	const parts = await linWith({ continues: 'v1' });
	const lin = detailOf(parts.objects.get('assets/characters/lin')!);
	assert.equal(describeStage(lin), 'approved v1 by the agent · working v2 · written in 2 parts', 'the working version is the one written in parts');
	assert.deepEqual(versionRows(lin).map(row => [row.version.name, row.parts.map(p => p.name)]), [['v2', ['v1']]]);
	assert.equal(assetsLineage(parts).stages.find(s => s.id === 'assets/characters/lin')?.parts, 2);

	for (const drama of [await linWith({}), await linWith({ continues: 'v9' })]) {
		const plain = detailOf(drama.objects.get('assets/characters/lin')!);
		assert.doesNotMatch(describeStage(plain), /parts/);
		assert.deepEqual(versionRows(plain).map(row => [row.version.name, row.parts.length]), [['v2', 0], ['v1', 0]], 'a version it does not hold continues nothing here');
		assert.equal(assetsLineage(drama).stages.find(s => s.id === 'assets/characters/lin')?.parts, undefined);
	}
});

/** A stage's detail with versions newest first, each continuing the one `continues` names. */
function detail(pointers: StageDetail['pointers'], versions: [string, string | null][]): StageDetail {
	return { path: 'bible', pointers, acceptedBy: null, versions: versions.map(([name, continues]): Version =>
		({ name, path: `bible/${name}`, createdAt: '2026-11-13T00:00:00Z', file: null, own: false, discarded: false, reviews: [], continues })) };
}

test('the parts are counted from the version shown, whichever entry it is folded under', () => {
	const three = detail({ current: 'v2', accepted: 'v2' }, [['v3', 'v2'], ['v2', 'v1'], ['v1', null]]);
	assert.equal(describeStage(three), 'approved v2 · written in 2 parts');
	assert.deepEqual(versionRows(three).map(row => [row.version.name, row.parts.map(p => p.name)]), [['v3', ['v2', 'v1']]]);
});

test('a cycle of continues folds nothing, so no version is hidden', () => {
	for (const versions of [[['v2', 'v1'], ['v1', 'v2']], [['v2', 'v2'], ['v1', null]]] as [string, string | null][][]) {
		const rows = versionRows(detail({ current: 'v2' }, versions));
		assert.deepEqual(rows.map(row => [row.version.name, row.parts.length]), [['v2', 0], ['v1', 0]], JSON.stringify(versions));
	}
});
