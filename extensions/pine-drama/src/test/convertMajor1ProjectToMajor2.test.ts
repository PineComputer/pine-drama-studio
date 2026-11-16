import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { convertMajor1ProjectToMajor2 } from '../core/convertMajor1ProjectToMajor2';
import { RefusedWithUpgradeInstructions } from '../core/protocol';
import { git } from '../core/git';
import { readProjectMajor } from '../core/project';
import { listHistoryOfShownFile } from '../core/projectHistory';
import { dramaRecordOf, type Request } from '../core/major1';
import { sha256 } from '../core/sha256';

// A major-1 project as a Studio of major 1 left it (doc/protocol.md of major 1: choices.json, version folders with
// version.json, turns/ with each installed snapshot), converted by the table (protocol/v2/major1-to-major2-conversion.json).

const ANN = 'assets/characters/ann';
const RAIN = `${ANN}/variants/rain`;
const CUP = 'assets/props/cup';
const OLD = 'assets/props/old_lamp';
const SHOT = 'episodes/EP001/keyframe/seg01/shot01';
const HALL = 'assets/scenes/hall';
const OLD_BIBLE = 'bible';

const write = (root: string, path: string, value: unknown) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
};

/** One version folder: its shown file (artifact.json lists it), version.json, and job.json when it was a paid call. */
const version = (root: string, object: string, id: string, made: string, files: Record<string, string>, extra: { job?: boolean | string; inputs?: { object: string; version: string }[]; source?: unknown; shown?: string | null; author?: string } = {}) => {
	for (const [name, bytes] of Object.entries(files)) { write(root, `${object}/${id}/${name}`, bytes); }
	const outputs = Object.entries(files).map(([name, bytes]) => ({ path: `${object}/${id}/${name}`, sha256: sha256(bytes) }));
	write(root, `${object}/${id}/artifact.json`, { outputs, metadata: { ...extra.source ? { source: extra.source } : {}, ...extra.author ? { author: extra.author } : {} } });
	write(root, `${object}/${id}/version.json`, { schema: 1, made_at: made, file: extra.shown === undefined ? Object.keys(files)[0] : extra.shown, inputs: extra.inputs ?? [], prompt: 'a prompt', from_import: null });
	// `job`: the paid call's state (drama-cli's job.json `state`), downloaded when only `true`.
	if (extra.job) { write(root, `${object}/${id}/job.json`, { state: extra.job === true ? 'downloaded' : extra.job, attempt_id: `att-${object.split('/').at(-1)}-${id}`, actual_usd: 0.04, connection: 'pine', provider: 'byteplus' }); }
};

const snapshot = (observed: string, objects: Record<string, { type: string; name: string; segment?: string; inputs?: string[] }>, edges: unknown[] = []) => ({
	observed_at: observed, edges,
	objects: Object.fromEntries(Object.entries(objects).map(([id, o]) => [id, { segment: null, usable: true, from_add: null, ...o }])),
});
const turn = (root: string, task: string, at: string, snap: unknown) => write(root, `turns/${task}.json`, {
	schema: 1, task, scope: 'project', sent: at, installed: at, request: { versions: {}, choices: null }, versions: {}, reviews: {}, problems: [], snapshot: snap,
});

