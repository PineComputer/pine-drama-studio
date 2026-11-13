import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// A menu entry whose `viewItem` no tree item ever carries is dead: it never shows (vscode.d.ts, TreeItem.contextValue).
// The screenplay review's `pineScreenplay` entry outlived its tree this way (fix plan, item 15a).
const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	contributes: { commands: { command: string }[]; menus: Record<string, { command: string; when?: string }[]> };
};
const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
	.filter(f => f.endsWith('.ts') && !f.startsWith('test') && !f.startsWith('typings'))
	.map(f => readFileSync(join(root, 'src', f), 'utf8')).join('\n');

test('every viewItem a menu names is a word some tree item carries in its contextValue', () => {
	const named = Object.values(manifest.contributes.menus).flat().flatMap(entry =>
		[...(entry.when ?? '').matchAll(/viewItem\s*(?:==\s*([\w-]+)|=~\s*\/([^/]+)\/)/g)].flatMap(m =>
			(m[1] ?? m[2].replace(/\\b/g, ' ')).match(/[\w-]+/g)!.map(word => ({ command: entry.command, word }))));
	assert.ok(named.length > 0, 'the manifest names view items');
	const unproduced = named.filter(({ word }) => !new RegExp(`['"\`][^'"\`\\n]*\\b${word}\\b`).test(sources));
	assert.deepEqual(unproduced, []);
});

// A contributed command with no handler is dead too: the palette lists it and running it fails ("command not found").
// `pineDrama.script.reveal` once outlived its handler this way.
test('every contributed command is registered by the extension', () => {
	const constants = new Map([...sources.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
	const registered = new Set([...sources.matchAll(/registerCommand\(\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)\b)/g)].map(m => m[1] ?? constants.get(m[2])));
	assert.ok(registered.size > 10, 'the extension registers its commands');
	// A family registered from a template, `pineDrama.canvas.${name}` over a list of names (episodeCanvas.ts).
	const families = [...sources.matchAll(/registerCommand\(\s*`([^`$]+)\$\{/g)].map(m => m[1]);
	const inFamily = (id: string) => families.some(prefix => id.startsWith(prefix) && sources.includes(`'${id.slice(prefix.length)}'`));
	assert.deepEqual(manifest.contributes.commands.map(c => c.command).filter(id => !registered.has(id) && !inFamily(id)), []);
});
