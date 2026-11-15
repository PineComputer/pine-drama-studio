import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lineageMessage } from '../core/canvasMessage';
import { onBoard } from '../core/canvasLayout';
import { RefusedWithUpgradeInstructions, STUDIO_RELEASES_URL } from '../core/protocol';
import { DramaProject, episodeOfNode, fileAddressByVersion, objectTitle, readProjectFromFolder } from '../core/project';
import { decomposition } from '../core/threeSteps';

// The project as every view reads it (core/project.ts, readProjectFromFolder), on the major-2 fixture
// (test-fixtures/project-v2): the rules that, broken, would hide an object, show a folder that is none, lose what a
// picture was made from, or name an object wrongly.
const FIXTURES = join(__dirname, '..', '..', 'test-fixtures', 'project-v2');

/** A copy of one of the fixture's projects. */
function copy(name: 'full' | 'after-bible'): string {
	const root = mkdtempSync(join(tmpdir(), 'pds-project-'));
	cpSync(join(FIXTURES, name), root, { recursive: true });
	return root;
}

test('every folder holding object.json is an object, with its shown file, its receipt, its text and its episode', async () => {
	const drama = await readProjectFromFolder(copy('full'));
	assert.deepEqual([...drama.objects.keys()].sort(), [
		'assets/characters/lin', 'assets/characters/lin/variants/rain', 'assets/props/umbrella', 'assets/scenes/office', 'assets/scenes/street', 'bible',
		'episodes/EP001', 'episodes/EP001/breakdown', 'episodes/EP001/keyframe/seg01/shot01', 'episodes/EP001/segments/seg01', 'episodes/EP001/segments/seg02', 'screenplay',
	]);
	const lin = drama.objects.get('assets/characters/lin')!;
	assert.deepEqual([lin.type, lin.name, lin.shownFile, lin.episode, lin.description, lin.prompt],
		['character', 'Lin', 'assets/characters/lin/look.png', null, 'A reporter, calm under pressure.\n', 'Lin, 30, grey wool coat\n']);
	assert.equal(lin.shownFileReceipt?.paidCallId, 'call-lin-look-0002');
	const take = drama.objects.get('episodes/EP001/segments/seg01')!;
	assert.deepEqual([take.episode, take.segment, take.shownFile], ['EP001', 'seg01', 'episodes/EP001/segments/seg01/take.mp4']);
	assert.deepEqual(take.objectsSentByDrawRequest, ['episodes/EP001/keyframe/seg01/shot01', 'assets/characters/lin'], 'what its draw request sends, in order');
	assert.equal(drama.objects.get('assets/scenes/office')!.shownFileReceipt, null, "the person's own picture has no receipt");
	assert.equal(drama.objects.get('assets/scenes/street')!.shownFile, null, 'a planned object shows nothing');
	assert.deepEqual(drama.objects.get('episodes/EP001/segments/seg02')!.objectsSentByDrawRequest, ['assets/characters/lin', 'assets/props/umbrella', 'assets/scenes/street'],
		'an undrawn object has the same list');
	assert.equal(drama.objects.get('assets/scenes/office')!.setting, 'interior');
});

test("the edges are each variant's derivation and the relations object.json states, between objects the project holds", async () => {
	const root = copy('full');
	// A relation to an object the project does not hold draws nothing.
	writeFileSync(join(root, 'assets/props/umbrella/object.json'), JSON.stringify({ schema: 2, type: 'prop', name: 'Umbrella', shown_file: 'picture.png',
		relations: [{ kind: 'appears_in', to: 'episodes/EP009' }] }));
	const drama = await readProjectFromFolder(root);
	assert.deepEqual(drama.edges.map(e => `${e.kind} ${e.from} → ${e.to}`).sort(), [
		'appears_in assets/characters/lin → episodes/EP001',
		'needs episodes/EP001 → assets/props/umbrella',
		'variant_of assets/characters/lin/variants/rain → assets/characters/lin',
	]);
});

