import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type * as vscode from 'vscode';

const shown: unknown[][] = [];
const native = {
	commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
	window: {
		showInformationMessage: async (...args: unknown[]) => { shown.push(args); },
		showWarningMessage: async (...args: unknown[]) => { shown.push(args); },
		showErrorMessage: async (...args: unknown[]) => { shown.push(args); },
	},
};
const symbol = Symbol.for('pine.connection.startup.test');
const globals = globalThis as unknown as Record<symbol, unknown>; globals[symbol] = native;
const hook = registerHooks({
	resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-connection-startup:vscode', shortCircuit: true } : next(name, context),
	load: (url, context, next) => url === 'pine-connection-startup:vscode' ? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("pine.connection.startup.test")]', shortCircuit: true } : next(url, context),
});
let register: typeof import('../pineConnection').registerPineConnection;
try { register = (require('../pineConnection') as typeof import('../pineConnection')).registerPineConnection; }
finally { hook.deregister(); delete globals[symbol]; }

test('a disconnected start shows no notification: it would cover the Chat message box until closed', async () => {
	register({ subscriptions: [] } as unknown as vscode.ExtensionContext, { kind: 'disconnected' }, {} as never, () => {}, () => {}, () => true, () => undefined);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(shown, []);
});
