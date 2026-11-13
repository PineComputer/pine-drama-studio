import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { projectAt, ProjectsInsideError } from '../core/projectEntry';
import { projectIdentity, projectPlaceOf, owningChat } from '../core/projectPlace';
import { entryFor } from '../core/binding';
import { Store } from '../core/store';

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'pine-project-root-')));

/** A fixture folder the person made, named `name`, in `parent`. */
const made = (parent: string, name: string) => { const root = join(parent, name); mkdirSync(root); return root; };

/** Every entry under `root` with its bytes, so "nothing was written" is checked, not assumed. */
function snapshot(root: string): string {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.map(e => `${relative(root, join(e.parentPath, e.name))}${e.isFile() ? `=${readFileSync(join(e.parentPath, e.name)).toString('base64')}` : '/'}`).sort().join('\n');
}

test('New Project: the chosen empty folder is the root, with no folder made inside it', async () => {
	const parent = temp(); const root = made(parent, 'long-bai-gu-jing-001');
	assert.deepEqual(await projectAt(root), { root, initialized: false });
	const alias = join(parent, 'alias'); symlinkSync(root, alias);
	assert.deepEqual(await projectAt(alias), { root, initialized: false }, 'an alias is the same canonical root');
	assert.deepEqual(readdirSync(root), []);
	assert.deepEqual(readdirSync(parent).sort(), ['alias', 'long-bai-gu-jing-001']);
});

test('New Project: a folder holding only what Finder or Explorer wrote is empty, and those files stay as they were', async () => {
	const root = made(temp(), '\u6211\u7684\u77ed\u5267');
	writeFileSync(join(root, '.DS_Store'), 'finder'); writeFileSync(join(root, 'Thumbs.db'), 'explorer'); writeFileSync(join(root, 'desktop.ini'), 'explorer');
	const before = snapshot(root);
	assert.deepEqual(await projectAt(root), { root, initialized: false });
	assert.equal(snapshot(root), before);
});