test('a folder without object.json, or under a name starting with ".", is no object', async () => {
	const root = copy('after-bible');
	mkdirSync(join(root, 'assets/characters/lin/looks/face'), { recursive: true });
	writeFileSync(join(root, 'assets/characters/lin/looks/face/face.png'), 'x');
	mkdirSync(join(root, '.git/thing'), { recursive: true });
	writeFileSync(join(root, '.git/thing/object.json'), JSON.stringify({ schema: 2, type: 'prop', name: 'Hidden', shown_file: null }));
	const drama = await readProjectFromFolder(root);
	assert.deepEqual([...drama.objects.keys()].sort(), ['assets/characters/lin', 'assets/props/umbrella', 'assets/scenes/office', 'bible', 'episodes/EP001', 'screenplay']);
	assert.ok([...drama.objects.values()].filter(o => o.type === 'character' || o.type === 'scene' || o.type === 'prop').every(o => o.shownFile === null),
		'right after the bible every asset is planned');
});

test('an object is being made while Pine Computer\'s records hold a paid call for it under way, under either name of its ledger', async () => {
	const root = copy('after-bible');
	const ledger = (object: string, attempt: string, name: string, content: string) => {
		mkdirSync(join(root, 'pine-computer-records', object, attempt), { recursive: true });
		writeFileSync(join(root, 'pine-computer-records', object, attempt, name), content);
	};
	const call = (state: string) => JSON.stringify({ kind: 'image', state, estimate_usd: 0.04 });
	ledger('assets/characters/lin', '20261114T100000000000-0000000a', 'drama_cli_paid_call_ledger.json', call('running'));
	ledger('assets/scenes/office', '20261114T100000000000-0000000b', 'job.json', call('submitted'));
	// A sub-stage's call (its describe work) is its object's.
	ledger('screenplay/describe', '20261114T100000000000-00000010', 'drama_cli_paid_call_ledger.json', call('queued'));
	// A settled call; an older name beside a settled one of the new; gen create's hidden jobs; a ledger that is no JSON.
	ledger('assets/props/umbrella', '20261114T100000000000-0000000c', 'drama_cli_paid_call_ledger.json', call('downloaded'));
	ledger('assets/props/umbrella', '20261114T110000000000-0000000d', 'drama_cli_paid_call_ledger.json', call('succeeded'));
	ledger('assets/props/umbrella', '20261114T110000000000-0000000d', 'job.json', call('running'));
	ledger('.gen', '20261114T100000000000-0000000e', 'drama_cli_paid_call_ledger.json', call('running'));
	ledger('bible', '20261114T100000000000-0000000f', 'drama_cli_paid_call_ledger.json', 'not JSON');
	const drama = await readProjectFromFolder(root);
	assert.deepEqual([...drama.objects.values()].filter(o => o.makingNow).map(o => o.id).sort(), ['assets/characters/lin', 'assets/scenes/office', 'screenplay']);
});

test('Script lists the episodes under way, folds the ones not started into one row, and says so in plain words', async () => {
	const root = copy('full');
	for (const [id, name] of [['EP002', 'EP002 Second'], ['EP003', 'EP003 Third']]) {
		mkdirSync(join(root, 'episodes', id), { recursive: true });
		writeFileSync(join(root, 'episodes', id, 'object.json'), JSON.stringify({ schema: 2, type: 'episode', name, shown_file: null }));
	}
	const project = new DramaProject(root);
	const [script] = await project.children();
	const rows = await project.children(script);
	assert.deepEqual(rows.map(r => r.label), ['EP001 The Interview', '2 not started yet']);
	assert.deepEqual((await project.children(rows[1])).map(r => [r.label, r.episode]), [['EP002 Second', 'episodes/EP002'], ['EP003 Third', 'episodes/EP003']]);
	const drama = await project.drama();
	assert.equal(decomposition(drama, drama.objects.get('episodes/EP001/breakdown')).text, 'Takes shot', 'EP001 has a take: its furthest stage that shows a file');
	assert.equal(decomposition(drama, undefined).text, 'Not started');
	const object = (id: string, type: string, shown: string | null) => {
		mkdirSync(join(root, ...id.split('/')), { recursive: true });
		writeFileSync(join(root, ...id.split('/'), 'object.json'), JSON.stringify({ schema: 2, type, name: id, shown_file: shown }));
		if (shown) { writeFileSync(join(root, ...shown.split('/')), 'cut'); }
	};
	object('episodes/EP001/cut', 'cut', 'episodes/EP001/cut/cut.mp4');
	object('episodes/EP001/subtitles', 'subtitles', null);
	const edited = await readProjectFromFolder(root);
	assert.deepEqual(decomposition(edited, edited.objects.get('episodes/EP001/breakdown')), { text: 'Edited', decomposed: true }, 'the cut shows a file; the subtitles, planned, show none');
	assert.deepEqual((await project.locate('#script/episodes/EP003')).map(n => n.id), ['screenplay', '#script/later', '#script/episodes/EP003'], 'a folded episode is still found');
	// Its canvas and seg editor open from its row (Codex on B18): the row names its episode.
	const folded = (await project.children(rows[1]))[1];
	assert.equal(episodeOfNode(folded), 'EP003');
	assert.equal(episodeOfNode(rows[0]), 'EP001');
});

