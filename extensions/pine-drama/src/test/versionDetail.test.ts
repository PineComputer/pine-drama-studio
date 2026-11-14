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

// The person: a take is made from the pictures its call sent, and its panel showed only its keyframe once it hid every
// input another listed input was made from (#81). A record lists every version its version was made from (doc/protocol.md
// 2.1); the panel and the canvas show every one: the pictures in the strip, the rest by name.
test('a take shows every input it lists: its pictures in the strip, the rest by name, and a line from each on the canvas', async () => {
	const drama = await takeMadeFrom([{ object: 'episodes/EP001/breakdown', version: 'v1' }, { object: 'assets/characters/lin', version: 'v1' },
		{ object: 'assets/scenes/office', version: 'v1' }, { object: 'episodes/EP001/keyframe/seg01/shot01', version: 'v1' }]);
	const detail = versionDetail(drama, 'episodes/EP001/segments/seg01', 'v1', rel => rel)!;
	assert.deepEqual(detail.pictures.map(r => r.stageId), ['assets/characters/lin', 'assets/scenes/office', 'episodes/EP001/keyframe/seg01/shot01']);
	assert.deepEqual(detail.madeFrom.map(r => r.stageId), ['episodes/EP001/breakdown']);
	assert.deepEqual(episodeLineage(drama, 'EP001').links.filter(l => l.to === 'episodes/EP001/segments/seg01').map(l => l.from).sort(),
		['assets/characters/lin', 'assets/scenes/office', 'episodes/EP001/breakdown', 'episodes/EP001/keyframe/seg01/shot01'],
		'the canvas links every input (it draws those on the board)');
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
			{ model: 'gpt-image-2.5-sunburst', settings: ['1152×2048', 'high', '1 image'] }],
		[{ kind: 'image', provider: 'seedream', model: 'dola-seedream-5-0-pro-260628' }, { size: '1440x2560', watermark: false },
			{ model: 'dola-seedream-5-0-pro-260628', settings: ['1440×2560'] }],
		[{ kind: 'video', provider: 'ark', model: 'sd25' }, { content: [], ratio: '9:16', resolution: '480p', duration: 19 },
			{ model: 'sd25', settings: ['9:16', '480p', '19 s'] }],
		[{ kind: 'video', provider: 'dashscope', model: 'wan3.0-video' }, { input: {}, parameters: { resolution: '720P', ratio: '9:16', duration: 10, audio: true } },
			{ model: 'wan3.0-video', settings: ['720P', '9:16', '10 s'] }],
		// MuleRouter's body names no model: it is in the task path, and job.json records it.
		[{ kind: 'video', provider: 'mulerouter', model: 'berry-1.0' }, { prompt: 'p', resolution: '1080p', ratio: '16:9', duration: 5 },
			{ model: 'berry-1.0', settings: ['1080p', '16:9', '5 s'] }],
		// A field the request lacks is left out; more than one image reads in the plural.
		[{ kind: 'image', provider: 'openai', model: 'm' }, { size: '1024x1024' }, { model: 'm', settings: ['1024×1024'] }],
		[{ kind: 'image', provider: 'openai', model: 'm' }, { n: 2 }, { model: 'm', settings: ['2 images'] }],
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
	// The latest by number (v10 after v2); a record written before `parameters` shows its aspect alone; the model is
	// shown without its provider.
	assert.deepEqual(await plannedWith(object({ v2: record({ model: 'old', aspect: '1:1' }), v10: record({ model: 'openai:gpt-image-2.5-sunburst', aspect: '9:16', images: [] }) })),
		{ model: 'gpt-image-2.5-sunburst', settings: ['9:16'] });
	// `parameters` by the provider's own names (short_drama#1178); what is not shown (thinking_level, generate_audio) is left out.
	const planned = async (model: string, parameters: Record<string, unknown>) =>
		(await plannedWith(object({ v1: record({ model, aspect: '9:16', images: [], parameters }) })))?.settings;
	assert.deepEqual(await planned('openai:gpt-image-2.5-sunburst', { size: '1152x2048', quality: 'high' }), ['9:16', '1152×2048', 'high']);
	assert.deepEqual(await planned('seedream:dola-seedream-5-0-pro-260628', { size: '1440x2560' }), ['9:16', '1440×2560']);
	assert.deepEqual(await planned('gemini:gemini-3-pro-image', { image_size: '2K', thinking_level: 'high' }), ['9:16', '2K']);
	assert.deepEqual(await planned('ark:sd25', { resolution: '480p', ratio: '16:9', duration: 15, generate_audio: true }), ['480p', '16:9', '15 s'], 'a video\'s own ratio');
	assert.deepEqual(await planned('dashscope:wan3.0-video', { resolution: '720P', ratio: '9:16', duration: 10 }), ['720P', '9:16', '10 s']);
	for (const unknown of ['somewhere:x', 'constructor:x', 'toString:x', 'x']) {
		assert.deepEqual(await planned(unknown, { resolution: '1k' }), [], `${unknown}: an unknown provider shows its model alone`);
	}
	assert.equal(await plannedWith(object({})), null, 'no prompt record');
	assert.equal(await plannedWith(object({ v1: record({ aspect: '9:16' }) })), null, 'no model');
	assert.equal(await plannedWith(object({ v1: '{not json' })), null, 'malformed');
});
