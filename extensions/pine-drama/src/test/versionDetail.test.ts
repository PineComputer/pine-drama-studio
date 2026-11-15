import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lineageMessage } from '../core/canvasMessage';
import { readProjectFromFolder } from '../core/project';
import { nextDrawRequest, receiptDetail } from '../core/versionDetail';

// What a shown file was made with (core/versionDetail.ts, receiptDetail), on the major-2 fixture
// (test-fixtures/project-v2): its receipt, the one source. The rules that, broken, would number a picture wrongly,
// lose a text it was sent, or invent a request for the person's own file.
const FIXTURES = join(__dirname, '..', '..', 'test-fixtures', 'project-v2');
const copy = () => {
	const root = mkdtempSync(join(tmpdir(), 'pds-receipt-'));
	cpSync(join(FIXTURES, 'full'), root, { recursive: true });
	return root;
};
const src = (rel: string) => `webview:${rel}`;

test("a take's receipt gives its prompt, when it was finished, and its pictures as Image 1..N in the order they were sent", async () => {
	const root = copy();
	const drama = await readProjectFromFolder(root);
	const detail = (await receiptDetail(root, drama, drama.objects.get('episodes/EP001/segments/seg01')!, src))!;
	assert.equal(detail.prompt, 'Image 1 is the first frame. Lin turns from the window.');
	assert.equal(detail.madeAt, '2026-11-12T11:10:00Z');
	assert.deepEqual(detail.pictures.map(p => [p.n, p.label, p.src, p.stageId]), [
		[1, 'EP001 · seg01 shot01', 'webview:episodes/EP001/keyframe/seg01/shot01/frame.png', 'episodes/EP001/keyframe/seg01/shot01'],
		[2, 'Lin', 'webview:assets/characters/lin/look.png', 'assets/characters/lin'],
	]);
	assert.deepEqual(detail.madeFrom, []);
});

test("a picture redrawn since shows no thumbnail of its new bytes under an earlier result, and says it changed", async () => {
	const root = copy();
	writeFileSync(join(root, 'assets/characters/lin/look.png'), 'a new look');
	const drama = await readProjectFromFolder(root);
	const detail = (await receiptDetail(root, drama, drama.objects.get('episodes/EP001/segments/seg01')!, src))!;
	assert.deepEqual(detail.pictures.map(p => [p.n, p.label, p.src]), [
		[1, 'EP001 · seg01 shot01', 'webview:episodes/EP001/keyframe/seg01/shot01/frame.png'],
		[2, 'Lin (changed since)', null],
	]);
});

test("a text it was sent is listed by name and numbers no picture; the person's own file has no receipt and shows none", async () => {
	const root = copy();
	writeFileSync(join(root, 'assets/props/umbrella/picture.png.receipt.json'), JSON.stringify({ schema: 2, paid_call_id: 'call-umbrella-0002', finished_at: '2026-11-12T10:08:00Z',
		inputs_sent_in_order: [{ path: 'bible/bible.md', sha256: '0'.repeat(64) }, { path: 'assets/characters/lin/look.png', sha256: '1'.repeat(64) }], prompt_sent: null, cost: null }));
	const drama = await readProjectFromFolder(root);
	const detail = (await receiptDetail(root, drama, drama.objects.get('assets/props/umbrella')!, src))!;
	assert.deepEqual(detail.madeFrom.map(m => [m.label, m.stageId, m.n]), [['Story bible', 'bible', undefined]]);
	assert.deepEqual(detail.pictures.map(p => [p.n, p.label, p.src]), [[1, 'Lin (changed since)', null]], 'the bytes it was sent are not the ones the project holds');
	assert.equal(detail.prompt, null);
	assert.equal(await receiptDetail(root, drama, drama.objects.get('assets/scenes/office')!, src), null);
	assert.equal(await receiptDetail(root, drama, drama.objects.get('assets/scenes/street')!, src), null, 'a planned object shows nothing');
});

test("the episode canvas draws every line from what each draw request sends, drawn or not, never from a receipt", async () => {
	const root = copy();
	// A receipt that names other files changes no line: it records a past draw, shown with that result.
	writeFileSync(join(root, 'episodes/EP001/segments/seg01/take.mp4.receipt.json'), JSON.stringify({ schema: 2, paid_call_id: 'call-take-seg01-0001',
		finished_at: '2026-11-12T11:10:00Z', inputs_sent_in_order: [{ path: 'assets/props/umbrella/picture.png', sha256: '0'.repeat(64) }], prompt_sent: null, cost: null }));
	const message = await lineageMessage({ root, episode: 'EP001', drama: await readProjectFromFolder(root), layout: {}, focus: undefined, viewport: undefined, src });
	assert.deepEqual(message.links.map(l => `${l.from} → ${l.to}`).sort(), [
		'assets/characters/lin → episodes/EP001/keyframe/seg01/shot01',
		'assets/characters/lin → episodes/EP001/segments/seg01',
		'assets/characters/lin → episodes/EP001/segments/seg02',
		'assets/props/umbrella → episodes/EP001/segments/seg02',
		'assets/scenes/office → episodes/EP001/keyframe/seg01/shot01',
		'assets/scenes/street → episodes/EP001/segments/seg02',
		'episodes/EP001/keyframe/seg01/shot01 → episodes/EP001/segments/seg01',
	]);
	const card = (id: string) => message.cards.find(c => c.id === id)!;
	assert.deepEqual([card('episodes/EP001/segments/seg01').file, card('episodes/EP001/segments/seg01').media], ['episodes/EP001/segments/seg01/take.mp4', 'video']);
	assert.equal(card('episodes/EP001/segments/seg02').file, null);
});

test("the composer's references are what the next draw request sends, numbered Image 1..N in its order", async () => {
	const root = copy();
	const drama = await readProjectFromFolder(root);
	assert.deepEqual(nextDrawRequest(drama, drama.objects.get('episodes/EP001/segments/seg02')!, src).map(r => [r.n, r.label, r.src, r.stageId]), [
		[1, 'Lin', 'webview:assets/characters/lin/look.png', 'assets/characters/lin'],
		[2, 'Umbrella', 'webview:assets/props/umbrella/picture.png', 'assets/props/umbrella'],
		[3, 'Street', null, 'assets/scenes/street'],
	], 'a planned scene sends no picture yet, and keeps its number');
	assert.deepEqual(nextDrawRequest(drama, drama.objects.get('assets/characters/lin/variants/rain')!, src).map(r => r.stageId), ['assets/characters/lin'], "a variant's base");
	assert.deepEqual(nextDrawRequest(drama, drama.objects.get('assets/characters/lin')!, src), [], 'an object drawn from nothing else');
});
