import { strict as assert } from 'node:assert';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCardAction, unchangedLine, type EntryAsk } from '../core/entryActions';
import { git } from '../core/git';
import { readProjectFromFolder } from '../core/project';
import { commitFilesFoundOnDisk, listHistoryOfShownFile } from '../core/projectHistory';

// A card action is the person's change to the project's files, committed as theirs at the click (doc/protocol.md
// section 3), on the major-2 fixture (test-fixtures/project-v2/full).
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'project-v2', 'full');
const never: EntryAsk = { description: () => Promise.reject(new Error('not asked')), file: () => Promise.reject(new Error('not asked')) };
const project = async () => {
	const root = await mkdtemp(join(tmpdir(), 'cards-'));
	await cp(FIXTURE, root, { recursive: true });
	return root;
};
const lastCommit = async (root: string) => (await git(['log', '-1', '--format=%an|%s', '--name-only'], root)).stdout.trim().split('\n').filter(Boolean);
const LIN = 'assets/characters/lin';

test('a description or a prompt is written to its file as the person\'s commit; the same text again changes nothing and says so', async () => {
	const root = await project();
	assert.deepEqual(await runCardAction(root, { action: 'describe', object: LIN, description: '', text: 'A reporter in the rain.' }, never), { already: false });
	assert.equal(await readFile(join(root, LIN, 'description.md'), 'utf8'), 'A reporter in the rain.');
	assert.deepEqual(await lastCommit(root), ['person|Description of assets/characters/lin', `${LIN}/description.md`]);
	assert.deepEqual(await runCardAction(root, { action: 'describe', object: LIN, description: '', text: 'A reporter in the rain.' }, never), { already: true });
	await runCardAction(root, { action: 'prompt', object: 'episodes/EP001/segments/seg02', text: 'Lin opens the umbrella.' }, never);
	assert.equal((await readProjectFromFolder(root)).objects.get('episodes/EP001/segments/seg02')!.prompt, 'Lin opens the umbrella.');
	assert.equal(await runCardAction(root, { action: 'describe', object: LIN, description: 'x' }, { ...never, description: () => Promise.resolve(undefined) }), undefined);
	assert.equal(unchangedLine(undefined), 'Cancelled: nothing was changed.');
});

test('an asset or a variant the person adds is a folder with object.json and description.md at once; removing one deletes its folder', async () => {
	const root = await project();
	await runCardAction(root, { action: 'add', type: 'prop', name: 'Red Kettle', text: 'An enamel kettle.' }, never);
	await runCardAction(root, { action: 'add', type: 'variant', name: 'At night', text: 'Lin under the streetlights.', from: LIN }, never);
	await runCardAction(root, { action: 'add', type: 'scene', name: '花园', text: 'A garden.', setting: 'exterior' }, never);
	const drama = await readProjectFromFolder(root);
	const kettle = drama.objects.get('assets/props/red-kettle')!;
	assert.deepEqual([kettle.type, kettle.name, kettle.shownFile, kettle.description], ['prop', 'Red Kettle', null, 'An enamel kettle.']);
	const night = drama.objects.get(`${LIN}/variants/at-night`)!;
	assert.deepEqual([night.variantOf, night.objectsSentByDrawRequest], [LIN, [LIN]], 'a variant is drawn from its base');
	assert.equal(drama.objects.get('assets/scenes/花园')?.setting, 'exterior', 'a name in any script keeps its letters');
	await Promise.all(['A second one.', 'A third one.'].map(text => runCardAction(root, { action: 'add', type: 'prop', name: 'Red Kettle', text }, never)));
	assert.deepEqual(['red-kettle-2', 'red-kettle-3'].map(id => existsSync(join(root, 'assets/props', id, 'object.json'))), [true, true],
		'a taken name gets a number, named as the folder is when each lands');
	await mkdir(join(root, 'assets/props/Lamp'));
	await runCardAction(root, { action: 'add', type: 'prop', name: 'lamp', text: 'A lamp.' }, never);
	assert.ok(existsSync(join(root, 'assets/props/lamp-2/object.json')), 'a name taken in another case is taken (doc/protocol.md section 1)');
	await runCardAction(root, { action: 'remove', object: LIN }, never);
	assert.equal(existsSync(join(root, LIN)), false, 'its folder, its variants with it');
	assert.equal((await lastCommit(root))[0], 'person|Removed assets/characters/lin');
	assert.deepEqual(await runCardAction(root, { action: 'remove', object: LIN }, never), { already: true });
	// A name that is no path of the project (doc/protocol.md section 1) writes nothing.
	await assert.rejects(runCardAction(root, { action: 'add', type: 'prop', name: 'CON', text: 'x' }, never), /not a path of the project/);
	assert.equal(existsSync(join(root, 'assets/props/con')), false);
});

