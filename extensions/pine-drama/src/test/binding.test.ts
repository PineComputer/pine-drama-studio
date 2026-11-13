// The first message binds a session to the window's one folder, and
// only a folder whose drama/ the Studio can own. Fixture folders under a temporary directory, never the person's; no
// network (FakePine).
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { entryFor } from '../core/binding';
import { ChatService, type Update } from '../core/chats';
import type { PineConnection } from '../core/pinePort';
import { Store } from '../core/store';
import { FakePine, MemoryVault, type TurnPlan } from './fakePine';

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/local-1';
const OTHER = 'pine-computer:/local-2';
const done: TurnPlan = { state: 'completed', files: {} };

function setup() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-bind-')));
	const pine = new FakePine();
	const store = new Store(join(dir, 'studio.sqlite'));
	const service = new ChatService({ holdsProject: () => true,
		turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), pine: ENV, log: () => undefined,
		files: { libraryRoot: join(dir, 'library'), projectsRoot: join(dir, 'projects') },
	});
	const folder = (name: string) => { const f = join(dir, name); mkdirSync(f, { recursive: true }); return f; };
	return { dir, pine, store, service, folder };
}

async function drain(updates: AsyncGenerator<Update>): Promise<string> {
	const out: string[] = [];
	for await (const update of updates) {
		if (update.kind !== 'progress') {
			out.push(update.text);
		}
	}
	return out.join('\n');
}
const send = (service: ChatService, text: string, folder: string, key = KEY) => drain(service.submit(key, text, text, folder));

const SAID = (root: string) => `This project's root is \`${root}\`. The Pine Computer's returned results are published here.`;

// A folder that holds no drama-cli project is used whatever else it holds.
test('a new binding takes any folder that holds no drama-cli project; a project at its root is adopted, one below it refuses', () => {
	const { folder } = setup();
	const empty = folder('empty');
	assert.deepEqual(entryFor([], '/p', KEY, empty), { kind: 'go', bind: true, note: SAID(empty) });
	const emptyDrama = folder('empty-drama');
	mkdirSync(join(emptyDrama, 'drama'));
	assert.deepEqual(entryFor([], '/p', KEY, emptyDrama), { kind: 'go', bind: true, note: SAID(emptyDrama) }, 'an empty folder inside carries nothing');
	const notes = folder('notes');
	mkdirSync(join(notes, 'drama'));
	writeFileSync(join(notes, 'drama', 'notes.md'), 'the person\'s');
	assert.deepEqual(entryFor([], '/p', KEY, notes), { kind: 'go', bind: true, note: `${SAID(notes)} Its 1 file (under 0.1 MB) goes to the Pine Computer with each task, and no result replaces it.` });
	const project = folder('double-life');
	writeFileSync(join(project, 'choices.json'), 'project: x\n');
	assert.deepEqual(entryFor([], '/p', KEY, project), { kind: 'adopt', folder: project });
	const parent = folder('parent');
	const child = folder('parent/Untitled Project');
	writeFileSync(join(child, 'choices.json'), 'project: x\n');
	assert.deepEqual(entryFor([], '/p', KEY, parent), { kind: 'inside', folder: parent, project: child });
});

// Hidden names stay local (transportedPath): they are neither counted in the note nor the person's record's.
test('the note counts only the files that travel: .DS_Store, .git and .env stay local, Thumbs.db travels', () => {
	const { folder } = setup();
	const finder = folder('finder');
	for (const name of ['.DS_Store', '.env']) { writeFileSync(join(finder, name), 'x'); }
	mkdirSync(join(finder, '.git')); writeFileSync(join(finder, '.git', 'HEAD'), 'ref: refs/heads/main');
	assert.deepEqual(entryFor([], '/p', KEY, finder), { kind: 'go', bind: true, note: SAID(finder) });
	writeFileSync(join(finder, 'Thumbs.db'), 'explorer'); writeFileSync(join(finder, 'notes.txt'), 'the person\'s');
	assert.deepEqual(entryFor([], '/p', KEY, finder), { kind: 'go', bind: true, note: `${SAID(finder)} Its 2 files (under 0.1 MB) go to the Pine Computer with each task, and no result replaces them.` });
});

