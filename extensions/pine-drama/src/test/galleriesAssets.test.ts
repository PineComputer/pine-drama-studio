import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { DramaProject } from '../core/project';
import type { Snapshot } from '../core/protocol';

// The asset grids as galleries.ts wires them, with the workbench stubbed: the one editor the three kinds share, and
// the tabs it closes. The drama is the protocol fixture (test-fixtures/protocol/README.md): Lin, the office, the umbrella.
const FIXTURES = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, 'snapshot-project.json'), 'utf8')) as Snapshot;

const disposable = () => ({ dispose() {} });
const commands = new Map<string, (...args: unknown[]) => unknown>();
type Panel = { visible: boolean; active: boolean; title: string; posted: unknown[]; receive?: (message: unknown) => Promise<void>; webview: Record<string, unknown> };
const panels: Panel[] = [];
const uri = (path: string) => ({ fsPath: path, path, toString: () => `file://${path}` });
const native = {
	Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(join(base.fsPath, ...parts)) },
	ViewColumn: { Active: -1 },
	commands: {
		registerCommand: (name: string, command: (...args: unknown[]) => unknown) => { commands.set(name, command); return disposable(); },
		executeCommand: async () => undefined,
	},
	TabInputWebview: class {},
	ThemeIcon: class { constructor(public id: string) {} },
	window: {
		tabGroups: { all: [], close: async () => true },
		registerWebviewPanelSerializer: disposable,
		createWebviewPanel: (_type: string, title: string) => {
			const panel: Panel = { visible: true, active: true, title, posted: [], webview: {} };
			let html = '';
			panel.webview = {
				cspSource: 'vscode-resource:', options: {},
				// As a webview does, a new page loads and says it is ready (gallery.tsx posts 'ready' on mount).
				get html() { return html; },
				set html(text: string) { html = text; },
				asWebviewUri: (u: { fsPath: string }) => uri(u.fsPath),
				postMessage: async (message: unknown) => { panel.posted.push(message); return true; },
				onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => { panel.receive = listener; return disposable(); },
			};
			panels.push(panel);
			return { ...panel, get visible() { return panel.visible; }, get active() { return panel.active; }, webview: panel.webview,
				onDidDispose: disposable, onDidChangeViewState: disposable, reveal() {}, dispose() {}, set title(t: string) { panel.title = t; }, get title() { return panel.title; } };
		},
	},
};
const symbol = Symbol.for('pine.galleries.assets.test');
const globals = globalThis as unknown as Record<symbol, unknown>;
globals[symbol] = native;
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-galleries-assets:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-galleries-assets:vscode'
		? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.galleries.assets.test")]', shortCircuit: true } : next(url, context),
});
let registerGalleries: typeof import('../galleries').registerGalleries;
try { registerGalleries = (require('../galleries') as typeof import('../galleries')).registerGalleries; }
finally { hook.deregister(); }

/** A copy of the fixture's folder, so nothing writes into the fixture. */
function project(): string {
	const root = mkdtempSync(join(tmpdir(), 'assets-page-'));
	cpSync(join(FIXTURES, 'drama'), root, { recursive: true });
	return root;
}

test('characters, scenes and props share one editor: another kind replaces its content, as the preview editor does', async () => {
	const root = project();
	const views = { project: new DramaProject(root, () => [{ scope: 'project', snapshot: SNAPSHOT }]), follow() {}, followActive() {}, inspect: async () => undefined } as unknown as Parameters<typeof registerGalleries>[1];
	const context = { subscriptions: [] as { dispose(): void }[], extensionUri: uri('/ext'), globalStorageUri: uri(join(root, '.storage')) } as unknown as vscode.ExtensionContext;
	registerGalleries(context, views, { appendLine() {} } as unknown as vscode.OutputChannel);
	try {
		const before = panels.length;
		await commands.get('pineDrama.openGallery')!('characters');
		await commands.get('pineDrama.openGallery')!('scenes');
		await commands.get('pineDrama.openGallery')!('scenes');
		assert.equal(panels.length, before + 1, 'one editor for every kind');
		const panel = panels.at(-1)!;
		assert.equal(panel.title, 'scenes');
		await panel.receive!({ v: 2, type: 'ready' });
		const page = panel.posted.at(-1) as { type: string; title: string; sections: { tiles: { stagePath: string }[] }[] };
		assert.deepEqual([page.type, page.title, page.sections[0].tiles.map(tile => tile.stagePath)], ['page', 'scenes', ['assets/scenes/office', 'assets/scenes/street']], 'it reads the kind it shows now');
		// 2. Assets is no page: the command opens nothing for it.
		await commands.get('pineDrama.openGallery')!('assets');
		assert.equal(panels.length, before + 1);
	} finally {
		for (const d of context.subscriptions) { d.dispose(); }
	}
});

test('restored tabs this build cannot serve close at once, leaving one grid: the removed Production assets page, a detail page, a second grid', async () => {
	const root = project();
	const webview = (label: string) => ({ label, input: Object.assign(new native.TabInputWebview(), { viewType: 'mainThreadWebview-pineDrama.gallery' }) });
	const tabs = [webview('Production assets'), webview('characters'), webview('scenes'), webview('LIAM'), { label: 'notes.md', input: {} }];
	const closed: string[] = [];
	const before = native.window.tabGroups;
	native.window.tabGroups = { all: [{ tabs }], close: async (list: { label: string }[]) => { closed.push(...list.map(tab => tab.label)); return true; } } as unknown as typeof before;
	const views = { project: new DramaProject(root, () => [{ scope: 'project', snapshot: SNAPSHOT }]), follow() {}, followActive() {}, inspect: async () => undefined } as unknown as Parameters<typeof registerGalleries>[1];
	const context = { subscriptions: [] as { dispose(): void }[], extensionUri: uri('/ext'), globalStorageUri: uri(join(root, '.storage')) } as unknown as vscode.ExtensionContext;
	try {
		registerGalleries(context, views, { appendLine() {} } as unknown as vscode.OutputChannel);
		await new Promise(setImmediate);
		assert.deepEqual(closed, ['Production assets', 'LIAM', 'scenes']);
	} finally {
		native.window.tabGroups = before;
		for (const d of context.subscriptions) { d.dispose(); }
	}
});

