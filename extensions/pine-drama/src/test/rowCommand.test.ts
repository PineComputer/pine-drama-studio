import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { OutlineNode } from '../core/project';

// projectViews imports vscode; what a row opens reads none of it, so an empty module stands in while it loads.
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-row-command:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-row-command:vscode' ? { format: 'commonjs', source: 'module.exports = {}', shortCircuit: true } : next(url, context),
});
let rowCommand: typeof import('../projectViews').rowCommand;
try { rowCommand = (require('../projectViews') as typeof import('../projectViews')).rowCommand; }
finally { hook.deregister(); }

const file = { uri: 'file:///p/screenplay/v1/screenplay.fountain' };

test('a kind opens its grid on click or Enter; 2. Assets, like any group with nothing to open, only expands (the person, 2026-11-08)', () => {
	const group = (id: string, role: OutlineNode['role'], hasChildren: boolean): OutlineNode => ({ id, label: id, kind: 'group', role, hasChildren });
	assert.equal(rowCommand(group('#assets', 'assets', true)), undefined);
	assert.deepEqual(rowCommand(group('assets/characters', 'characters', true)), { command: 'pineDrama.openGallery', title: 'Open', arguments: ['characters'] });
	assert.equal(rowCommand(group('#episodes', 'episodes', true)), undefined);
});

test('in the empty New Project folder only the next action opens something; the galleries register with the config', () => {
	const group = (id: string, role: OutlineNode['role']): OutlineNode => ({ id, label: id, kind: 'group', role, hasChildren: true });
	assert.equal(rowCommand(group('#assets', 'assets'), false), undefined);
	assert.equal(rowCommand(group('assets/characters', 'characters'), false), undefined);
	const next = { id: 'note:script-attach', label: 'Attach', kind: 'group', role: 'note', hasChildren: false } as const;
	assert.equal(rowCommand(next, false)?.command, 'pineDrama.openSessionProject');
	assert.equal(rowCommand(group('assets/characters', 'characters'), true)?.command, 'pineDrama.openGallery');
});

// A row that stands for a file opens it with the editor's own open, as the Explorer does: 1. Script the screenplay, a
// stage its approved version.
test('a file row opens its file with vscode.open; a character or a location opens the assets canvas on it', () => {
	const script: OutlineNode = { id: 'screenplay', label: '1. Script', kind: 'stage', role: 'script', stagePath: 'screenplay', hasChildren: true };
	assert.deepEqual(rowCommand(script, true, file), { command: 'vscode.open', title: 'Open', arguments: [file.uri, { preview: true }] });
	const lin: OutlineNode = { id: 'assets/characters/lin', label: 'Lin', kind: 'stage', role: 'character', stagePath: 'assets/characters/lin', hasChildren: false };
	assert.deepEqual(rowCommand(lin, true, file), { command: 'pineDrama.openAssetsCanvas', title: 'Open in the assets canvas', arguments: ['assets/characters/lin'] });
});

// The person, 650: a Script episode with no breakdown yet did nothing when clicked; then, once broken down, it opened
// its breakdown (#73: "我要看的是script，总给我看breakdown，breakdown在下边啊"). A row under 1. Script opens the screenplay at
// its episode's section, before and after the breakdown; the breakdown is 3. Episodes'.
test('a Script episode opens the screenplay at its section, before its breakdown and after', () => {
	const before: OutlineNode = { id: '#script/EP002', label: 'EP002', kind: 'group', role: 'script-episode', hasChildren: false, episode: 'episodes/EP002' };
	const after: OutlineNode = { id: 'episodes/EP002/breakdown', label: 'EP002', kind: 'stage', role: 'breakdown', stagePath: 'episodes/EP002/breakdown', hasChildren: false, episode: 'episodes/EP002' };
	const at = { start: { line: 7, character: 0 }, end: { line: 7, character: 0 } };
	for (const row of [before, after]) {
		assert.deepEqual(rowCommand(row, true, { ...file, line: 7 }), { command: 'vscode.open', title: 'Open', arguments: [file.uri, { preview: true, selection: at }] });
	}
});