test('a bound session goes on in its folder and is refused elsewhere; a Chat of no project joins it as a session (D48)', () => {
	const { folder } = setup(); const root = folder('Night Ward');
	const convs = [{ key: KEY, label: 'Night Ward', folder: root, project_role: 'main' as const }];
	assert.deepEqual(entryFor(convs, '/p', KEY, root + '/'), { kind: 'go', bind: false });
	assert.deepEqual(entryFor(convs, '/p', KEY, folder('other')), { kind: 'elsewhere', folder: root });
	assert.deepEqual(entryFor(convs, '/p', OTHER, root), { kind: 'go', bind: true });
});

test('the first message binds the session to the window\'s folder and says once where the drama\'s files arrive', async () => {
	const { pine, store, service, folder } = setup();
	const night = folder('Night Ward');
	pine.plans = [done, done];
	const first = await send(service, 'make a drama', night);
	assert.equal(store.chat(KEY)?.folder, night);
	assert.equal(service.projectRoot(KEY), night);
	assert.match(first, /This project's root is `.*Night Ward`/);
	assert.doesNotMatch(await send(service, 'go on', night), /arrive in/, 'said once');
	assert.equal(pine.calls.run, 2);
	assert.deepEqual(readdirSync(night), [], 'binding writes no project files');
});

test('a new Chat in a project joins it as a session (D48)', async () => {
	const { pine, store, service, folder } = setup();
	const night = folder('Night Ward');
	await send(service, 'first drama', night, OTHER);
	const fresh = 'pine-computer:/session-3';
	pine.plans = [done];
	assert.doesNotMatch(await send(service, 'episode 3', night, fresh), /Not sent/);
	assert.deepEqual([store.chat(fresh)?.folder, store.chat(fresh)?.project_role, store.chat(OTHER)?.project_role], [night, null, 'main']);
	assert.equal(pine.calls.run, 2);
});

// The send's own check (the window's and the send are not one step) refuses a folder that changed meanwhile;
// the message comes back in that one line, as on the window's refusal, and nothing reaches Pine.
test('a send whose Chat is bound elsewhere is refused at the send with the message given back, quoted', async () => {
	const { pine, service, folder } = setup();
	const night = folder('Night Ward');
	pine.plans = [done];
	await send(service, 'make a drama', night);
	const runs = pine.calls.run;
	const seen: Update[] = [];
	for await (const update of service.submit(KEY, 'and the [poster](drama/poster.md)', 'x', folder('other'))) { seen.push(update); }
	const back = seen.filter(u => u.kind === 'unsent');
	assert.equal(back.length, 1, JSON.stringify(seen));
	assert.match(back[0].text, /^_Not sent: this session's drama is in another folder, `[^`]*Night Ward`\. Your message is below, to send again\._\n\n```text\nand the \[poster\]\(drama\/poster\.md\)\n```\n\n$/);
	assert.equal(pine.calls.run, runs, 'nothing was sent');
});

// A project's first Chat becomes its Project Chat, every later one a session. bindFolder decides in one transaction.
test('bindFolder: the first Chat of a folder is its Project Chat, a later one joins as a session, even from another window', () => {
	const { dir, store, folder } = setup();
	const root = folder('Night Ward');
	const other = new Store(join(dir, 'studio.sqlite'));
	for (const key of ['main', 'a', 'b', 'bound']) { store.insertChat({ key, env: 'pine', endpoint: 'http://test', label: key, secret_ref: key }); }
	assert.equal(store.bindFolder('main', root), true);
	assert.equal(store.bindFolder('a', root), true);
	assert.equal(other.bindFolder('b', root), true, 'a second window binds through the same transaction');
	assert.deepEqual(store.chats().filter(c => c.folder === root).map(c => [c.key, c.project_role]).sort(), [['a', null], ['b', null], ['main', 'main']]);
	assert.equal(store.bindFolder('a', root), false, 'a bound Chat is not bound again');
	assert.equal(store.bindFolder('bound', folder('elsewhere')), true);
	assert.equal(store.bindFolder('bound', root), false, 'a Chat of another project does not move');
	assert.equal(store.chat('bound')?.project_role, 'main');
	other.close();
});