test("the person's own picture replaces the shown file, under its name with their file's extension; the old file and its receipt go", async () => {
	const root = await project();
	const mine = join(await mkdtemp(join(tmpdir(), 'mine-')), 'my umbrella.JPG');
	await writeFile(mine, 'jpeg bytes');
	await runCardAction(root, { action: 'import', object: 'assets/props/umbrella', file: mine }, never);
	const umbrella = (await readProjectFromFolder(root)).objects.get('assets/props/umbrella')!;
	assert.deepEqual([umbrella.shownFile, umbrella.shownFileReceipt], ['assets/props/umbrella/picture.jpg', null]);
	assert.equal(await readFile(join(root, 'assets/props/umbrella/picture.jpg'), 'utf8'), 'jpeg bytes');
	assert.equal(existsSync(join(root, 'assets/props/umbrella/picture.png')), false);
	assert.equal(existsSync(join(root, 'assets/props/umbrella/picture.png.receipt.json')), false);
	// A planned object gets one too.
	await runCardAction(root, { action: 'import', object: 'assets/scenes/street', file: mine }, never);
	assert.equal((await readProjectFromFolder(root)).objects.get('assets/scenes/street')!.shownFile, 'assets/scenes/street/picture.jpg');
	assert.equal(await runCardAction(root, { action: 'import', object: 'assets/props/umbrella', file: null }, { ...never, file: () => Promise.resolve(undefined) }), undefined);
});

test('the shown file itself, picked as the person\'s own, keeps its bytes and loses its receipt; the commit holds exactly what changed', async () => {
	const root = await project();
	const shown = join(root, 'assets/props/umbrella/picture.png');
	const bytes = await readFile(shown);
	await commitFilesFoundOnDisk(root, 'The project as found');
	await writeFile(join(root, 'inputs-by-hand.md'), 'a hand edit elsewhere');
	assert.deepEqual(await runCardAction(root, { action: 'import', object: 'assets/props/umbrella', file: shown }, never), { already: false });
	assert.deepEqual(await readFile(shown), bytes);
	assert.equal(existsSync(`${shown}.receipt.json`), false);
	assert.deepEqual((await lastCommit(root)).slice(1), ['assets/props/umbrella/picture.png.receipt.json'],
		'its object.json names the same file, and the hand edit is not the person\'s card change');
});

