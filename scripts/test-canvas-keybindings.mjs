// Uses the pinned host's actual context-expression evaluator, not a replacement parser.
// Run after compiling Code-OSS: VSCODE_DIR=/path/to/vscode node scripts/test-canvas-keybindings.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = process.env.VSCODE_DIR ?? resolve(studio, '../vscode');
const { ContextKeyExpr } = await import(pathToFileURL(resolve(native, 'out/vs/platform/contextkey/common/contextkey.js')).href);
const manifest = JSON.parse(readFileSync(resolve(studio, 'extensions/pine-drama/package.json'), 'utf8'));
const bindings = manifest.contributes.keybindings.filter(binding => binding.command.startsWith('pineDrama.canvas.'));
assert(bindings.some(binding => binding.command === 'pineDrama.canvas.selectAll' && binding.mac === 'cmd+a'));
for (const binding of bindings) {
  const expression = ContextKeyExpr.deserialize(binding.when);
  assert(expression, `${binding.command}: valid native context expression`);
  for (const [panel, input, textInput, expected] of [
    ['pineDrama.episodeCanvas', true, false, false], // Canvas stays active while Chat has input focus.
    ['pineDrama.episodeCanvas', false, true, false], // Native EditContext rich input has a distinct focus key.
    ['pineDrama.episodeCanvas', false, false, true],
    ['other-view', true, true, false],
    ['other-view', false, false, false],
  ]) {
    const context = { getValue: key => ({ activeWebviewPanelId: panel, inputFocus: input, textInputFocus: textInput })[key] };
    assert.equal(expression.evaluate(context), expected, `${binding.command}: panel=${panel}, inputFocus=${input}, textInputFocus=${textInput}`);
  }
}
console.log(`PASS: ${bindings.length} canvas shortcuts; native input focus yields, canvas focus retains them.`);
