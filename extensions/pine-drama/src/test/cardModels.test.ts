import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readFromCanvas, CANVAS_PROTOCOL } from '../core/canvasProtocol';
import { readCatalog } from '../core/catalog';
import { madeWith, modelChoices, remakeCommands } from '../core/cardModels';
import { commandMessage, commandOf } from '../core/commandSend';
import type { ProjectObject } from '../core/project';

const CATALOG = readCatalog(JSON.stringify({
	models: {
		'ark:sd25': { kind: 'video', parameters: { duration: [4, 10, 22, 30], resolution: ['480p', '720p'] } },
		'ark:sd2': { kind: 'video', parameters: { duration: [4, 10, 15], resolution: ['480p', '720p'] } },
		'seedream:dola-seedream-5-5-261028': { kind: 'image', parameters: {} },
		'anthropic:claude-opus-5-5': { kind: 'text', parameters: {} },
	},
	pricing: { rates: { 'media.video.480p.generated_ms': { nano_usd: 12_000_000_000, per_units: 60_000 } } },
}));

const object = (id: string, type: string, shownFile: string | null, episode: string | null = null, segment: string | null = null) =>
	({ id, type, name: id, episode, segment, setting: null, shownFile, shownFileReceipt: null, variantOf: null, objectsSentByDrawRequest: [], description: null, prompt: null, makingNow: false }) as unknown as ProjectObject;

const TAKE = object('episodes/EP003/segments/seg02', 'take', 'episodes/EP003/segments/seg02/video.mp4', 'EP003', 'seg02');

test('a picture offers the image models, included; a take the video models, at its own length and price', () => {
	assert.deepEqual(modelChoices(CATALOG, object('assets/props/key-ring', 'prop', null), null),
		[{ id: 'seedream:dola-seedream-5-5-261028', cost: 'included', unfit: null }]);
	assert.deepEqual(modelChoices(CATALOG, TAKE, { model: 'ark:sd25', seconds: 22, resolution: '480p' }), [
		{ id: 'ark:sd2', cost: '22 s · 480p · $4.40', unfit: 'cannot make 22 s at 480p' },
		{ id: 'ark:sd25', cost: '22 s · 480p · $4.40', unfit: null },
	]);
	assert.equal(modelChoices(CATALOG, TAKE, null)[0]!.cost, 'priced when shot');
});

test('a picture is made again by drama-cli make with the model; a take by video-prompts then shoot', () => {
	assert.deepEqual(remakeCommands(object('assets/props/key-ring', 'prop', null), 'seedream:x'),
		[['drama-cli', 'make', 'drama/assets/props/key-ring', '--model', 'seedream:x', '--config', 'drama/drama-cli.cfg.yaml']]);
	assert.deepEqual(remakeCommands(TAKE, 'ark:sd25flash'), [
		['drama-cli', 'video-prompts', 'EP003', 'seg02', '--model', 'ark:sd25flash', '--config', 'drama/drama-cli.cfg.yaml'],
		['drama-cli', 'shoot', 'EP003', '--segments', 'seg02', '--config', 'drama/drama-cli.cfg.yaml'],
	]);
	// Each goes as a "$ " message and reads back as the same argv.
	for (const argv of remakeCommands(TAKE, 'ark:sd25flash')) { assert.deepEqual(commandOf(commandMessage(argv)), argv); }
});

test('what a take was made with is read from its receipt\'s paid call in the records; none without them', async () => {
	const root = mkdtempSync(join(tmpdir(), 'card-models-'));
	const write = (rel: string, value: unknown) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(value)); };
	assert.equal(await madeWith(root, TAKE), null);
	write('episodes/EP003/segments/seg02/video.mp4.receipt.json', { schema: 2, paid_call_id: '20261115T102225150452-e06ff137' });
	assert.equal(await madeWith(root, TAKE), null, 'no ledger, nothing said');
	write('pine-computer-records/episodes/EP003/segments/seg02/20261115T102225150452-e06ff137/drama_cli_paid_call_ledger.json',
		{ provider: 'ark', model: 'sd25', params: { duration: 22, resolution: '480p' } });
	assert.deepEqual(await madeWith(root, TAKE), { model: 'ark:sd25', seconds: 22, resolution: '480p' });
});

test('the canvas reads a Model menu request and a Generate with a model; a model id with shell signs is refused', () => {
	assert.deepEqual(readFromCanvas({ v: CANVAS_PROTOCOL, type: 'models', stageId: 'assets/props/key-ring' }), { v: CANVAS_PROTOCOL, type: 'models', stageId: 'assets/props/key-ring' });
	assert.deepEqual(readFromCanvas({ v: CANVAS_PROTOCOL, type: 'generate', stageId: 'assets/props/key-ring', model: 'seedream:dola-seedream-5-5-261028' }),
		{ v: CANVAS_PROTOCOL, type: 'generate', stageId: 'assets/props/key-ring', model: 'seedream:dola-seedream-5-5-261028' });
	assert.equal(readFromCanvas({ v: CANVAS_PROTOCOL, type: 'generate', stageId: 'assets/props/key-ring', model: 'x:y; rm -rf ~' }), undefined);
	assert.deepEqual(readFromCanvas({ v: CANVAS_PROTOCOL, type: 'generate', stageId: 'assets/props/key-ring' }), { v: CANVAS_PROTOCOL, type: 'generate', stageId: 'assets/props/key-ring' });
});