function majorOneProject(): { root: string; storage: string } {
	const parent = mkdtempSync(join(tmpdir(), 'pine-convert-'));
	const root = join(parent, 'drama');
	const storage = join(parent, 'storage');
	// Ann: v1 drawn, v2 drawn and then discarded by the person, so v1 is current (major 1's 3.2).
	version(root, ANN, 'v1', '2026-11-01T10:00:00Z', { 'image-1.jpg': 'ann one' }, { job: true });
	version(root, ANN, 'v2', '2026-11-01T11:00:00Z', { 'image-1.png': 'ann two' }, { job: true });
	version(root, `${ANN}/entry`, 'v1', '2026-11-01T09:00:00Z', {}, { shown: null, source: { kind: 'describe', call: `${ANN}/describe/v1` } });
	// Ann's face master, a picture of its own that no snapshot lists (pictures_that_become_objects).
	version(root, `${ANN}/looks/face`, 'v1', '2026-11-01T09:45:00Z', { 'image-1.png': 'ann face' }, { job: true });
	// A scene's front view, its own object; the scene's sheet version also holds a copy of it, which is not copied.
	version(root, `${HALL}/entry`, 'v1', '2026-11-01T09:00:00Z', {}, { shown: null });
	write(root, `${HALL}/entry/v1/entry.json`, { id: 'hall', name: 'Hall', description: 'A long hall.', setting: 'interior' });
	version(root, `${HALL}/views/front`, 'v1', '2026-11-01T09:50:00Z', { 'image-1.jpg': 'hall front' }, { job: true });
	version(root, HALL, 'v1', '2026-11-01T09:55:00Z', { 'image-1.jpg': 'hall sheet', 'front.jpg': 'hall front' });
	write(root, `${ANN}/entry/v1/entry.json`, { id: 'ann', name: 'Ann', appearance: 'Tall, in a grey coat.', look: 'A coat buttoned to the chin.', role: 'lead', appears_in: ['EP001'] });
	version(root, `${ANN}/describe`, 'v1', '2026-11-01T08:00:00Z', {}, { job: true, shown: null });
	version(root, `${ANN}/prompts`, 'v1', '2026-11-01T09:30:00Z', {}, { shown: null, author: 'person' });
	write(root, `${ANN}/prompts/v1/prompt.json`, { text: 'Ann, full body, grey coat' });
	// A keyframe's prompt the person wrote, and another's from the template (major 1's prompts.py: author agent): neither is carried.
	version(root, `${SHOT}/prompts`, 'v1', '2026-11-02T09:00:00Z', {}, { shown: null, author: 'person' });
	write(root, `${SHOT}/prompts/v1/prompt.json`, { text: 'Image 1 is Ann. She turns.' });
	version(root, 'episodes/EP001/keyframe/seg01/shot02/prompts', 'v1', '2026-11-02T09:00:00Z', {}, { shown: null, author: 'agent' });
	write(root, 'episodes/EP001/keyframe/seg01/shot02/prompts/v1/prompt.json', { text: 'Shot 2, from the template.' });
	// A prop with printed words.
	version(root, 'assets/props/sign/entry', 'v1', '2026-11-01T09:00:00Z', {}, { shown: null });
	write(root, 'assets/props/sign/entry/v1/entry.json', { id: 'sign', name: 'Sign', description: 'A shop sign.', text: 'OPEN' });
	version(root, `${RAIN}/entry`, 'v1', '2026-11-01T09:00:00Z', {}, { shown: null });
	write(root, `${RAIN}/entry/v1/entry.json`, { id: 'rain', name: 'Ann in the rain', text: 'Wet hair.', from: 'base' });
	// The keyframe is drawn from Ann's current picture: its receipt names it at its major-2 path.
	version(root, SHOT, 'v1', '2026-11-02T10:00:00Z', { 'image-1.jpg': 'shot' }, { job: true, inputs: [{ object: ANN, version: 'v1' }] });
	version(root, CUP, 'v1', '2026-11-01T12:00:00Z', { 'image-1.jpg': 'cup' }, { job: true });
	version(root, OLD, 'v1', '2026-11-01T12:30:00Z', { 'image-1.jpg': 'lamp' }, { job: true });
	version(root, 'assets/index', 'v1', '2026-11-01T09:00:00Z', { 'index.json': '{}' });
	version(root, OLD_BIBLE, 'v1', '2026-11-01T07:00:00Z', { 'bible.md': 'as written' }, { job: true });
	// The person renamed Shot 2's picture by hand: its version lists a file the folder no longer holds.
	version(root, 'episodes/EP001/keyframe/seg01/shot02', 'v1', '2026-11-02T11:00:00Z', { 'image-1.jpg': 'shot two' }, { job: true });
	rmSync(join(root, 'episodes/EP001/keyframe/seg01/shot02/v1/image-1.jpg'));
	write(root, 'episodes/EP001/keyframe/seg01/shot02/v1/shot two.jpg', 'shot two');
	write(root, `${OLD_BIBLE}/v1/bible.md`, 'edited by hand');
	write(root, 'config/v1/drama-cli.cfg.yaml', 'budget_usd: 1\n');
	write(root, 'config/v2/drama-cli.cfg.yaml', 'budget_usd: null\n');
	write(root, 'imports/imp-1.jpg', 'imported');
	write(root, 'inputs/screenplay.fountain', 'INT. ROOM - DAY\n');
	write(root, 'understanding/image-cast-1/job.json', { attempt_id: 'u1' });
	write(root, 'choices.json', { schema: 1, objects: { [ANN]: { discarded: ['v2'], description: 'Tall, in a long grey coat.' }, [CUP]: { removed: true } }, added: [], imports: [] });
	const all = {
		[ANN]: { type: 'character', name: 'Ann' }, [RAIN]: { type: 'variant', name: 'Ann in the rain' }, [CUP]: { type: 'prop', name: 'Cup' },
		'episodes/EP001': { type: 'episode', name: 'Episode 1' }, [SHOT]: { type: 'keyframe', name: 'Shot 1', segment: 'seg01' },
		'episodes/EP001/keyframe/seg01/shot02': { type: 'keyframe', name: 'Shot 2', segment: 'seg01' }, 'episodes/EP002': { type: 'episode', name: 'Episode 2' },
		'episodes/EP002/keyframe/seg01/shot01': { type: 'keyframe', name: 'Shot 1', segment: 'seg01', inputs: [ANN, CUP] },
	};
	turn(root, 'task-1', '2026-11-01T13:00:00Z', snapshot('2026-11-01T13:00:00Z', { ...all, [OLD]: { type: 'prop', name: 'Old lamp' } }));
	// A later Project Chat turn no longer lists the old lamp: major 1 showed it removed (its 5.3).
	turn(root, 'task-2', '2026-11-02T13:00:00Z', snapshot('2026-11-02T13:00:00Z', all, [{ from: RAIN, to: ANN, kind: 'variant_of' }]));
	return { root, storage };
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const readJson = (root: string, path: string) => JSON.parse(read(root, path));
const out = async (dir: string, ...args: string[]) => {
	const result = await git(args, dir);
	assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
};

test('a major-1 project becomes major 2 by the table: backed up, each object at its major-1 current, and one commit', async () => {
	const { root, storage } = majorOneProject();
	const { backup } = await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');

	assert.equal(backup, `${root}.backup-2026-11-14`);
	assert.ok(existsSync(join(backup, 'choices.json')) && existsSync(join(backup, ANN, 'v2', 'image-1.png')), 'the backup is the folder as it was');
	assert.equal(readProjectMajor(root), 2);
	for (const gone of ['choices.json', 'turns', 'imports', 'understanding', 'config', 'assets/index', `${ANN}/v1`, `${ANN}/entry`, `${ANN}/prompts`, `${ANN}/describe`]) {
		assert.ok(!existsSync(join(root, gone)), `${gone} is gone`);
	}
	assert.equal(read(root, 'inputs/screenplay.fountain'), 'INT. ROOM - DAY\n', 'inputs/ is kept as it is');
	assert.equal(read(root, `${OLD_BIBLE}/bible.md`), 'edited by hand', 'a file edited by hand after it was made is carried as the person left it');
	assert.ok(!existsSync(join(root, 'episodes/EP001/keyframe/seg01/shot02/image-1.jpg')), 'a picture the person renamed is not there to copy');
	assert.equal(read(backup, 'episodes/EP001/keyframe/seg01/shot02/v1/shot two.jpg'), 'shot two', 'its new name stays in the backup');
	assert.equal(read(root, 'drama-cli.cfg.yaml'), 'budget_usd: null\n', 'the newest config at the root');

	// Ann is at v1 (v2 was discarded): its file, its receipt, and v2's file gone.
	assert.equal(read(root, `${ANN}/image-1.jpg`), 'ann one');
	assert.ok(!existsSync(join(root, `${ANN}/image-1.png`)) && !existsSync(join(root, `${ANN}/image-1.png.receipt.json`)));
	assert.deepEqual(readJson(root, `${ANN}/image-1.jpg.receipt.json`), {
		schema: 2, paid_call_id: 'att-ann-v1', finished_at: '2026-11-01T10:00:00Z', inputs_sent_in_order: [], prompt_sent: 'a prompt', cost: { usd: 0.04, reported_by: 'pine' },
	});
	assert.deepEqual(readJson(root, `${SHOT}/image-1.jpg.receipt.json`).inputs_sent_in_order, [{ path: `${ANN}/image-1.jpg`, sha256: sha256('ann one') }]);
	// The entry is split into the object's files; the person's pending description wins, and the outfit joins it. Every
	// prompt is composed when drawn, so no stored prompt is carried, the person's neither (the backup keeps them).
	assert.equal(read(root, `${ANN}/description.md`), 'Tall, in a long grey coat.\n\nOutfit: A coat buttoned to the chin.\n');
	assert.deepEqual(readJson(root, `${ANN}/entry.json`), { role: 'lead' });
	for (const card of [ANN, SHOT, 'episodes/EP001/keyframe/seg01/shot02']) {
		assert.ok(!existsSync(join(root, card, 'prompt.md')) && !existsSync(join(root, card, 'prompts')), `${card} carries no stored prompt`);
	}
	assert.equal(read(backup, `${SHOT}/prompts/v1/prompt.json`), JSON.stringify({ text: 'Image 1 is Ann. She turns.' }), 'the backup keeps it');
	assert.deepEqual([read(root, 'assets/props/sign/description.md'), readJson(root, 'assets/props/sign/entry.json')], ['A shop sign.\n\nIt shows the words "OPEN".\n', {}],
		"a prop's printed words join its description");
	assert.equal(readJson(root, `${ANN}/description.md.receipt.json`).paid_call_id, 'att-describe-v1', 'the describe call the entry was written from');
	assert.deepEqual(readJson(root, `${ANN}/object.json`), { schema: 2, type: 'character', name: 'Ann', relations: [{ kind: 'appears_in', to: 'episodes/EP001' }], shown_file: 'image-1.jpg' });
	assert.deepEqual(readJson(root, `${ANN}/looks/face/object.json`), { schema: 2, type: 'character_face', name: 'Ann face', shown_file: 'image-1.png' },
		"a picture that becomes an object, named after its owner's object.json name");
	assert.deepEqual(readJson(root, `${HALL}/views/front/object.json`), { schema: 2, type: 'scene_view', name: 'Hall front view', shown_file: 'image-1.jpg' }, 'a view, named after its scene and its side');
	assert.equal(readJson(root, `${HALL}/object.json`).shown_file, 'image-1.jpg', 'the scene shows its composed sheet');
	assert.ok(!existsSync(join(root, `${HALL}/front.jpg`)), "the scene's copy of a view is not copied: the view holds it");
	assert.deepEqual(readJson(root, `${RAIN}/object.json`), { schema: 2, type: 'variant', name: 'Ann in the rain', variant_of: ANN, relations: [], shown_file: null });
	assert.equal(read(root, `${RAIN}/description.md`), 'Wet hair.');
	// A planned object the snapshot lists is an empty card; one with versions shows its current file.
	assert.deepEqual(readJson(root, 'episodes/EP002/object.json'), { schema: 2, type: 'episode', name: 'Episode 2', relations: [], shown_file: null });
	assert.deepEqual(readJson(root, 'episodes/EP001/keyframe/seg01/shot02/object.json'), { schema: 2, type: 'keyframe', name: 'Shot 2', relations: [], segment: 'seg01', shown_file: null }, 'its shown file is not there');
	assert.equal(readJson(root, `${SHOT}/object.json`).shown_file, 'image-1.jpg');
	assert.deepEqual(readJson(root, `${SHOT}/object.json`).objects_sent_by_draw_request, [ANN], 'the pictures its draw sent');
	assert.deepEqual(readJson(root, 'episodes/EP002/keyframe/seg01/shot01/object.json').objects_sent_by_draw_request, [ANN, CUP], "a planned card's snapshot inputs");
	// Removed by the person, and no longer listed by a later snapshot of its scope: deleted, and kept in the backup.
	assert.ok(!existsSync(join(root, CUP)) && !existsSync(join(root, OLD)));
	assert.equal(read(backup, `${CUP}/v1/image-1.jpg`), 'cup');

	// History: one commit of the converted folder; earlier versions are in the backup only.
	assert.deepEqual((await out(root, 'log', '--format=%an|%s')).split('\n'), ['client-found-changes-on-disk|Converted from major 1']);
	assert.equal(await out(root, 'status', '--porcelain'), '', 'the commit holds the folder as converted');
	assert.equal(read(backup, `${ANN}/v2/image-1.png`), 'ann two', "v2's picture is in the backup");
	assert.deepEqual((await listHistoryOfShownFile(root, ANN)).map(r => [r.file, r.shown]), [[`${ANN}/image-1.jpg`, true]], 'the strip offers the current result only');
});

test("drama-cli's major-1 records go wherever they are, and a folder that already was a repository ends clean", async () => {
	const { root, storage } = majorOneProject();
	write(root, 'episodes/EP001/understanding/image-keyframe-1/job.json', { attempt_id: 'u2', state: 'downloaded' });
	write(root, 'episodes/EP001/asset-library/a1/asset.json', { id: 'asset-1' });
	write(root, `${RAIN}/understanding/image-variant-1/reply.json`, {});
	await out(root, 'init', '-q');
	await out(root, '-c', 'user.name=person', '-c', 'user.email=person@localhost', 'add', '-A');
	await out(root, '-c', 'user.name=person', '-c', 'user.email=person@localhost', 'commit', '-q', '-m', 'the person\'s own');
	const { backup } = await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	for (const gone of ['understanding', 'episodes/EP001/understanding', 'episodes/EP001/asset-library', `${RAIN}/understanding`]) {
		assert.ok(!existsSync(join(root, gone)) && existsSync(join(backup, gone)), `${gone} is gone, and in the backup`);
	}
	assert.equal(await out(root, 'status', '--porcelain'), '', 'what the conversion removed is committed removed');
	assert.equal(await out(root, 'ls-tree', '--name-only', 'HEAD', '--', 'choices.json', 'turns'), '');
});

test("a description's receipt is the describe call its entry names, though a later describe was made", async () => {
	const { root, storage } = majorOneProject();
	version(root, `${ANN}/describe`, 'v2', '2026-11-01T08:30:00Z', {}, { job: true, shown: null });
	await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.equal(readJson(root, `${ANN}/description.md.receipt.json`).paid_call_id, 'att-describe-v1');
});

test('a 0.2.6 turn with no return and paid calls not settled are converted as found and named; settled ones are not', async () => {
	const { root, storage } = majorOneProject();
	// A request a Studio of major 1 sent and dealt with no return of (major1.ts, DramaRecord.sentTask), and one the folder's turns/ holds.
	for (const task of ['task-3', 'task-1']) {
		const sent = dramaRecordOf(join(storage, 'protocol'), root).requestPath(task);
		mkdirSync(dirname(sent), { recursive: true });
		writeFileSync(sent, JSON.stringify({ sent: '2026-11-13T10:00:00Z', computer: 'computer', chat: 'chat', request: { turn: task } as Request }));
	}
	// A take still running at its provider and a picture whose outcome is unknown; settled ones: not charged, and counted as charged with its output gone.
	version(root, 'episodes/EP001/segments/seg01', 't01', '2026-11-02T10:00:00Z', { 'take.mp4': 'take' }, { job: 'running' });
	version(root, CUP, 'v9', '2026-11-02T11:00:00Z', { 'image-1.png': 'cup' }, { job: 'unknown' });
	version(root, CUP, 'v8', '2026-11-02T09:00:00Z', { 'image-1.png': 'cup refused' }, { job: 'rejected' });
	version(root, CUP, 'v7', '2026-11-02T08:00:00Z', { 'image-1.png': 'cup lost' }, { job: 'lost' });
	const { backup, unsettled } = await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.deepStrictEqual([...unsettled].sort(), ['episodes/EP001/segments/seg01/t01 (running)', `${CUP}/v9 (unknown)`, 'turn task-3'].sort());
	assert.ok(readProjectMajor(root) === 2 && existsSync(join(backup, CUP, 'v9')));
});

test('a folder with no snapshot to give its objects refuses the conversion; a backup name already taken gives the next free one', async () => {
	const { root, storage } = majorOneProject();
	writeFileSync(join(root, 'turns/task-1.json'), JSON.stringify({ ...readJson(root, 'turns/task-1.json'), snapshot: null }));
	writeFileSync(join(root, 'turns/task-2.json'), JSON.stringify({ ...readJson(root, 'turns/task-2.json'), snapshot: null }));
	await assert.rejects(convertMajor1ProjectToMajor2(root, storage, '2026-11-14'), (error: unknown) => error instanceof RefusedWithUpgradeInstructions && /no record of its turns/.test(error.message));
	assert.ok(!existsSync(join(root, '.git')) && !existsSync(`${root}.backup-2026-11-14`));
	const other = majorOneProject();
	mkdirSync(`${other.root}.backup-2026-11-14`);
	const { backup } = await convertMajor1ProjectToMajor2(other.root, other.storage, '2026-11-14');
	assert.ok(backup === `${other.root}.backup-2026-11-14-2` && readProjectMajor(other.root) === 2 && existsSync(join(backup, 'choices.json')));
});

test('an object whose every version was discarded keeps none of their files: its card is empty, and the backup keeps them', async () => {
	const { root, storage } = majorOneProject();
	const choices = readJson(root, 'choices.json');
	choices.objects[SHOT] = { discarded: ['v1'] };
	writeFileSync(join(root, 'choices.json'), JSON.stringify(choices));
	const { backup } = await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.ok(!existsSync(join(root, `${SHOT}/image-1.jpg`)) && !existsSync(join(root, `${SHOT}/image-1.jpg.receipt.json`)));
	assert.equal(readJson(root, `${SHOT}/object.json`).shown_file, null);
	assert.equal(read(backup, `${SHOT}/v1/image-1.jpg`), 'shot');
});

test('a removed variant takes the variants derived from it; the folder\'s own turns are the only snapshots read when it has them', async () => {
	const { root, storage } = majorOneProject();
	const STORM = `${ANN}/variants/storm`;
	version(root, `${STORM}/entry`, 'v1', '2026-11-01T09:10:00Z', {}, { shown: null });
	write(root, `${STORM}/entry/v1/entry.json`, { id: 'storm', name: 'Ann in the storm', text: 'Soaked.', from: 'rain' });
	const last = readJson(root, 'turns/task-2.json');
	last.snapshot.objects[STORM] = { type: 'variant', name: 'Ann in the storm', segment: null, usable: true, from_add: null };
	last.snapshot.edges.push({ from: STORM, to: RAIN, kind: 'variant_of' });
	writeFileSync(join(root, 'turns/task-2.json'), JSON.stringify(last));
	const choices = readJson(root, 'choices.json');
	choices.objects[RAIN] = { removed: true, prompt: 'never drawn' };
	// The person's pending text for a card no snapshot lists any more, which never had a folder: no object, so no text.
	choices.objects['episodes/EP009/keyframe/seg01/shot01'] = { prompt: 'gone' };
	writeFileSync(join(root, 'choices.json'), JSON.stringify(choices));
	// A return this profile kept that the folder's turns/ does not hold: not read, since the folder has its own turns.
	const record = dramaRecordOf(join(storage, 'protocol'), root);
	write(record.dir, 'returns/task-9.json', { task: 'task-9', scope: 'project', chat: 'c', sent: '2026-11-03T00:00:00Z', installed: '2026-11-03T00:00:00Z', versions: {}, reviews: {}, private_state: null, problems: [],
		snapshot: snapshot('2026-11-03T00:00:00Z', { 'assets/props/kept_elsewhere': { type: 'prop', name: 'Kept elsewhere' } }) });
	await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.ok(!existsSync(join(root, RAIN)) && !existsSync(join(root, STORM)), 'rain and the storm derived from it');
	assert.ok(existsSync(join(root, `${ANN}/object.json`)), 'Ann stays');
	assert.ok(!existsSync(join(root, 'assets/props/kept_elsewhere')), 'no object from a snapshot the folder does not hold');
	assert.ok(!existsSync(join(root, 'episodes/EP009')), 'no folder for pending text of no object');
});

test("a .gitignore of the folder's keeps nothing the conversion wrote out of its commit", async () => {
	const { root, storage } = majorOneProject();
	write(root, '.gitignore', '*.jpg\nobject.json\n');
	await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.equal(JSON.parse(await out(root, 'show', `HEAD:${ANN}/object.json`)).name, 'Ann');
	assert.equal(await out(root, 'show', `HEAD:${ANN}/image-1.jpg`), 'ann one');
});
