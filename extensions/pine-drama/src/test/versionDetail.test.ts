import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDrama, type ScopedSnapshot } from '../core/project';
import type { Snapshot } from '../core/protocol';
import { madeWith, plannedWith, versionDetail } from '../core/versionDetail';
import { episodeLineage } from '../core/lineage';

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

/** The fixture's drama, with the take EP001 seg01 v1 made from `inputs`. */
async function takeMadeFrom(inputs: { object: string; version: string }[]) {
	const root = mkdtempSync(join(tmpdir(), 'pds-direct-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	const take = join(root, 'episodes/EP001/segments/seg01/v1/version.json');
	writeFileSync(take, JSON.stringify({ ...JSON.parse(readFileSync(take, 'utf8')), inputs }));
	return readDrama(root, () => [snapshot('snapshot-project.json'), snapshot('snapshot-episodes.json')]);
}

// The person: a take is made from its video prompt, which is made from the breakdown; the editor needs the video prompt,
// not the chain. A record lists every version its version was made from, the indirect ones too (doc/protocol.md 2.1,
// which released Studios read for discards); the Studio shows only those no other listed input was made from in turn.
test('a take shows only what it was made from directly: an input another listed input was made from is not shown', async () => {
	// The fixture's keyframe was made from Lin v1 and the office v1, so a take listing all three was made from the keyframe directly.
	const drama = await takeMadeFrom([{ object: 'assets/characters/lin', version: 'v1' }, { object: 'assets/scenes/office', version: 'v1' },
		{ object: 'episodes/EP001/keyframe/seg01/shot01', version: 'v1' }]);
	const detail = versionDetail(drama, 'episodes/EP001/segments/seg01', 'v1', rel => rel)!;
	assert.deepEqual([...detail.pictures, ...detail.madeFrom].map(r => r.stageId), ['episodes/EP001/keyframe/seg01/shot01']);
	assert.deepEqual(episodeLineage(drama, 'EP001').links.filter(l => l.to === 'episodes/EP001/segments/seg01').map(l => l.from), ['episodes/EP001/keyframe/seg01/shot01'],
		'the canvas draws the take\'s line from the keyframe only');
	// An input none of the others was made from stays, as does one whose own record the drama does not hold.
	const direct = await takeMadeFrom([{ object: 'assets/characters/lin', version: 'v2' }, { object: 'episodes/EP001/keyframe/seg01/shot01', version: 'v1' }]);
	assert.deepEqual(versionDetail(direct, 'episodes/EP001/segments/seg01', 'v1', rel => rel)!.pictures.map(r => r.stageId),
		['assets/characters/lin', 'episodes/EP001/keyframe/seg01/shot01']);
});

test('two listed inputs each made from the other both stay; an unlisted cycle hides nothing', async () => {
	const drama = await takeMadeFrom([{ object: 'assets/characters/lin', version: 'v1' }, { object: 'assets/scenes/office', version: 'v1' }]);
	const lin = drama.objects.get('assets/characters/lin')!.versions.find(v => v.id === 'v1')!;
	const office = drama.objects.get('assets/scenes/office')!.versions.find(v => v.id === 'v1')!;
	Object.assign(lin.record, { inputs: [{ object: 'assets/scenes/office', version: 'v1' }] });
	Object.assign(office.record, { inputs: [{ object: 'assets/characters/lin', version: 'v1' }] });
	assert.deepEqual(versionDetail(drama, 'episodes/EP001/segments/seg01', 'v1', rel => rel)!.pictures.map(r => r.stageId), ['assets/characters/lin', 'assets/scenes/office']);
});

// The person: the composer's greyed Model and settings show what the shown version was really made with, read for display
// from the request drama-cli saved, each provider in its own field names; anything else shows nothing.
test("a version's model and settings come from its saved job and request, in each provider's own field names", async () => {
	const folder = (job: unknown, request: unknown) => {
		const dir = mkdtempSync(join(tmpdir(), 'made-'));
		if (job !== undefined) { writeFileSync(join(dir, 'job.json'), JSON.stringify(job)); }
		if (request !== undefined) { writeFileSync(join(dir, 'request.json'), typeof request === 'string' ? request : JSON.stringify(request)); }
		return dir;
	};
	const cases: [unknown, unknown, unknown][] = [
		[{ kind: 'image', provider: 'openai', model: 'gpt-image-2.5-sunburst' }, { model: 'gpt-image-2.5-sunburst', prompt: 'p', size: '1152x2048', quality: 'high', n: 1 },
			{ model: 'gpt-image-2.5-sunburst', settings: ['size 1152x2048', 'quality high', 'n 1'] }],
		[{ kind: 'image', provider: 'seedream', model: 'dola-seedream-5-0-pro-260628' }, { size: '1440x2560', watermark: false },
			{ model: 'dola-seedream-5-0-pro-260628', settings: ['size 1440x2560'] }],
		[{ kind: 'video', provider: 'ark', model: 'sd25' }, { content: [], ratio: '9:16', resolution: '480p', duration: 19 },
			{ model: 'sd25', settings: ['ratio 9:16', 'resolution 480p', 'duration 19'] }],
		[{ kind: 'video', provider: 'dashscope', model: 'wan3.0-video' }, { input: {}, parameters: { resolution: '720P', ratio: '9:16', duration: 10, audio: true } },
			{ model: 'wan3.0-video', settings: ['resolution 720P', 'ratio 9:16', 'duration 10'] }],
		// MuleRouter's body names no model: it is in the task path, and job.json records it.
		[{ kind: 'video', provider: 'mulerouter', model: 'berry-1.0' }, { prompt: 'p', resolution: '1080p', ratio: '16:9', duration: 5 },
			{ model: 'berry-1.0', settings: ['resolution 1080p', 'ratio 16:9', 'duration 5'] }],
		// A field the request lacks is left out.
		[{ kind: 'image', provider: 'openai', model: 'm' }, { size: '1024x1024' }, { model: 'm', settings: ['size 1024x1024'] }],
		// Nothing for: an import (no files), a text call, an unknown provider, no request, a malformed request.
		[undefined, undefined, null],
		[{ kind: 'text', provider: 'openai', model: 'gpt-6.1-terra' }, { model: 'gpt-6.1-terra', messages: [] }, null],
		[{ kind: 'video', provider: 'somewhere', model: 'x' }, { duration: 5 }, null],
		[{ kind: 'video', provider: 'ark', model: 'sd25' }, undefined, null],
		[{ kind: 'video', provider: 'ark', model: 'sd25' }, '{not json', null],
	];
	for (const [job, request, want] of cases) {
		assert.deepEqual(await madeWith(folder(job, request)), want, JSON.stringify(job));
	}
});

// The person: before a node is drawn, the same controls show what is planned for it, from its latest prompt record.
test("a node not drawn yet shows the model and settings its latest prompt record plans, and nothing without one", async () => {
	const object = (records: Record<string, unknown>) => {
		const dir = mkdtempSync(join(tmpdir(), 'planned-'));
		for (const [version, record] of Object.entries(records)) {
			mkdirSync(join(dir, 'prompts', version), { recursive: true });
			writeFileSync(join(dir, 'prompts', version, 'prompt.json'), typeof record === 'string' ? record : JSON.stringify(record));
		}
		return dir;
	};
	const record = (request: unknown) => ({ by: 'template', text: 't', request });
	// The latest by number (v10 after v2), and only the fields it states.
	assert.deepEqual(await plannedWith(object({ v2: record({ model: 'old', aspect: '1:1' }), v10: record({ model: 'openai:gpt-image-2.5-sunburst', aspect: '9:16', images: [] }) })),
		{ model: 'openai:gpt-image-2.5-sunburst', settings: ['aspect 9:16'] });
	assert.deepEqual(await plannedWith(object({ v1: record({ model: 'm', aspect: '16:9', resolution: '2k', quality: 'high', count: 1 }) })),
		{ model: 'm', settings: ['aspect 16:9', 'resolution 2k', 'quality high', 'count 1'] });
	assert.equal(await plannedWith(object({})), null, 'no prompt record');
	assert.equal(await plannedWith(object({ v1: record({ aspect: '9:16' }) })), null, 'no model');
	assert.equal(await plannedWith(object({ v1: '{not json' })), null, 'malformed');
});
