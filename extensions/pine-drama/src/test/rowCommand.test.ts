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

test('a kind opens its grid on click or Enter; 2. Assets, like any group with nothing to open, only expands (the person, 2026-11-08)', () => {
	const group = (id: string, role: OutlineNode['role'], hasChildren: boolean): OutlineNode => ({ id, label: id, kind: 'group', role, hasChildren });
	assert.equal(rowCommand(group('#assets', 'assets', true)), undefined);
	const characters = group('assets/characters', 'characters', true);
	assert.deepEqual(rowCommand(characters), { command: 'pineDrama.openNode', title: 'Open', arguments: [characters] });
	assert.equal(rowCommand(group('#episodes', 'episodes', true)), undefined);
});

test('in the empty New Project folder only the next action opens something; the galleries register with the config', () => {
	const group = (id: string, role: OutlineNode['role']): OutlineNode => ({ id, label: id, kind: 'group', role, hasChildren: true });
	assert.equal(rowCommand(group('#assets', 'assets'), false), undefined);
	assert.equal(rowCommand(group('assets/characters', 'characters'), false), undefined);
	const next = { id: 'note:script-attach', label: 'Attach', kind: 'group', role: 'note', hasChildren: false } as const;
	assert.equal(rowCommand(next, false)?.command, 'pineDrama.openSessionProject');
	assert.equal(rowCommand(group('assets/characters', 'characters'), true)?.command, 'pineDrama.openNode');
});

// The person, 650: a Script episode with no breakdown yet did nothing when clicked. It opens the screenplay, as the
// Script row does; once broken down it is its breakdown stage and opens the shot list (openNode).
test('a Script episode opens the screenplay before its breakdown, and its shot list after', () => {
	const before: OutlineNode = { id: '#script/EP002', label: 'EP002 · The Bone-Veil Brides', kind: 'group', role: 'script-episode', hasChildren: false };
	assert.deepEqual(rowCommand(before), { command: 'pineDrama.openScript', title: 'Open the screenplay' });
	const after: OutlineNode = { id: 'episodes/EP002/breakdown', label: 'EP002 · The Bone-Veil Brides', kind: 'stage', role: 'breakdown', stagePath: 'episodes/EP002/breakdown', hasChildren: false };
	assert.equal(rowCommand(after)?.command, 'pineDrama.openNode');
});