test('Use brings an earlier result back whole, its receipt with it, as the person\'s commit; history keeps the one it replaced', async () => {
	const root = await project();
	const look = `${LIN}/look.png`;
	await commitFilesFoundOnDisk(root, 'The project as found');
	const [first] = await listHistoryOfShownFile(root, LIN);
	await writeFile(join(root, look), 'a redraw');
	await writeFile(join(root, `${look}.receipt.json`), JSON.stringify({ schema: 2, paid_call_id: 'call-lin-look-0003', finished_at: '2026-11-13T10:00:00Z', inputs_sent_in_order: [], prompt_sent: null, cost: null }));
	await git(['add', '-A'], root);
	await git(['-c', 'user.name=pine-computer', '-c', 'user.email=p@x', 'commit', '-q', '-m', 'a redraw'], root);
	assert.deepEqual(await runCardAction(root, { action: 'use', object: LIN, commit: first.commit }, never), { already: false });
	const lin = (await readProjectFromFolder(root)).objects.get(LIN)!;
	assert.equal(lin.shownFileReceipt?.paidCallId, 'call-lin-look-0002', 'the receipt of the result brought back');
	assert.notEqual(await readFile(join(root, look), 'utf8'), 'a redraw');
	assert.equal((await lastCommit(root))[0], `person|Used an earlier result of ${LIN}`);
	assert.deepEqual((await listHistoryOfShownFile(root, LIN)).map(h => [h.commit === first.commit, h.shown]), [[false, false], [true, true]],
		'the redraw stays in history, and Main is the result brought back');
	assert.deepEqual((await git(['show', '--name-only', '--format=', 'HEAD'], root)).stdout.trim().split('\n').sort(), [look, `${look}.receipt.json`],
		'only this card\'s files come back from a commit that held the whole project');});

test("after the person's own file changed the extension, Use of an earlier result shows it again, and leaves the object's variants as they are", async () => {
	const root = await project();
	const umbrella = 'assets/props/umbrella';
	await commitFilesFoundOnDisk(root, 'The project as found');
	const rain = join(root, LIN, 'variants/rain/description.md');
	const mine = join(await mkdtemp(join(tmpdir(), 'mine-')), 'mine.jpg');
	await writeFile(mine, 'jpeg bytes');
	await runCardAction(root, { action: 'import', object: umbrella, file: mine }, never);
	const history = await listHistoryOfShownFile(root, umbrella);
	assert.deepEqual(history.map(h => [h.file, h.author]), [[`${umbrella}/picture.jpg`, 'person'], [`${umbrella}/picture.png`, 'client-found-changes-on-disk']],
		'the strip keeps the results under the name before');
	await runCardAction(root, { action: 'use', object: umbrella, commit: history[1].commit }, never);
	const shown = (await readProjectFromFolder(root)).objects.get(umbrella)!;
	assert.deepEqual([shown.shownFile, shown.shownFileReceipt?.paidCallId], [`${umbrella}/picture.png`, 'call-umbrella-0001']);
	assert.equal(existsSync(join(root, umbrella, 'picture.jpg')), false);
	// A variant is an object of its own: Use of its asset's result leaves it, though the same commit wrote it.
	await writeFile(rain, 'Rain, redrawn later.');
	const [found] = (await listHistoryOfShownFile(root, LIN)).slice(-1);
	await runCardAction(root, { action: 'use', object: LIN, commit: found.commit }, never);
	assert.equal(await readFile(rain, 'utf8'), 'Rain, redrawn later.');
});

test("Use of the person's own picture after a paid redraw of the same file brings it back with no receipt", async () => {
	const root = await project();
	const street = 'assets/scenes/street';
	const mine = join(await mkdtemp(join(tmpdir(), 'mine-')), 'mine.png');
	await writeFile(mine, 'my street');
	await runCardAction(root, { action: 'import', object: street, file: mine }, never);
	const [own] = await listHistoryOfShownFile(root, street);
	await writeFile(join(root, street, 'picture.png'), 'a paid redraw');
	await writeFile(join(root, street, 'picture.png.receipt.json'), JSON.stringify({ schema: 2, paid_call_id: 'call-street-0001', finished_at: '2026-11-13T10:00:00Z', inputs_sent_in_order: [], prompt_sent: null, cost: null }));
	await git(['add', '-A'], root);
	await git(['-c', 'user.name=pine-computer', '-c', 'user.email=p@x', 'commit', '-q', '-m', 'a redraw'], root);
	await runCardAction(root, { action: 'use', object: street, commit: own.commit }, never);
	const shown = (await readProjectFromFolder(root)).objects.get(street)!;
	assert.deepEqual([await readFile(join(root, street, 'picture.png'), 'utf8'), shown.shownFileReceipt], ['my street', null]);
});
