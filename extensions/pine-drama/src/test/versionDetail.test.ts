import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDrama, type ScopedSnapshot } from '../core/project';
import type { Snapshot } from '../core/protocol';
import { versionDetail } from '../core/versionDetail';

const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const snapshot = (name: string): ScopedSnapshot => ({ scope: name.includes('episodes') ? 'episodes' : 'project', task: name,
	snapshot: JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Snapshot, sent: '2026-11-12T13:00:00Z', installed: '2026-11-12T13:01:00Z' });

// #77: a take's inputs include text versions (the bible, its breakdown, an asset's entry, the video prompts), which the
// panel drew as empty picture boxes; and it numbered inputs as the prompt's "Image N", which counts request images in
// another order. Pictures show as pictures, text inputs by name, and no input claims an image number.
test("a version's picture inputs are its pictures, its text inputs are listed by name, and none is numbered", async () => {
	const root = mkdtempSync(join(tmpdir(), 'pds-detail-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	const take = join(root, 'episodes/EP001/segments/seg01/v1/version.json');
	const record = JSON.parse(readFileSync(take, 'utf8'));
	record.inputs = [{ object: 'episodes/EP001/breakdown', version: 'v1' }, { object: 'episodes/EP001/keyframe/seg01/shot01', version: 'v1' }];
	writeFileSync(take, JSON.stringify(record));
	const drama = await readDrama(root, () => [snapshot('snapshot-project.json'), snapshot('snapshot-episodes.json')]);
	const detail = versionDetail(drama, 'episodes/EP001/segments/seg01', 'v1', rel => `webview:${rel}`)!;
	assert.deepEqual(detail.pictures.map(p => [p.src, p.stageId]), [['webview:episodes/EP001/keyframe/seg01/shot01/v1/image-1.png', 'episodes/EP001/keyframe/seg01/shot01']]);
	assert.deepEqual(detail.madeFrom.map(p => [p.src, p.stageId]), [[null, 'episodes/EP001/breakdown']]);
	assert.ok(detail.madeFrom[0].label.length > 0);
	for (const reference of [...detail.pictures, ...detail.madeFrom]) { assert.equal('n' in reference, false, 'no input claims an image number'); }
});
