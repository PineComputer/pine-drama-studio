import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The right region's layout: Review is its own tab, never a pane
// moved into Chat. A moved view is what gave Chat a second "Chat" header (its container no longer held one view) and
// Review the "Pine:" prefix (viewPane.ts, calculateTitle).
const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	contributes: { viewsContainers: Record<string, { id: string; title: string }[]>; views: Record<string, { id: string; name: string; contextualTitle?: string }[]> };
};

test('the Review view is declared in the Review tab of the secondary side bar, titled like it, so it shows no prefix if moved', () => {
	assert.deepEqual(manifest.contributes.viewsContainers.secondarySidebar.map(c => [c.id, c.title]), [['pine-review', 'Review']]);
	const review = manifest.contributes.views['pine-review'].find(v => v.id === 'pine.sessionReview');
	assert.equal(review?.name, 'Review');
	assert.equal(review?.contextualTitle ?? 'Review', 'Review', 'a contextual title other than the view\'s name prefixes it ("Pine: Review")');
});

test('no code moves a view into another container', () => {
	const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts') && !f.includes('test'));
	const moving = sources.filter(f => readFileSync(join(root, 'src', f), 'utf8').includes("'vscode.moveViews'"));
	assert.deepEqual(moving, []);
});

test('Review is one view, always present, with a welcome when nothing waits', () => {
	const views = manifest.contributes.views['pine-review'] as { id: string; when?: string }[];
	assert.deepEqual(views.map(v => v.id), ['pine.sessionReview'], 'the screenplay is a node of Review, not a second view');
	assert.equal(views[0].when, undefined, 'the tab does not come and go');
	const welcome = (manifest.contributes as unknown as { viewsWelcome: { view: string; contents: string }[] }).viewsWelcome.filter(w => w.view === 'pine.sessionReview');
	assert.equal(welcome.length, 1);
	assert.match(welcome[0].contents, /^Nothing waits for your decision in this folder\./);
	assert.match(welcome[0].contents, /\[Open Recent…\]\(command:workbench\.action\.openRecent\)/, "another project is reached through Code-OSS's own recent list (D27)");
});

test("a session row opens its project; whole-Computer shutdown is absent from creator menus", () => {
	const menu = (manifest.contributes as unknown as { menus: Record<string, { command: string; when?: string; group?: string }[]> }).menus['chat/chatSessions'];
	assert.deepEqual(menu.map(m => [m.command, m.when, m.group]), [
		['pineDrama.openSessionProject', 'chatSessionType == pine-computer', 'pine@1'],
	]);
});

test('the package shows Review beside Chat on first launch, and no Copilot or Agents window entry in the title bar', () => {
	const defaults = (manifest.contributes as unknown as { configurationDefaults: Record<string, unknown> }).configurationDefaults;
	// The secondary side bar opens 300 px wide (Code-OSS layout.ts, AUXILIARYBAR_SIZE); two labelled tabs beside Chat's
	// title actions overflow there, so Review was only in "…". Icons fit; each is named in its tooltip.
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
	assert.deepEqual(welcome.map(w => w.when), ['!pineDrama.projectOpen && !pineDrama.projectElsewhere', 'pineDrama.projectElsewhere'], 'one welcome at a time');
	assert.match(welcome[0].contents, /^No drama project is open\.\n\[Open Project Folder\]/);
	assert.doesNotMatch(welcome[0].contents, /drama-cli|cfg\.yaml/);
	assert.match(welcome[1].contents, /^This project is open in another Pine Drama Studio window\./);
});
