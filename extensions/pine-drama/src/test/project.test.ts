import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDrama, versionFile } from '../core/project';
import type { Choices, Snapshot } from '../core/protocol';
import type { ScopedSnapshot } from '../core/project';

// The drama as the readers see it (core/project.ts, readDrama), on the protocol fixture (test-fixtures/protocol): the
// rules that, broken, would show the person a removed object, hide one that exists, or drop their own edit or add.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const snapshot = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Snapshot;
const project = (s: Snapshot): ScopedSnapshot => ({ scope: 'project', snapshot: s });
const episodes = (s: Snapshot): ScopedSnapshot => ({ scope: 'episodes', snapshot: s });
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
	const drama = await readDrama(root, () => [project(PROJECT), episodes(EPISODES)]);
	assert.equal(drama.objects.get('assets/characters/lin')?.observedAt, PROJECT.observed_at);
	assert.equal(drama.objects.get('episodes/EP001')?.observedAt, EPISODES.observed_at, 'the episode session listed EP001 later');
	assert.ok(drama.objects.has('episodes/EP001/segments/seg02'));
	// An episode session's snapshot lists no shared object, and removes none.
	assert.ok(drama.objects.has('assets/props/umbrella'));
	assert.ok(drama.edges.some(e => e.kind === 'needs' && e.from === 'episodes/EP001'), "the episode's needs come with it");
	// The Project Chat's later snapshot without the umbrella removes it, and the edges to it.
	const later = await readDrama(root, () => [project(PROJECT), episodes(EPISODES), project(without(PROJECT, 'assets/props/umbrella', '2026-11-12T12:00:00Z'))]);
	assert.ok(!later.objects.has('assets/props/umbrella'));
	assert.ok(!later.edges.some(e => e.to === 'assets/props/umbrella'));
	assert.ok(later.objects.has('episodes/EP001/segments/seg01'), "the Project Chat's snapshot removes no object inside an episode");
	// A later snapshot listing EP001 without seg02 removes seg02.
	const episode = await readDrama(root, () => [project(PROJECT), episodes(EPISODES), episodes(without(EPISODES, 'episodes/EP001/segments/seg02', '2026-11-12T12:30:00Z'))]);
	assert.ok(!episode.objects.has('episodes/EP001/segments/seg02'));
	assert.ok(episode.objects.has('episodes/EP001/segments/seg01'));
});

test("the person's choices win: removed hides an object with its variants; their prompt and description show over the agent's", async () => {
	const root = folder({ schema: 1, objects: {
		'assets/characters/lin': { removed: true },
		'assets/scenes/office': { prompt: 'My office, at dusk', description: 'My newsroom' },
		'assets/props/umbrella': { prompt: '' },
	}, added: [], imports: [] });
	const drama = await readDrama(root, () => [project(PROJECT), episodes(EPISODES)]);
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
	const before = await readDrama(root, () => [project(PROJECT)]);
	assert.deepEqual(before.adds.map(a => a.id), ['add-0002-taxi']);
	const made: Snapshot = { ...PROJECT, observed_at: '2026-11-12T13:00:00Z', objects: { ...PROJECT.objects,
		'assets/props/taxi': { type: 'prop', name: 'Taxi', segment: null, usable: false, from_add: 'add-0002-taxi' } } };
	const after = await readDrama(root, () => [project(PROJECT), project(made)]);
	assert.deepEqual(after.adds, []);
	assert.ok(after.objects.has('assets/props/taxi'));
});

test('a downloaded version shows as its object\'s newest until its return installs it; then the installed one is read', async () => {
	const root = folder();
	const dir = mkdtempSync(join(tmpdir(), 'pds-preview-'));
	writeFileSync(join(dir, 'version.json'), JSON.stringify({ schema: 1, made_at: '2026-11-12T12:00:00Z', file: 'image-1.png', inputs: [], prompt: 'Lin, rain', from_import: null }));
	writeFileSync(join(dir, 'image-1.png'), 'png');
	const previews = () => [{ object: 'assets/characters/lin', version: 'v3', dir }];
	const before = (await readDrama(root, () => [project(PROJECT)], previews)).objects.get('assets/characters/lin')!;
	assert.equal(before.resolved.current, 'v3');
	assert.equal(versionFile(before, 'v3'), join(dir, 'image-1.png'), 'its file is read from where it was downloaded');
	// Installed: the folder's version is the one read, once.
	mkdirSync(join(root, 'assets', 'characters', 'lin', 'v3'), { recursive: true });
	writeFileSync(join(root, 'assets', 'characters', 'lin', 'v3', 'version.json'), readFileSync(join(dir, 'version.json')));
	const after = (await readDrama(root, () => [project(PROJECT)], previews)).objects.get('assets/characters/lin')!;
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
		requests: () => [{ sent: '2026-11-12T12:00:00Z', chat: 'chat-project', request: { turn: 'task-0001-aaaa', scope: 'project' as const, choices: carried } }],
		returns: () => [
			{ task: 'task-0000-zzzz', scope: 'project', sent: '2026-11-12T11:00:00Z', problems: [{ ref: 'assets/props/umbrella', error: problem }] },
			...(handled ? [{ task: 'task-0001-aaaa', scope: 'project', sent: '2026-11-12T12:00:00Z', problems: [] }] : []),
		],
	});
	const running = await readDrama(root, () => [project(PROJECT)], () => [], tasks(false));
	assert.deepEqual(running.objects.get('assets/scenes/office')?.outgoing, { chat: 'chat-project' }, 'the description the request did not carry');
	assert.equal(running.objects.get('assets/characters/lin')?.outgoing, null, 'no choice, nothing outgoing');
	assert.equal(running.addsInFlight.get('add-0003-bus'), 'chat-project');
	assert.equal(running.objects.get('assets/props/umbrella')?.problem?.message, problem.message);
	// Its return dealt with: no longer in flight, and the scope's last return named no problem.
	const back = await readDrama(root, () => [project(PROJECT)], () => [], tasks(true));
	assert.equal(back.addsInFlight.size, 0);
	assert.equal(back.objects.get('assets/props/umbrella')?.problem, null);
});
