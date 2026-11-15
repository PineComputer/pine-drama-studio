import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { git } from '../core/git';

const commands = new Map<string, (...args: (string | undefined)[]) => Promise<void>>();
const calls: unknown[][] = [];
let folders: { uri: { fsPath: string } }[] | undefined;
let workspaceFile: object | undefined;
let picked: string;
let cancelled = false;
const errors: string[] = [];
const infos: unknown[][] = [];
let answer: string | undefined;
const dialogs: vscode.OpenDialogOptions[] = [];
const warnings: string[] = [];
const native = {
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	workspace: { get workspaceFolders() { return folders; }, get workspaceFile() { return workspaceFile; } },
	commands: {
		registerCommand: (id: string, handler: (...args: (string | undefined)[]) => Promise<void>) => { commands.set(id, handler); return { dispose() {} }; },
		executeCommand: async (...args: unknown[]) => { calls.push(args); },
	},
	window: {
		showSaveDialog: async () => { assert.fail('New Project chooses a folder; it never saves a new name inside one'); },
		showInputBox: async () => { assert.fail('New Project must not ask for a name-only Quick Input'); },
		showOpenDialog: async (options: vscode.OpenDialogOptions) => { dialogs.push(options); return cancelled ? undefined : [{ fsPath: picked }]; },
		showErrorMessage: async (message: string) => { errors.push(message); },
		showWarningMessage: async (message: string) => { warnings.push(message); },
		showInformationMessage: async (...args: unknown[]) => { infos.push(args); return answer; },
	},
};
const symbol = Symbol.for('pine.project.commands.test');
const globals = globalThis as unknown as Record<symbol, unknown>; globals[symbol] = native;
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-project-commands:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-project-commands:vscode' ? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.project.commands.test")]', shortCircuit: true } : next(url, context),
});
let register: typeof import('../projectCommands').registerProjectCommands;
try { register = (require('../projectCommands') as typeof import('../projectCommands')).registerProjectCommands; }
finally { hook.deregister(); delete globals[symbol]; }

// New and Open Project share one opener (projectCommands.ts, `open`), so Open alone checks the window policy.
for (const window of ['empty', 'empty-array', 'folder', 'workspace'] as const) {
	test(`open project ${window === 'empty' || window === 'empty-array' ? 'reuses' : 'preserves'} the ${window} window`, async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-window-policy-')));
		picked = root; calls.length = 0; commands.clear(); errors.length = 0; cancelled = false;
		folders = window === 'empty' ? undefined : window === 'folder' ? [{ uri: { fsPath: root } }] : [];
		workspaceFile = window === 'workspace' ? {} : undefined;
		writeFileSync(join(root, 'pine-drama-project.json'), '{"schema":2}\n');
		register({ subscriptions: [] } as unknown as vscode.ExtensionContext, { appendLine() {} } as unknown as vscode.OutputChannel, undefined);
		await commands.get('pineDrama.openProject')!();
		const preserve = window === 'folder' || window === 'workspace';
		assert.deepEqual(calls, [['vscode.openFolder', { fsPath: root }, { forceNewWindow: preserve, forceReuseWindow: !preserve }]]);
		assert.deepEqual(errors, []);
	});
}

function setup() {
	picked = realpathSync(mkdtempSync(join(tmpdir(), 'pine-entry-cycle-')));
	folders = undefined; workspaceFile = undefined; cancelled = false;
	calls.length = 0; commands.clear(); errors.length = 0; dialogs.length = 0; warnings.length = 0;
	return picked;
}
const context = () => ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;
const output = { appendLine() {} } as unknown as vscode.OutputChannel;

for (const kind of ['new', 'open']) {
	test(`cancelling ${kind} leaves the directory and navigation untouched`, async () => {
		const root = setup(); cancelled = true;
		register(context(), output, undefined);
		await commands.get(`pineDrama.${kind}Project`)!();
		assert.deepEqual(readdirSync(root), []); assert.deepEqual(calls, []); assert.deepEqual(errors, []);
	});
}

// The folder the person chooses is the project.
test('New Project asks for a folder in the native picker, and the empty folder chosen is the drama, with only its pine-drama-project.json made, and committed', async () => {
	const parent = setup(); const root = join(parent, 'long-bai-gu-jing-001'); mkdirSync(root); picked = root;
	register(context(), output, undefined);
	await commands.get('pineDrama.newProject')!();
	assert.deepEqual(dialogs.map(({ title, openLabel, canSelectFolders, canSelectFiles, canSelectMany }) => ({ title, openLabel, canSelectFolders, canSelectFiles, canSelectMany })),
		[{ title: 'New Project', openLabel: 'Create Project', canSelectFolders: true, canSelectFiles: false, canSelectMany: false }]);
	assert.deepEqual(errors, []);
	assert.deepEqual(calls, [['vscode.openFolder', { fsPath: root }, { forceNewWindow: false, forceReuseWindow: true }]]);
	assert.deepEqual(readdirSync(root).sort(), ['.git', 'pine-drama-project.json'], 'no "Untitled Project" or any other folder inside it');
	const log = await git(['log', '--format=%an|%s', '--name-only'], root);
	assert.deepEqual(log.stdout.trim().split('\n').filter(Boolean), ['person|New project', 'pine-drama-project.json'], 'the person\'s first commit');
	assert.deepEqual(readdirSync(parent), ['long-bai-gu-jing-001'], 'nothing made beside it');
});

test('an initialized project opens as it is, whatever its config says: opening writes nothing, the first send validates it', async () => {
	const root = setup(); writeFileSync(join(root, 'pine-drama-project.json'), '{"schema":2}\n');
	register(context(), output, undefined);
	await commands.get('pineDrama.openProject')!();
	assert.deepEqual(errors, []);
	assert.deepEqual(calls, [['vscode.openFolder', { fsPath: root }, { forceNewWindow: false, forceReuseWindow: true }]]);
	assert.equal(readFileSync(join(root, 'pine-drama-project.json'), 'utf8'), '{"schema":2}\n');
});

// New Project made the project in a child, and the person later chose its parent in Open Project.
test('Open Project on the parent of one project offers it; choosing it opens that project the same way', async () => {
	const parent = setup(); infos.length = 0;
	const inner = join(parent, 'Untitled Project'); mkdirSync(inner);
	writeFileSync(join(inner, 'pine-drama-project.json'), '{"schema":2}\n');
	writeFileSync(join(parent, 'notes.txt'), 'the person\'s own file');
	register(context(), output, undefined);
	answer = 'Open Untitled Project';
	await commands.get('pineDrama.openProject')!();
	assert.deepEqual(infos, [[`Pine: ${parent} is not a drama itself; the drama is inside it: ${inner}.`, 'Open Untitled Project']]);
	assert.deepEqual(errors, []);
	assert.deepEqual(calls, [['pineDrama.openProject', inner]], 'nothing opens until the person chooses it');
	calls.length = 0;
	await commands.get('pineDrama.openProject')!(inner);
	assert.deepEqual(calls, [['vscode.openFolder', { fsPath: inner }, { forceNewWindow: false, forceReuseWindow: true }]]);
	answer = undefined; calls.length = 0; infos.length = 0;
	await commands.get('pineDrama.openProject')!();
	assert.deepEqual(calls, [], 'dismissing the offer opens nothing');
	assert.deepEqual(readdirSync(parent).sort(), ['Untitled Project', 'notes.txt']);
});
