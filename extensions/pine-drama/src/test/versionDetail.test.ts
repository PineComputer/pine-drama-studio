import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDrama, type ScopedSnapshot } from '../core/project';
import type { Snapshot } from '../core/protocol';
import { madeWith, plannedWith, requestDetail, versionDetail } from '../core/versionDetail';
import { sentRequest } from '../core/requestRead';
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

// A storyboard is drawn from its scene's floor plan, a version no snapshot lists as an object (drama-cli's `plan`), yet its
// folder is in the project: its picture is shown from its own version.json, with no card to go to. A folder the record
// names but the project lacks, or holds unreadable, is listed by name and breaks nothing.
test("an input no snapshot lists shows its picture from its folder's version.json, with no card", async () => {
	const root = mkdtempSync(join(tmpdir(), 'pds-unlisted-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	mkdirSync(join(root, 'assets/scenes/office/plan/v1'), { recursive: true });
	writeFileSync(join(root, 'assets/scenes/office/plan/v1/version.json'), JSON.stringify({ schema: 1, made_at: '2026-11-12T12:00:00Z', file: 'image-1.jpg', inputs: [], prompt: null, from_import: null }));
	mkdirSync(join(root, 'assets/scenes/office/broken/v1'), { recursive: true });
	writeFileSync(join(root, 'assets/scenes/office/broken/v1/version.json'), '{not json');
	// A `file` the protocol refuses (it leaves its folder) shows nothing either.
	mkdirSync(join(root, 'assets/scenes/office/outside/v1'), { recursive: true });
	writeFileSync(join(root, 'assets/scenes/office/outside/v1/version.json'), JSON.stringify({ schema: 1, made_at: '2026-11-12T12:00:00Z', file: '../../plan/v1/image-1.jpg', inputs: [], prompt: null, from_import: null }));
	const take = join(root, 'episodes/EP001/segments/seg01/v1/version.json');
	const plan = { object: 'assets/scenes/office/plan', version: 'v1' };
	writeFileSync(take, JSON.stringify({ ...JSON.parse(readFileSync(take, 'utf8')), inputs: [plan, { object: 'assets/scenes/office/gone', version: 'v1' },
		{ object: 'assets/scenes/office/broken', version: 'v1' }, { object: 'assets/scenes/office/outside', version: 'v1' },
		{ object: 'episodes/EP001/keyframe/seg01/shot01', version: 'v1' }] }));
	const drama = await readDrama(root, () => [snapshot('snapshot-project.json'), snapshot('snapshot-episodes.json')]);
	const detail = versionDetail(drama, 'episodes/EP001/segments/seg01', 'v1', rel => rel)!;
	assert.deepEqual(detail.pictures.map(r => [r.src, r.stageId]), [['assets/scenes/office/plan/v1/image-1.jpg', null],
		['episodes/EP001/keyframe/seg01/shot01/v1/image-1.png', 'episodes/EP001/keyframe/seg01/shot01']]);
	assert.deepEqual(detail.madeFrom.map(r => [r.src, r.stageId]), [[null, null], [null, null], [null, null]], 'the missing, the unreadable and the refused folder, by name');
});

// The person: the take's references are its prompt's Image 1..N, in that order. The old seg editor's reader (#425, #539),
// ported: the request's own image order, an asset:// image by its upload's sha256 among the files the request pins, a
// path by the pinned file it ends with, and the first frame by the version drama-cli records it placed as Image 1.
test("a take's pictures are numbered as its request sent them, then any other it lists; unread, they stay as listed", async () => {
	const root = mkdtempSync(join(tmpdir(), 'pds-sent-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	const take = 'episodes/EP001/segments/seg01/v1';
	const pin = (path: string) => ({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') });
	const lin = pin('assets/characters/lin/v1/image-1.png');
	writeFileSync(join(root, take, 'spec.json'), JSON.stringify({
		content: [{ type: 'text', text: 'Image 1 is the first frame. Image 2 is the office. Image 3 is Lin.' },
			{ type: 'image_url', image_url: { url: 'asset://frame' } },
			{ type: 'image_url', image_url: { url: '@/var/lib/sandbox/sessions/s/files/drama/assets/scenes/office/v1/image-1.png' } },
			{ type: 'image_url', image_url: { url: 'asset://lin' } }],
		// Lin was uploaded: its upload's sha256 is the one its pinned file has in this project.
		drama: { first_frame: 'v1', asset_files: { 'asset://lin': lin.sha256 }, lineage: [lin, pin('assets/scenes/office/v1/image-1.png')] },
	}));
	const record = join(root, take, 'version.json');
	writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), inputs: [{ object: 'episodes/EP001/breakdown', version: 'v1' },
		{ object: 'assets/characters/lin', version: 'v2' }, { object: 'assets/characters/lin', version: 'v1' }, { object: 'assets/scenes/office', version: 'v1' }] }));
	const drama = await readDrama(root, () => [snapshot('snapshot-project.json'), snapshot('snapshot-episodes.json')]);
	const seg = drama.objects.get('episodes/EP001/segments/seg01')!;
	const detail = (await requestDetail(drama, root, seg, 'v1', rel => rel))!;
	assert.deepEqual(detail.pictures.map(p => [p.n, p.src]), [[1, 'episodes/EP001/keyframe/seg01/shot01/v1/image-1.png'],
		[2, 'assets/scenes/office/v1/image-1.png'], [3, 'assets/characters/lin/v1/image-1.png'], [undefined, 'assets/characters/lin/v2/image-1.png']],
		'Image 1 the first frame, 2 and 3 as sent, then Lin v2, listed but not sent, unnumbered');
	assert.deepEqual(detail.madeFrom.map(r => r.stageId), ['episodes/EP001/breakdown']);
	// No request, or one that cannot be read: the pictures as the record lists them, nothing numbered, no error.
	writeFileSync(join(root, take, 'spec.json'), '{not json');
	assert.deepEqual((await requestDetail(drama, root, seg, 'v1', rel => rel))!.pictures.map(p => p.n), [undefined, undefined, undefined]);
	// A compiled request keeps Image 1 for the frame shoot adds, and numbers its own images from 2 (#539).
	mkdirSync(join(root, 'compiled'));
	writeFileSync(join(root, 'compiled', 'seg01.json'), JSON.stringify({ content: [{ type: 'text', text: 'Image 1 is the first frame.\nImage 2 is Lin.' },
		{ type: 'image_url', image_url: { url: '@C:\\Users\\me\\drama\\assets\\characters\\lin\\v1\\image-1.png' } }], drama: { lineage: [lin] } }));
	assert.deepEqual(await sentRequest(path => join(root, ...path.split('/')), 'compiled', 'seg01.json'), { images: [{ n: 2, file: 'assets/characters/lin/v1/image-1.png' }], firstFrame: { n: 1, version: null } });
	// A Wan request states its prompt and images in `input` (Model Studio's create-task request).
	writeFileSync(join(root, 'compiled', 'seg02.json'), JSON.stringify({ input: { prompt: 'Image 1 is the first frame.\nImage 2 is Lin.',
		media: [{ type: 'reference_image', url: '@assets/characters/lin/v1/image-1.png' }] }, drama: { lineage: [lin] } }));
	assert.deepEqual(await sentRequest(path => join(root, ...path.split('/')), 'compiled', 'seg02.json'), { images: [{ n: 2, file: 'assets/characters/lin/v1/image-1.png' }], firstFrame: { n: 1, version: null } });
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
