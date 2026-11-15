import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The layout: no view is moved into another container. A moved view is what gave Chat a second "Chat" header (its
// container no longer held one view) and its view the "Pine:" prefix (viewPane.ts, calculateTitle).
const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	contributes: { viewsContainers: Record<string, { id: string; title: string }[]>; views: Record<string, { id: string; name: string; contextualTitle?: string }[]> };
};

test('no code moves a view into another container', () => {
	const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts') && !f.includes('test'));
	const moving = sources.filter(f => readFileSync(join(root, 'src', f), 'utf8').includes("'vscode.moveViews'"));
	assert.deepEqual(moving, []);
});

test("a session row opens its project; whole-Computer shutdown is absent from creator menus", () => {
	const menu = (manifest.contributes as unknown as { menus: Record<string, { command: string; when?: string; group?: string }[]> }).menus['chat/chatSessions'];
	assert.deepEqual(menu.map(m => [m.command, m.when, m.group]), [
		['pineDrama.openSessionProject', 'chatSessionType == pine-computer', 'pine@1'],
	]);
});

test('the package shows the secondary side bar\'s labels on first launch, and no Copilot or Agents window entry in the title bar', () => {
	const defaults = (manifest.contributes as unknown as { configurationDefaults: Record<string, unknown> }).configurationDefaults;
	assert.equal(defaults['workbench.secondarySideBar.showLabels'], true);
	assert.equal(defaults['chat.titleBar.signIn.enabled'], false);
	assert.equal(defaults['chat.titleBar.openInAgentsWindow.enabled'], false);
});

test('a running turn shows one line naming the current step, which opens to every step: Conversation is the default (D29)', () => {
	const defaults = (manifest.contributes as unknown as { configurationDefaults: Record<string, unknown> }).configurationDefaults;
	assert.equal(defaults['chat.persistentProgressVerbosity'], 'conversation');
});

test('the open editor is never attached to a message by itself, as in upstream\'s Agents window (issue #140)', () => {
	const defaults = (manifest.contributes as unknown as { configurationDefaults: Record<string, unknown> }).configurationDefaults;
	assert.deepEqual(defaults['chat.implicitContext.enabled'], { panel: 'never' });
});

test('a message typed while a reply runs waits in the queue: queue is the default, never steer (D25)', () => {
	const defaults = (manifest.contributes as unknown as { configurationDefaults: Record<string, unknown> }).configurationDefaults;
	assert.equal(defaults['chat.requestQueuing.defaultAction'], 'queue');
});


// Creators get no Computer operation; exactly one developer command, palette only, under Developer.
test('the only Computer command is the developer Stop All, in no menu', () => {
	const contributes = manifest.contributes as unknown as { commands: { command: string; title: string; category: string }[]; menus: Record<string, { command: string }[]> };
	const stops = contributes.commands.filter(c => /stop/i.test(c.command));
	assert.deepEqual(stops.map(c => [c.command, c.category, c.title]), [['pineDrama.stopAllComputers', 'Developer', 'Pine: Stop All Computers']]);
	assert.deepEqual(Object.entries(contributes.menus).flatMap(([menu, entries]) => entries.filter(e => /stop/i.test(e.command)).map(e => [menu, e.command])), []);
});

test("Production's welcome says when the project is open in another Studio window, and names no config file", () => {
	const welcome = (manifest.contributes as unknown as { viewsWelcome: { view: string; when: string; contents: string }[] }).viewsWelcome.filter(w => w.view === 'pine.project');
	assert.deepEqual(welcome.map(w => w.when), ['!pineDrama.projectOpen && !pineDrama.projectElsewhere && !pineDrama.projectOfMajor1', 'pineDrama.projectElsewhere', 'pineDrama.projectOfMajor1'], 'one welcome at a time');
	assert.match(welcome[0].contents, /^No drama project is open\.\n\[Open Project Folder\]/);
	assert.doesNotMatch(welcome[0].contents, /drama-cli|cfg\.yaml/);
	assert.match(welcome[1].contents, /^This project is open in another Pine Drama Studio window\./);
	// A drama of major 1 is offered its conversion (projectCommands.ts), the one way into it.
	assert.match(welcome[2].contents, /^This project was made by an earlier Pine Drama Studio\. .*\n\[Convert This Project…\]\(command:pineDrama\.convertMajor1Project\)$/);
});