test("an object's name for the person: a variant after its asset, an episode's object after its episode", async () => {
	const drama = await readProjectFromFolder(copy('full'));
	assert.equal(objectTitle(drama, 'assets/characters/lin/variants/rain'), 'Lin · In the rain');
	assert.equal(objectTitle(drama, 'episodes/EP001/segments/seg02'), 'EP001 · seg02');
	assert.equal(objectTitle(drama, 'episodes/EP001'), 'EP001 The Interview');
	assert.equal(objectTitle(drama, 'assets/props/kettle'), 'kettle', 'an object the project does not hold, by its folder');
});

test('a document of another protocol major in the project is refused whole, an object or a receipt; a newer one with the Studio\'s update', async () => {
	const object = copy('full');
	writeFileSync(join(object, 'assets/props/umbrella/object.json'), JSON.stringify({ schema: 3, type: 'prop', name: 'Umbrella', shown_file: null }));
	await assert.rejects(readProjectFromFolder(object), (error: unknown) => error instanceof RefusedWithUpgradeInstructions && error.downloadUrl === STUDIO_RELEASES_URL
		&& /assets\/props\/umbrella\/object\.json is a document of protocol major 3, which this Studio does not read\. Update Pine Drama Studio/.test(error.message));
	const receipt = copy('full');
	writeFileSync(join(receipt, 'assets/props/umbrella/picture.png.receipt.json'), JSON.stringify({ schema: 1 }));
	await assert.rejects(readProjectFromFolder(receipt), (error: unknown) => error instanceof RefusedWithUpgradeInstructions && error.downloadUrl === undefined
		&& /picture\.png\.receipt\.json is a document of protocol major 1, which this Studio does not read$/.test(error.message));
});

test("a file's webview address changes when the file does, since a result overwrites it in place", async () => {
	const root = copy('full');
	const address = fileAddressByVersion(root, rel => `webview:${rel}`);
	const before = address('assets/characters/lin/look.png');
	writeFileSync(join(root, 'assets/characters/lin/look.png'), 'a new look, longer than the old one');
	assert.notEqual(address('assets/characters/lin/look.png'), before);
	assert.match(before, /^webview:assets\/characters\/lin\/look\.png\?v=\d+-\d+$/);
	assert.equal(address('assets/props/none.png'), 'webview:assets/props/none.png', 'a file not there has its plain address');
});

test('an object of a type the Studio does not know is kept as a plain card; a listed object the project lacks draws no line', async () => {
	const root = copy('full');
	mkdirSync(join(root, 'episodes/EP001/sound/seg01'), { recursive: true });
	writeFileSync(join(root, 'episodes/EP001/sound/seg01/sound.wav'), 'RIFF');
	writeFileSync(join(root, 'episodes/EP001/sound/seg01/object.json'), JSON.stringify({ schema: 2, type: 'sound', name: 'seg01 sound', shown_file: 'sound.wav',
		segment: 'seg01', objects_sent_by_draw_request: ['episodes/EP001/segments/seg01', 'assets/props/kettle', 'episodes/EP001/segments/seg01'] }));
	const drama = await readProjectFromFolder(root);
	assert.equal(drama.objects.get('episodes/EP001/sound/seg01')?.type, 'sound', 'kept, its type as written');
	const message = await lineageMessage({ root, episode: 'EP001', drama, layout: {}, focus: undefined, viewport: undefined, src: rel => rel });
	assert.ok(message.cards.filter(onBoard).some(c => c.id === 'episodes/EP001/sound/seg01'), 'its card is on its episode\'s board, a file it cannot draw too');
	assert.deepEqual(message.links.filter(l => l.to === 'episodes/EP001/sound/seg01').map(l => l.from), ['episodes/EP001/segments/seg01'], 'one line from an object sent twice, none from one the project lacks');
});
