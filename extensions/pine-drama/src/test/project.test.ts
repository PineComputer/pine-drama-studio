import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DramaProject, episodeOfNode, readDrama, versionFile, versionTitle } from '../core/project';
import { decomposition } from '../core/threeSteps';
import type { Choices, Snapshot } from '../core/protocol';
import type { ScopedSnapshot, TasksOf } from '../core/project';

// The drama as the readers see it (core/project.ts, readDrama), on the protocol fixture (test-fixtures/protocol): the
// rules that, broken, would show the person a removed object, hide one that exists, or drop their own edit or add.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const snapshot = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Snapshot;
/** The `n`th installed return's snapshot: task-<n>, its request sent at minute 2n and its return installed at minute 2n + 1. */
const at = (minute: number) => `2026-11-12T13:${String(minute).padStart(2, '0')}:00Z`;
const scoped = (scope: 'project' | 'episodes') => (s: Snapshot, n: number): ScopedSnapshot =>
	({ scope, snapshot: s, task: `task-${n}`, sent: at(2 * n), installed: at(2 * n + 1) });
const project = scoped('project');
const episodes = scoped('episodes');
const PROJECT = snapshot('snapshot-project.json');
const EPISODES = snapshot('snapshot-episodes.json');

/** A copy of the fixture's folder with `choices` as its choices.json. */
function folder(choices?: Choices): string {
	const root = mkdtempSync(join(tmpdir(), 'pds-drama-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	if (choices) { writeFileSync(join(root, 'choices.json'), JSON.stringify(choices)); }
	return root;
}

/** `snapshot` without `id`, observed later. */
const without = (from: Snapshot, id: string, at: string): Snapshot =>
	({ observed_at: at, objects: Object.fromEntries(Object.entries(from.objects).filter(([key]) => key !== id)), edges: from.edges.filter(e => e.from !== id && e.to !== id) });

test('each object comes from the latest snapshot that lists it; a later snapshot of its owner that omits it removes it, and no other does', async () => {
	const root = folder();
	const drama = await readDrama(root, () => [project(PROJECT, 1), episodes(EPISODES, 2)]);
	assert.equal(drama.objects.get('assets/characters/lin')?.observedAt, PROJECT.observed_at);
	assert.equal(drama.objects.get('episodes/EP001')?.observedAt, EPISODES.observed_at, 'the episode session listed EP001 later');
	assert.ok(drama.objects.has('episodes/EP001/segments/seg02'));
	// An episode session's snapshot lists no shared object, and removes none.
	assert.ok(drama.objects.has('assets/props/umbrella'));
	assert.ok(drama.edges.some(e => e.kind === 'needs' && e.from === 'episodes/EP001'), "the episode's needs come with it");
	// The Project Chat's later snapshot without the umbrella removes it, and the edges to it.
	const later = await readDrama(root, () => [project(PROJECT, 1), episodes(EPISODES, 2), project(without(PROJECT, 'assets/props/umbrella', '2026-11-12T12:00:00Z'), 3)]);
	assert.ok(!later.objects.has('assets/props/umbrella'));
	assert.ok(!later.edges.some(e => e.to === 'assets/props/umbrella'));
	assert.ok(later.objects.has('episodes/EP001/segments/seg01'), "the Project Chat's snapshot removes no object inside an episode");
	// A later snapshot listing EP001 without seg02 removes seg02.
	const episode = await readDrama(root, () => [project(PROJECT, 1), episodes(EPISODES, 2), episodes(without(EPISODES, 'episodes/EP001/segments/seg02', '2026-11-12T12:30:00Z'), 3)]);
	assert.ok(!episode.objects.has('episodes/EP001/segments/seg02'));
	assert.ok(episode.objects.has('episodes/EP001/segments/seg01'));
});

test("the person's choices win: removed hides an object with its variants; their prompt and description show over the agent's", async () => {
	const root = folder({ schema: 1, objects: {
		'assets/characters/lin': { removed: true },
		'assets/scenes/office': { prompt: 'My office, at dusk', description: 'My newsroom' },
		'assets/props/umbrella': { prompt: '' },
	}, added: [], imports: [] });
	const drama = await readDrama(root, () => [project(PROJECT, 1), episodes(EPISODES, 2)]);
	assert.ok(!drama.objects.has('assets/characters/lin'));
	assert.ok(!drama.objects.has('assets/characters/lin/variants/rain'), 'a variant of a removed asset is removed with it');
	assert.ok(!drama.edges.some(e => e.from.startsWith('assets/characters/lin') || e.to.startsWith('assets/characters/lin')));
	assert.equal(drama.objects.get('assets/scenes/office')?.prompt, 'My office, at dusk');
	assert.equal(drama.objects.get('assets/scenes/office')?.description, 'My newsroom');
	assert.equal(drama.objects.get('assets/props/umbrella')?.prompt, '', 'an emptied prompt is the person\'s, not the agent\'s');
});

test("an add shows until a snapshot names it in an object's from_add", async () => {
	const add = { id: 'add-0002-taxi', type: 'prop' as const, name: 'Taxi', description: 'A yellow cab.' };
	const root = folder({ schema: 1, objects: {}, added: [add], imports: [] });
	const before = await readDrama(root, () => [project(PROJECT, 1)]);
	assert.deepEqual(before.adds.map(a => a.id), ['add-0002-taxi']);
	const made: Snapshot = { ...PROJECT, observed_at: '2026-11-12T13:00:00Z', objects: { ...PROJECT.objects,
		'assets/props/taxi': { type: 'prop', name: 'Taxi', segment: null, usable: false, from_add: 'add-0002-taxi' } } };
	const after = await readDrama(root, () => [project(PROJECT, 1), project(made, 2)]);
	assert.deepEqual(after.adds, []);
	assert.ok(after.objects.has('assets/props/taxi'));
});

test('a downloaded version shows as its object\'s newest until its return installs it; then the installed one is read', async () => {
	const root = folder();
	const dir = mkdtempSync(join(tmpdir(), 'pds-preview-'));
	writeFileSync(join(dir, 'version.json'), JSON.stringify({ schema: 1, made_at: '2026-11-12T12:00:00Z', file: 'image-1.png', inputs: [], prompt: 'Lin, rain', from_import: null }));
	writeFileSync(join(dir, 'image-1.png'), 'png');
	const previews = () => [{ object: 'assets/characters/lin', version: 'v3', dir }];
	const before = (await readDrama(root, () => [project(PROJECT, 1)], previews)).objects.get('assets/characters/lin')!;
	assert.equal(before.resolved.current, 'v3');
	assert.equal(versionFile(before, 'v3'), join(dir, 'image-1.png'), 'its file is read from where it was downloaded');
	// Installed: the folder's version is the one read, once.
	mkdirSync(join(root, 'assets', 'characters', 'lin', 'v3'), { recursive: true });
	writeFileSync(join(root, 'assets', 'characters', 'lin', 'v3', 'version.json'), readFileSync(join(dir, 'version.json')));
	const after = (await readDrama(root, () => [project(PROJECT, 1)], previews)).objects.get('assets/characters/lin')!;
	assert.equal(after.versions.filter(v => v.id === 'v3').length, 1);
	assert.equal(versionFile(after, 'v3'), 'assets/characters/lin/v3/image-1.png');
});

test("the cards' marks: a choice its scope's last request did not carry is outgoing; a carried add is in flight until its return; the last return's problems", async () => {
	const add = { id: 'add-0003-bus', type: 'prop' as const, name: 'Bus', description: 'A night bus.' };
	const choices: Choices = { schema: 1, objects: { 'assets/scenes/office': { description: 'My newsroom' } }, added: [add], imports: [] };
	const root = folder(choices);
	const carried: Choices = { schema: 1, objects: {}, added: [add], imports: [] };
	const problem = { code: 'not_allowed' as const, message: 'The umbrella cannot be removed: EP001 needs it.', action: 'Remove it from EP001 first.' };
	const tasks = (handled: boolean) => ({
		requests: () => [{ sent: '2026-11-12T12:00:00Z', chat: 'chat-project', request: { turn: 'task-0001-aaaa', scope: 'project' as const, choices: carried, versions: {} } }],
		returns: () => [
			{ task: 'task-0000-zzzz', scope: 'project', sent: '2026-11-12T11:00:00Z', problems: [{ ref: 'assets/props/umbrella', error: problem }] },
			...(handled ? [{ task: 'task-0001-aaaa', scope: 'project', sent: '2026-11-12T12:00:00Z', problems: [] }] : []),
		],
	});
	const running = await readDrama(root, () => [project(PROJECT, 1)], () => [], tasks(false));
	assert.deepEqual(running.objects.get('assets/scenes/office')?.outgoing, { chat: 'chat-project' }, 'the description the request did not carry');
	assert.equal(running.objects.get('assets/characters/lin')?.outgoing, null, 'no choice, nothing outgoing');
	assert.equal(running.addsInFlight.get('add-0003-bus'), 'chat-project');
	assert.equal(running.objects.get('assets/props/umbrella')?.problem?.message, problem.message);
	// Its return dealt with: no longer in flight, and the scope's last return named no problem.
	const back = await readDrama(root, () => [project(PROJECT, 1)], () => [], tasks(true));
	assert.equal(back.addsInFlight.size, 0);
	assert.equal(back.objects.get('assets/props/umbrella')?.problem, null);
});

test("a shared object an episode turn made stays until a snapshot whose turn knew it omits it, whichever session returned it", async () => {
	const root = folder();
	const rain = 'assets/scenes/office/variants/rain_night';
	// EP001's session makes a new variant of the office: its snapshot lists it, with its edge to the office.
	const made: Snapshot = { ...EPISODES, observed_at: '2026-11-12T13:05:00Z',
		objects: { ...EPISODES.objects, [rain]: { type: 'variant', name: 'Office, rainy night', segment: null, usable: false, from_add: null } },
		edges: [...EPISODES.edges, { from: rain, to: 'assets/scenes/office', kind: 'variant_of' }] };
	const episode = (n: number, sent: number, installed: number): ScopedSnapshot => ({ scope: 'episodes', snapshot: made, task: `task-${n}`, sent: at(sent), installed: at(installed) });
	const chat = (n: number, sent: number, installed: number): ScopedSnapshot =>
		({ scope: 'project', snapshot: { ...PROJECT, observed_at: at(installed - 1) }, task: `task-${n}`, sent: at(sent), installed: at(installed) });
	const requests = (...carrying: { n: number; folders: string[] }[]): TasksOf => ({
		requests: () => carrying.map(c => ({ sent: at(0), chat: 'chat', request: { turn: `task-${c.n}`, scope: 'project' as const, choices: { schema: 1 as const, objects: {}, added: [], imports: [] }, versions: Object.fromEntries(c.folders.map(f => [f, 'h'])) } })),
		returns: () => [],
	});
	// A Project Chat turn sent before the episode's return installed never saw the variant: its snapshot does not remove it.
	const unseen = await readDrama(root, () => [project(PROJECT, 1), episode(2, 4, 8), chat(3, 6, 10)], () => [], requests());
	assert.ok(unseen.objects.has(rain), 'merged by id from the episode snapshot');
	assert.ok(unseen.edges.some(e => e.from === rain && e.kind === 'variant_of'), 'with its edge');
	// One sent after that install knew it: its omission removes it.
	const knew = await readDrama(root, () => [project(PROJECT, 1), episode(2, 4, 8), chat(3, 12, 14)], () => [], requests());
	assert.ok(!knew.objects.has(rain));
	// So does one whose request carried a version folder of it, though no snapshot listed it before.
	const carried = await readDrama(root, () => [project(PROJECT, 1), episode(2, 4, 8), chat(3, 6, 10)], () => [], requests({ n: 3, folders: [`${rain}/v1`] }));
	assert.ok(!carried.objects.has(rain));
});

// B18: a 53-episode screenplay listed 53 rows, each "Decomposed" or "Not decomposed".
test('Script lists the episodes under way, folds the ones not started into one row, and says so in plain words', async () => {
	const episode = (name: string) => ({ type: 'episode' as const, name, segment: null, usable: true, from_add: null });
	const listed: Snapshot = { ...PROJECT, objects: { ...PROJECT.objects, screenplay: { type: 'screenplay', name: 'Screenplay', segment: null, usable: true, from_add: null },
		'episodes/EP002': episode('EP002 Second'), 'episodes/EP003': episode('EP003 Third') } };
	const drama = new DramaProject(folder(), () => [project(listed, 1), episodes(EPISODES, 2)]);
	const [script] = await drama.children();
	const rows = await drama.children(script);
	assert.deepEqual(rows.map(r => r.label), ['EP001 The Interview', '2 not started yet']);
	assert.deepEqual((await drama.children(rows[1])).map(r => [r.label, r.episode]), [['EP002 Second', 'episodes/EP002'], ['EP003 Third', 'episodes/EP003']]);
	const made = await drama.drama();
	assert.equal(decomposition(made, made.objects.get('episodes/EP001/breakdown')).text, 'Takes shot', 'EP001 has takes: its furthest stage with a version');
	assert.equal(decomposition(made, undefined).text, 'Not started');
	assert.deepEqual((await drama.locate('#script/episodes/EP003')).map(n => n.id), ['screenplay', '#script/later', '#script/episodes/EP003'], 'a folded episode is still found');
	// Its canvas and seg editor open from its row (Codex on B18): the row names its episode.
	const folded = (await drama.children(rows[1]))[1];
	assert.equal(episodeOfNode(folded), 'EP003');
	assert.equal(episodeOfNode(rows[0]), 'EP001');
});

// Finished episodes, with a cut, read "Shots planned" under Script, which a beginner reads as not done.
test('An episode under Script is labelled by its furthest stage that has a version', async () => {
	const root = folder();
	const cut = join(root, 'episodes', 'EP001', 'cut', 'v1');
	mkdirSync(cut, { recursive: true });
	writeFileSync(join(cut, 'cut.mp4'), '');
	writeFileSync(join(cut, 'version.json'), JSON.stringify({ schema: 1, made_at: '2026-11-12T12:00:00Z', file: 'cut.mp4', inputs: [{ object: 'episodes/EP001/segments/seg01', version: 'v1' }], prompt: null, from_import: null }));
	const planned: Snapshot = { ...EPISODES, objects: { ...EPISODES.objects,
		'episodes/EP001/cut': { type: 'cut', name: 'EP001 cut', segment: null, usable: true, from_add: null },
		'episodes/EP001/subtitles': { type: 'subtitles', name: 'EP001 subtitles', segment: null, usable: true, from_add: null } } };
	const made = await readDrama(root, () => [project(PROJECT, 1), episodes(planned, 2)]);
	assert.deepEqual(decomposition(made, made.objects.get('episodes/EP001/breakdown')), { text: 'Edited', decomposed: true }, 'the cut has a version; the subtitles, planned, have none');
});

// B13: a review card titled versions by their folders' paths ("episodes/EP001/segments/seg02 t01"); the canvas's
// reference tooltips did too. Both now name a version as the canvas names its card.
test("a version's name for the person: a variant after its asset, an episode's object after its episode, a take by its number", async () => {
	const drama = await readDrama(folder(), () => [project(PROJECT, 1), episodes(EPISODES, 2)]);
	assert.equal(versionTitle(drama, 'assets/characters/lin/variants/rain', 'v1'), 'Lin · In the rain · v1');
	assert.equal(versionTitle(drama, 'assets/characters/lin', 'v3'), 'Lin · v3');
	assert.equal(versionTitle(drama, 'episodes/EP001/segments/seg02', 't01'), 'EP001 · seg02 · take 1');
	assert.equal(versionTitle(drama, 'episodes/EP001', 'v1'), 'EP001 The Interview · v1');
	assert.equal(versionTitle(drama, 'assets/props/kettle', 'v2'), 'kettle · v2', 'an object no snapshot names yet, by its folder');
});