// Item 1: the person's files do not stop a folder from becoming the project.
test('New Project: a folder of the person\'s files with no drama is the root, and projectAt writes nothing', async () => {
	const parent = temp();
	const cases: [string, (root: string) => void][] = [
		['a file', root => writeFileSync(join(root, 'screenplay.fountain'), 'original')],
		['.git', root => { mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main'); }],
		['another dotfile', root => writeFileSync(join(root, '.env'), 'x')],
		['metadata and a file', root => { writeFileSync(join(root, '.DS_Store'), 'finder'); writeFileSync(join(root, 'notes.txt'), 'notes'); }],
	];
	for (const [label, fill] of cases) {
		const root = made(parent, label); fill(root);
		const before = snapshot(root);
		assert.deepEqual(await projectAt(root), { root, initialized: false }, label);
		assert.equal(snapshot(root), before, label);
	}
});

test('New Project and Open Project: a folder with a project anywhere below its root names it and opens nothing', async () => {
	const parent = temp();
	for (const [label, rel] of [['one level down', 'Untitled Project'], ['two levels down', 'old/Untitled Project']]) {
		const root = made(parent, label); const inner = join(root, rel); mkdirSync(inner, { recursive: true });
		writeFileSync(join(inner, 'choices.json'), 'inner');
		const before = snapshot(root);
		await assert.rejects(projectAt(root), (e: Error) => e instanceof ProjectsInsideError && e.projects.join() === inner, label);
		assert.equal(snapshot(root), before, label);
	}
});

test('discovery reads only the selected root, including when it contains an independently initialized child', async () => {
	const parent = temp(); const child = join(parent, 'drama'); mkdirSync(child);
	writeFileSync(join(child, 'choices.json'), 'child');
	// The parent is not a project, and it names the one inside it; nothing is opened or written.
	await assert.rejects(projectAt(parent), (e: Error) => e instanceof ProjectsInsideError && e.projects.join() === child);
	assert.deepEqual(await projectAt(child), { root: child, initialized: true });
	writeFileSync(join(parent, 'choices.json'), 'root');
	assert.deepEqual(await projectAt(parent), { root: parent, initialized: true }, 'a child is irrelevant to explicit root selection');
	assert.equal(readFileSync(join(parent, 'choices.json'), 'utf8'), 'root');
	assert.equal(readFileSync(join(child, 'choices.json'), 'utf8'), 'child');
});

test('missing roots, files and config-shaped directories never become projects; a folder of the person\'s files does', async () => {
	const root = temp();
	await assert.rejects(projectAt(join(root, 'missing')));
	writeFileSync(join(root, 'screenplay.fountain'), 'original');
	await assert.rejects(projectAt(join(root, 'screenplay.fountain')));
	assert.deepEqual(await projectAt(root), { root, initialized: false }, 'the person\'s screenplay is not a project');
	mkdirSync(join(root, 'choices.json'));
	await assert.rejects(projectAt(root), /choices\.json is not a file, so .+ is neither a drama nor a folder for a new one\. Nothing was written\./);
	assert.equal(readFileSync(join(root, 'screenplay.fountain'), 'utf8'), 'original');
});

test('binding is atomic across windows, canonicalizes aliases, creates no wrapper and changes no schema', () => {
	const dir = temp(); const root = made(dir, 'My Film'); const alias = join(dir, 'alias'); symlinkSync(root, alias);
	const path = join(dir, 'studio.sqlite'); const a = new Store(path); const b = new Store(path);
	for (const key of ['a', 'b']) { a.insertChat({ key, env: 'test', endpoint: 'http://test', label: key, secret_ref: key }); }
	assert.equal(a.bindFolder('a', alias), true);
	// The later Chat joins as a session; the project keeps one Project Chat.
	assert.equal(b.bindFolder('b', root), true);
	assert.deepEqual([a.chat('a')!.project_role, a.chat('b')!.project_role, a.chat('b')!.folder], ['main', null, projectIdentity(root)]);
	assert.equal(a.chat('a')!.folder, projectIdentity(root));
	assert.equal(owningChat(a.chats(), dir, [alias])?.key, 'a');
	assert.deepEqual(projectPlaceOf(dir, a.chat('a')!), { root, boundary: root });
	assert.deepEqual(readdirSync(root), []);
	assert.equal(a.db.prepare('pragma user_version').get()!.user_version, 16);
	a.close(); b.close();
});

test('an owned input-only root can continue intake before init has enough information', () => {
	const dir = temp(); const root = made(dir, 'My Film'); const store = new Store(join(dir, 'studio.sqlite'));
	store.insertChat({ key: 'a', env: 'test', endpoint: 'http://test', label: 'a', secret_ref: 'a' });
	assert.equal(store.bindFolder('a', root), true);
	mkdirSync(join(root, 'inputs')); writeFileSync(join(root, 'inputs/screenplay.fountain'), 'the attached screenplay');
	assert.deepEqual(entryFor(store.chats(), dir, 'a', root), { kind: 'go', bind: false });
	store.close();
});

test('a parent of several projects names them all; config-shaped directories and files one level down are not projects', async () => {
	const parent = temp();
	for (const name of ['EP B', 'EP A']) { mkdirSync(join(parent, name)); writeFileSync(join(parent, name, 'choices.json'), name); }
	mkdirSync(join(parent, 'not a project')); mkdirSync(join(parent, 'not a project', 'choices.json'));
	writeFileSync(join(parent, 'choices.json.bak'), 'a file, not a project');
	await assert.rejects(projectAt(parent), (e: Error) => e instanceof ProjectsInsideError
		&& e.projects.map(p => p.slice(parent.length + 1)).join('|') === 'EP A|EP B'
		&& /holds 2 projects: EP A, EP B\. Open the one you want\./.test(e.message));
	assert.deepEqual(readdirSync(parent).sort(), ['EP A', 'EP B', 'choices.json.bak', 'not a project']);
	const none = temp(); mkdirSync(join(none, 'empty child')); writeFileSync(join(none, 'notes.txt'), 'x');
	assert.deepEqual(await projectAt(none), { root: none, initialized: false }, 'a folder of the person\'s files with no project below is a new project\'s root');
});
