import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { convertMajor1ProjectToMajor2, LAST_MAJOR_1_STUDIO, major1ConversionPending, RefusedWithUpgradeInstructions } from '../core/convertMajor1ProjectToMajor2';
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
const OLD_BIBLE = 'bible';

const write = (root: string, path: string, value: unknown) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
};

/** One version folder: its shown file (artifact.json lists it), version.json, and job.json when it was a paid call. */
const version = (root: string, object: string, id: string, made: string, files: Record<string, string>, extra: { job?: boolean; inputs?: { object: string; version: string }[]; source?: unknown; shown?: string | null } = {}) => {
	for (const [name, bytes] of Object.entries(files)) { write(root, `${object}/${id}/${name}`, bytes); }
	const outputs = Object.entries(files).map(([name, bytes]) => ({ path: `${object}/${id}/${name}`, sha256: sha256(bytes) }));
	write(root, `${object}/${id}/artifact.json`, { outputs, metadata: extra.source ? { source: extra.source } : {} });
	write(root, `${object}/${id}/version.json`, { schema: 1, made_at: made, file: extra.shown === undefined ? Object.keys(files)[0] : extra.shown, inputs: extra.inputs ?? [], prompt: 'a prompt', from_import: null });
	if (extra.job) { write(root, `${object}/${id}/job.json`, { attempt_id: `att-${object.split('/').at(-1)}-${id}`, actual_usd: 0.04, connection: 'pine', provider: 'byteplus' }); }
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
	write(root, `${ANN}/entry/v1/entry.json`, { id: 'ann', name: 'Ann', appearance: 'Tall, in a grey coat.', role: 'lead', appears_in: ['EP001'] });
	version(root, `${ANN}/describe`, 'v1', '2026-11-01T08:00:00Z', {}, { job: true, shown: null });
	version(root, `${ANN}/prompts`, 'v1', '2026-11-01T09:30:00Z', {}, { shown: null });
	write(root, `${ANN}/prompts/v1/prompt.json`, { text: 'Ann, full body, grey coat' });
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

test('a major-1 project becomes major 2 by the table: backed up, one commit per version, each object at its major-1 current, the marker last', async () => {
	const { root, storage } = majorOneProject();
	const backup = await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');

	assert.equal(backup, `${root}.backup-2026-11-14`);
	assert.ok(existsSync(join(backup, 'choices.json')) && existsSync(join(backup, ANN, 'v2', 'image-1.png')), 'the backup is the folder as it was');
	assert.equal(readProjectMajor(root), 2);
	for (const gone of ['choices.json', 'turns', 'imports', 'understanding', 'config', 'assets/index', `${ANN}/v1`, `${ANN}/entry`, `${ANN}/prompts`, `${ANN}/describe`]) {
		assert.ok(!existsSync(join(root, gone)), `${gone} is gone`);
	}
	assert.equal(read(root, 'inputs/screenplay.fountain'), 'INT. ROOM - DAY\n', 'inputs/ is kept as it is');
	assert.equal(read(root, `${OLD_BIBLE}/bible.md`), 'edited by hand', 'a file edited by hand after it was made is carried as the person left it');
	assert.ok(!existsSync(join(root, 'episodes/EP001/keyframe/seg01/shot02/image-1.jpg')), 'a picture the person renamed is not there to copy');
	assert.equal(await out(root, 'show', `${await out(root, 'rev-list', '--max-parents=0', 'HEAD')}:episodes/EP001/keyframe/seg01/shot02/v1/shot two.jpg`), 'shot two', 'its new name stays in the commit of the folder as found');
	assert.equal(read(root, 'drama-cli.cfg.yaml'), 'budget_usd: null\n', 'the newest config at the root');

	// Ann is at v1 (v2 was discarded): its file, its receipt, and v2's file gone.
	assert.equal(read(root, `${ANN}/image-1.jpg`), 'ann one');
	assert.ok(!existsSync(join(root, `${ANN}/image-1.png`)) && !existsSync(join(root, `${ANN}/image-1.png.receipt.json`)));
	assert.deepEqual(readJson(root, `${ANN}/image-1.jpg.receipt.json`), {
		schema: 2, paid_call_id: 'att-ann-v1', finished_at: '2026-11-01T10:00:00Z', inputs_sent_in_order: [], prompt_sent: 'a prompt', cost: { usd: 0.04, reported_by: 'pine' },
	});
	assert.deepEqual(readJson(root, `${SHOT}/image-1.jpg.receipt.json`).inputs_sent_in_order, [{ path: `${ANN}/image-1.jpg`, sha256: sha256('ann one') }]);
	// The entry is split into the object's files; the person's pending description wins; the prompt is prompt.md.
	assert.equal(read(root, `${ANN}/description.md`), 'Tall, in a long grey coat.');
	assert.deepEqual(readJson(root, `${ANN}/entry.json`), { role: 'lead' });
	assert.equal(read(root, `${ANN}/prompt.md`), 'Ann, full body, grey coat');
	assert.equal(readJson(root, `${ANN}/description.md.receipt.json`).paid_call_id, 'att-describe-v1', 'the describe call the entry was written from');
	assert.deepEqual(readJson(root, `${ANN}/object.json`), { schema: 2, type: 'character', name: 'Ann', relations: [{ kind: 'appears_in', to: 'episodes/EP001' }], shown_file: 'image-1.jpg' });
	assert.deepEqual(readJson(root, `${RAIN}/object.json`), { schema: 2, type: 'variant', name: 'Ann in the rain', variant_of: ANN, relations: [], shown_file: null });
	assert.equal(read(root, `${RAIN}/description.md`), 'Wet hair.');
	// A planned object the snapshot lists is an empty card; one with versions shows its current file.
	assert.deepEqual(readJson(root, 'episodes/EP002/object.json'), { schema: 2, type: 'episode', name: 'Episode 2', relations: [], shown_file: null });
	assert.deepEqual(readJson(root, 'episodes/EP001/keyframe/seg01/shot02/object.json'), { schema: 2, type: 'keyframe', name: 'Shot 2', relations: [], segment: 'seg01', shown_file: null }, 'its shown file is not there');
	assert.equal(readJson(root, `${SHOT}/object.json`).shown_file, 'image-1.jpg');
	assert.deepEqual(readJson(root, `${SHOT}/object.json`).objects_sent_by_draw_request, [ANN], 'the pictures its draw sent');
	assert.deepEqual(readJson(root, 'episodes/EP002/keyframe/seg01/shot01/object.json').objects_sent_by_draw_request, [ANN, CUP], "a planned card's snapshot inputs");
	// Removed by the person, and no longer listed by a later snapshot of its scope: deleted, and still in history.
	assert.ok(!existsSync(join(root, CUP)) && !existsSync(join(root, OLD)));
	assert.equal(await out(root, 'show', `HEAD~2:${CUP}/image-1.jpg`), 'cup');

	// History: the folder as found, then one commit per version in made_at order, then the last commit.
	const subjects = (await out(root, 'log', '--reverse', '--format=%an|%s')).split('\n');
	assert.equal(subjects[0], 'client-found-changes-on-disk|The major-1 project as found, before its conversion to major 2');
	assert.deepEqual(subjects.slice(-2), ['client-found-changes-on-disk|Each object set to its major-1 current; the major-1 folders removed', 'client-found-changes-on-disk|A Pine Drama project of major 2']);
	assert.deepEqual(subjects.filter(s => /^client-found-changes-on-disk\|Major-1 assets\/characters\/ann\/v\d+, converted$/.test(s)), [`client-found-changes-on-disk|Major-1 ${ANN}/v1, converted`, `client-found-changes-on-disk|Major-1 ${ANN}/v2, converted`]);
	assert.equal(await out(root, 'show', `HEAD~2:${ANN}/image-1.png`), 'ann two', "v2's picture is in history");
	// History describes itself: each version's commit names that version's shown file, so a past result is found by it.
	const described = await Promise.all((await out(root, 'log', '--reverse', '--format=%H', '--', `${ANN}/object.json`)).split('\n')
		.map(async commit => JSON.parse(await out(root, 'show', `${commit}:${ANN}/object.json`)).shown_file));
	assert.deepEqual(described, ['image-1.jpg', 'image-1.png', 'image-1.jpg'], 'v1, then v2, then the current v1');
	assert.deepEqual((await listHistoryOfShownFile(root, ANN)).map(r => [r.file, r.shown]), [[`${ANN}/image-1.png`, false], [`${ANN}/image-1.jpg`, true]],
		"the strip offers v2 under its own name, and shows v1, once");
});

test('a major-1 turn still owed a return refuses the conversion, naming the Studio to finish it in; nothing is changed', async () => {
	const { root, storage } = majorOneProject();
	// A request a Studio of major 1 sent, as its record keeps it (major1.ts, DramaRecord.sentTask).
	const sent = dramaRecordOf(join(storage, 'protocol'), root).requestPath('task-3');
	mkdirSync(dirname(sent), { recursive: true });
	writeFileSync(sent, JSON.stringify({ sent: '2026-11-13T10:00:00Z', computer: 'computer', chat: 'chat', request: { turn: 'task-3', scope: 'project' } as Request }));
	await assert.rejects(convertMajor1ProjectToMajor2(root, storage, '2026-11-14'), (error: unknown) =>
		error instanceof RefusedWithUpgradeInstructions && error.studioVersion === LAST_MAJOR_1_STUDIO.version && error.downloadUrl === LAST_MAJOR_1_STUDIO.downloadUrl
		&& /Nothing was changed/.test(error.message));
	assert.ok(!existsSync(`${root}.backup-2026-11-14`) && !existsSync(join(root, '.git')) && readProjectMajor(root) === 1);
});

test('a conversion cut off resumes after the last version it committed, with the same backup', async () => {
	const { root, storage } = majorOneProject();
	// The keyframe's file cannot be written (a folder in its place): the run stops there, after the versions before it.
	mkdirSync(join(root, `${SHOT}/image-1.jpg`));
	await assert.rejects(convertMajor1ProjectToMajor2(root, storage, '2026-11-14'), /EISDIR/);
	const before = (await out(root, 'log', '--format=%s')).split('\n').length;
	assert.equal(readProjectMajor(root), 1, 'still major 1: no marker');
	assert.ok(major1ConversionPending(storage, root), 'the window offers to go on with it');
	rmSync(join(root, `${SHOT}/image-1.jpg`), { recursive: true });
	assert.equal(await convertMajor1ProjectToMajor2(root, storage, '2026-11-15'), `${root}.backup-2026-11-14`, 'the first run\'s backup');
	const subjects = (await out(root, 'log', '--format=%s')).split('\n');
	assert.equal(subjects.filter(s => s === `Major-1 ${ANN}/v1, converted`).length, 1, 'no version is converted twice');
	assert.ok(subjects.length > before && readProjectMajor(root) === 2);
	assert.ok(!major1ConversionPending(storage, root), 'the journal is gone once the project is major 2');
});

test('a folder with no snapshot to give its objects, or a backup name already taken, refuses the conversion; nothing is changed', async () => {
	const { root, storage } = majorOneProject();
	writeFileSync(join(root, 'turns/task-1.json'), JSON.stringify({ ...readJson(root, 'turns/task-1.json'), snapshot: null }));
	writeFileSync(join(root, 'turns/task-2.json'), JSON.stringify({ ...readJson(root, 'turns/task-2.json'), snapshot: null }));
	await assert.rejects(convertMajor1ProjectToMajor2(root, storage, '2026-11-14'), (error: unknown) => error instanceof RefusedWithUpgradeInstructions && /no record of its turns/.test(error.message));
	assert.ok(!existsSync(join(root, '.git')) && !existsSync(`${root}.backup-2026-11-14`) && !major1ConversionPending(storage, root));
	const other = majorOneProject();
	mkdirSync(`${other.root}.backup-2026-11-14`);
	await assert.rejects(convertMajor1ProjectToMajor2(other.root, other.storage, '2026-11-14'), /already exists beside the project/);
	assert.ok(!existsSync(join(other.root, '.git')) && readProjectMajor(other.root) === 1);
});

test('an object whose every version was discarded keeps none of their files: its card is empty, and history keeps them', async () => {
	const { root, storage } = majorOneProject();
	const choices = readJson(root, 'choices.json');
	choices.objects[SHOT] = { discarded: ['v1'] };
	writeFileSync(join(root, 'choices.json'), JSON.stringify(choices));
	await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.ok(!existsSync(join(root, `${SHOT}/image-1.jpg`)) && !existsSync(join(root, `${SHOT}/image-1.jpg.receipt.json`)));
	assert.equal(readJson(root, `${SHOT}/object.json`).shown_file, null);
	assert.equal(await out(root, 'show', `HEAD~2:${SHOT}/image-1.jpg`), 'shot');
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

test("a .gitignore of the folder's keeps no major-1 source out of history: the commit of the folder as found names its entries", async () => {
	const { root, storage } = majorOneProject();
	write(root, '.gitignore', 'entry/\n*.png\nobject.json\n');
	await convertMajor1ProjectToMajor2(root, storage, '2026-11-14');
	assert.equal(JSON.parse(await out(root, 'show', `HEAD:${ANN}/object.json`)).name, 'Ann', 'nor any file the conversion wrote');
	const found = await out(root, 'rev-list', '--max-parents=0', 'HEAD');
	assert.equal(JSON.parse(await out(root, 'show', `${found}:${ANN}/entry/v1/entry.json`)).appearance, 'Tall, in a grey coat.');
	assert.equal(await out(root, 'show', `${found}:${ANN}/v2/image-1.png`), 'ann two');
});
