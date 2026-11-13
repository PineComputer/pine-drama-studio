import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A window whose folder no Chat owned at activation is wired when a Chat binds the folder later (extension.ts,
// wireProject on ChatService's onChange). The person's EP001 canvas showed its 00:45 export for hours: the window had
// opened the project before the second Chat bound it, so nothing refreshed the canvas when its files arrived.
// A separate file: extension.js must be loaded after the hooks below, in a process of its own (as dramaCliWiring.test.ts).

const base = realpathSync(mkdtempSync(join(tmpdir(), 'pine-later-binding-')));
const project = join(base, 'project');
mkdirSync(project);
writeFileSync(join(project, 'choices.json'), `project: ${project}\n`);
const extensionPath = join(base, 'Resources', 'app', 'extensions', 'pine-drama');
mkdirSync(extensionPath, { recursive: true });

/** Every file system watcher the activation creates: where it watches, and its listeners. */
type Watcher = { base: string; listeners: ((uri: { fsPath: string }) => void)[] };
const watchers: Watcher[] = [];
const lines: string[] = [];
const known: Record<string, unknown> = {
	'workspace.workspaceFolders': [{ uri: { scheme: 'file', fsPath: project } }],
	'window.createOutputChannel': () => ({ appendLine: (line: string) => lines.push(line), append() {}, show() {}, dispose() {} }),
	'env.appName': 'Pine Drama Studio (test)',
	// The message boxes resolve, as VS Code's do, so the activation goes on past the Pine connection's notice.
	'window.showInformationMessage': () => Promise.resolve(undefined),
	'window.showWarningMessage': () => Promise.resolve(undefined),
	'window.showErrorMessage': () => Promise.resolve(undefined),
	'commands.executeCommand': () => Promise.resolve(undefined),
	'version': '0.0.0-test',
	// The workbench's open tabs (an array, as VS Code's `TabGroups.all`): the galleries close restored tabs of removed
	// pages at activation (galleries.ts).
	'window.tabGroups.all': [],
	'Uri.file': (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` }),
	'RelativePattern': class { constructor(readonly baseUri: { fsPath: string }, readonly pattern: string) { } },
	'workspace.createFileSystemWatcher': (pattern: { baseUri?: { fsPath: string } }) => {
		const watcher: Watcher = { base: pattern.baseUri?.fsPath ?? '', listeners: [] };
		watchers.push(watcher);
		const listen = (listener: (uri: { fsPath: string }) => void) => { watcher.listeners.push(listener); return { dispose() {} }; };
		return { onDidCreate: listen, onDidChange: listen, onDidDelete: listen, dispose() {} };
	},
};
const deep = (path: string): unknown => new Proxy(function stub() { /* stand-in */ }, {
	get: (_target, prop) => typeof prop === 'symbol' || prop === 'then' ? undefined : (path ? `${path}.${prop}` : prop) in known ? known[path ? `${path}.${prop}` : prop] : deep(path ? `${path}.${prop}` : prop),
	apply: () => deep(`${path}()`),
	construct: () => deep(`new ${path}`) as object,
});
const state: { chat?: { onChange?: (key: string) => void }; owner?: { key: string; label: string; folder: string }; refreshes: number } = { refreshes: 0 };
const globals = globalThis as Record<symbol, unknown>;
globals[Symbol.for('pine.binding.vscode')] = deep('');
globals[Symbol.for('pine.binding.state')] = state;
const capture: Record<string, string> = {
	'/out/core/chats.js': 'const Real = module.exports.ChatService; module.exports.ChatService = class extends Real { constructor(options) { super(options); globalThis[Symbol.for("pine.binding.state")].chat = options; } };',
	// The owning Chat, as the test binds it: none at activation, then the one it names.
	'/out/core/projectPlace.js': 'module.exports.owningChat = () => globalThis[Symbol.for("pine.binding.state")].owner;',
	'/out/episodeCanvas.js': 'const real = module.exports.registerEpisodeCanvas; module.exports.registerEpisodeCanvas = (...args) => { const canvas = real(...args); return { ...canvas, refresh: () => { globalThis[Symbol.for("pine.binding.state")].refreshes++; canvas.refresh(); } }; };',
};
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-binding-test:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => {
		if (url === 'pine-binding-test:vscode') {
			return { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.binding.vscode")]', shortCircuit: true };
		}
		const suffix = Object.keys(capture).find(s => url.endsWith(s));
		if (!suffix) { return next(url, context); }
		const loaded = next(url, context);
		return { ...loaded, source: `${String(loaded.source)}\n${capture[suffix]}\n`, shortCircuit: true };
	},
});

const until = async (what: string, done: () => boolean, ms = 5000) => {
	for (const start = Date.now(); !done(); await new Promise(resolve => setTimeout(resolve, 20))) {
		if (Date.now() - start > ms) { assert.fail(`${what} within ${ms} ms; output:\n${lines.join('\n')}`); }
	}
};
/** A file of the project arrives, as a published storyboard does: every watcher of the project hears it. */
const arrive = (rel: string) => {
	for (const watcher of watchers.filter(w => w.base === project)) {
		for (const listener of watcher.listeners) { listener({ fsPath: join(project, rel) }); }
	}
};

test('a Chat that binds the window\'s folder after activation wires the window, so the canvas follows the project\'s files', async () => {
	const previousHome = process.env.HOME;
	process.env.HOME = join(base, 'home');
	let extension: typeof import('../extension') | undefined;
	try {
		extension = require('../extension') as typeof import('../extension');
		await extension.activate({ subscriptions: [], extensionPath, globalStorageUri: { fsPath: join(base, 'storage') }, secrets: deep('secrets'), extensionMode: 1, workspaceState: deep("workspaceState") } as unknown as import("vscode").ExtensionContext).catch(error => { lines.push(`ACTIVATION ERROR ${(error as Error).stack}`); });
		await until('the project opens', () => lines.some(line => line === `project: ${project}`));
		assert.ok(state.chat?.onChange, 'the activation built its ChatService with onChange');
		// No Chat owns the folder yet: a local project, not wired to a session.
		assert.equal(lines.some(line => line.includes('\'s project (')), false);
		// A Chat sends its first message and binds the folder (ChatService: `bound to`, then onChange).
		state.owner = { key: 'pine-computer:/session-later', label: 'Later', folder: project };
		state.chat!.onChange!('pine-computer:/session-later');
		await until('the window is wired to the Chat that bound its folder', () => lines.some(line => line.endsWith(`Later's project (${project})`)));
		const before = state.refreshes;
		arrive('episodes/EP001/multi_panel_storyboard/seg01/line-art/v1/image-1.jpg');
		await until('the canvas refreshes after the files arrive', () => state.refreshes > before, 3000);
	} finally {
		extension?.deactivate();
		hook.deregister();
		if (previousHome === undefined) { delete process.env.HOME; } else { process.env.HOME = previousHome; }
	}
});
