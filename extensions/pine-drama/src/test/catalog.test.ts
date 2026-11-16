import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readCatalog, takePrice, takesFit } from '../core/catalog';

// The shape GET /v1/models answers for media.drama (PineSandbox provider-runtime/pkg/proxy/service.go, catalog): a
// Seedance 2.5 and a 2.0 profile from drama-v3.json, an image model, and the pine-media-video-v3 rates (pricing/media.go).
const ANSWER = JSON.stringify({
	execution_scope: 'scope',
	models: {
		'ark:sd25': { kind: 'video', parameters: { duration: [4, 5, 10, 22, 30], resolution: ['480p', '720p'] }, input_fields: ['content'] },
		'ark:sd2': { kind: 'video', parameters: { duration: [4, 10, 15], resolution: ['480p', '720p'] }, input_fields: ['content'] },
		'seedream:dola-seedream-5-5-261028': { kind: 'image', parameters: { watermark: [false] }, input_fields: [] },
	},
	pricing: { key: 'pine-media-provider-duration-v3', rates: {
		'media.video.480p.generated_ms': { nano_usd: 12_000_000_000, per_units: 60_000 },
		'media.video.720p.generated_ms': { nano_usd: 20_000_000_000, per_units: 60_000 },
	} },
});

test('the catalogue gives each model by its --model id and kind, and the video price per second by resolution', () => {
	const catalog = readCatalog(ANSWER);
	assert.deepEqual(catalog.models.map(m => `${m.id} ${m.kind}`), ['ark:sd2 video', 'ark:sd25 video', 'seedream:dola-seedream-5-5-261028 image']);
	assert.equal(takePrice(catalog, 10, '720p'), '10 s · 720p · $3.33');
	assert.equal(takePrice(catalog, 22, '480p'), '22 s · 480p · $4.40');
	assert.equal(takePrice(catalog, 10, '1080p'), null, 'no price the policy does not state');
});

test('a take fits a model only at a duration and resolution its profile admits', () => {
	const catalog = readCatalog(ANSWER);
	const sd2 = catalog.models.find(m => m.id === 'ark:sd2')!;
	const sd25 = catalog.models.find(m => m.id === 'ark:sd25')!;
	assert.equal(takesFit(sd2, 22, '480p'), false, 'Seedance 2.0 makes at most 15 s');
	assert.equal(takesFit(sd25, 22, '480p'), true);
	assert.equal(takesFit(sd25, 22, '1080p'), false);
});

test('an answer that is no catalogue is refused, not read as an empty one', () => {
	assert.throws(() => readCatalog('{"error":"forbidden"}'), /no model catalogue/);
	assert.throws(() => readCatalog('Forbidden'));
});
