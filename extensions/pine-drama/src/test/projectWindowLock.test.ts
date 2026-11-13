import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectWindowLockDirectory, projectWindowLockFile, lockProjectWindow } from '../core/projectWindowLock';

// One Studio window per project. The lock is the OS's own file lock,
// held by SQLite's BEGIN EXCLUSIVE; these tests use real processes, so a crash is a real SIGKILL.

function place() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'pine-lock-')));
	const root = join(base, 'project');
	mkdirSync(root);
	return { base, root, directory: projectWindowLockDirectory(join(base, 'home')) };
}

/** A real process that takes the lock and holds it until it is killed or its stdin closes. */
function contender(root: string, directory: string): { child: ChildProcess; result: Promise<string> } {
	const module = join(__dirname, '..', 'core', 'projectWindowLock.js');
	const script = `const { lockProjectWindow } = require(${JSON.stringify(module)});
const lock = lockProjectWindow(${JSON.stringify(root)}, ${JSON.stringify(directory)});
process.stdout.write(lock.kind + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`;
	const child = spawn(process.execPath, ['--no-warnings', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
	const result = new Promise<string>((resolve, reject) => {
		let out = '';
		child.stdout!.on('data', chunk => { out += chunk; if (out.includes('\n')) { resolve(out.trim()); } });
		child.once('exit', code => reject(new Error(`contender exited ${code} before it answered`)));
	});
	return { child, result };
}

function exited(child: ChildProcess): Promise<void> {
	return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', () => resolve()));
}

test('a second taker of a project window lock is refused at once, and gets it once the first releases it', () => {
	const { root, directory } = place();
	const first = lockProjectWindow(root, directory);
	assert.equal(first.kind, 'held');
	assert.equal(lockProjectWindow(root, directory).kind, 'elsewhere');
	if (first.kind === 'held') { first.release(); first.release(); }
	const again = lockProjectWindow(root, directory);
	assert.equal(again.kind, 'held');
	if (again.kind === 'held') { again.release(); }
	// The file is never deleted: one deleted while held would let a second holder in.
	assert.ok(existsSync(first.file));
});

test('every path to one folder names one lock: a symlink to the project is refused while the project is held', () => {
	const { base, root, directory } = place();
	const link = join(base, 'link');
	symlinkSync(root, link);
	assert.equal(projectWindowLockFile(directory, link), projectWindowLockFile(directory, root));
	const held = lockProjectWindow(root, directory);
	assert.equal(lockProjectWindow(link, directory).kind, 'elsewhere');
	if (held.kind === 'held') { held.release(); }
	// Nothing is written in the project: the lock file is in the per-user directory.
	assert.deepEqual(readdirSync(root), []);
	assert.equal(readdirSync(directory).length, 1);
});

test('a lock that fails for another reason throws: it is never read as held elsewhere', () => {
	const { root, directory } = place();
	mkdirSync(directory, { recursive: true });
	writeFileSync(projectWindowLockFile(directory, root), 'not an SQLite database, so BEGIN EXCLUSIVE fails with SQLITE_NOTADB, not SQLITE_BUSY\n'.repeat(8));
	assert.throws(() => lockProjectWindow(root, directory), /file is not a database/);
});

test('two real processes: the second is refused while the first holds the lock; kill -9 of the holder releases it', async () => {
	const { root, directory } = place();
	const holder = contender(root, directory);
	try {
		assert.equal(await holder.result, 'held');
		const second = contender(root, directory);
		assert.equal(await second.result, 'elsewhere');
		second.child.stdin!.end();
		await exited(second.child);
		assert.equal(lockProjectWindow(root, directory).kind, 'elsewhere');
		holder.child.kill('SIGKILL');
		await exited(holder.child);
		assert.equal(holder.child.signalCode, 'SIGKILL');
		const after = lockProjectWindow(root, directory);
		assert.equal(after.kind, 'held', 'the OS released the killed holder\'s lock');
		if (after.kind === 'held') { after.release(); }
	} finally {
		holder.child.kill('SIGKILL');
	}
});

test('processes that start together: exactly one holds the lock', async () => {
	const { root, directory } = place();
	const all = Array.from({ length: 8 }, () => contender(root, directory));
	try {
		const results = await Promise.all(all.map(c => c.result));
		assert.equal(results.filter(r => r === 'held').length, 1, results.join(', '));
		assert.equal(results.filter(r => r === 'elsewhere').length, 7, results.join(', '));
	} finally {
		for (const c of all) { c.child.kill('SIGKILL'); }
		await Promise.all(all.map(c => exited(c.child)));
	}
});

/** extension.ts loaded against a recording stand-in for the whole vscode API: every property read is noted. */
function standIn(root: string) {
	const touched: string[] = [];
	const warnings: string[] = [];
	const lines: string[] = [];
	const known: Record<string, unknown> = {
		'workspace.workspaceFolders': [{ uri: { scheme: 'file', fsPath: root } }],
		'window.createOutputChannel': () => ({ appendLine: (line: string) => lines.push(line), show() {}, dispose() {} }),
		'window.showWarningMessage': (text: string) => { warnings.push(text); return Promise.resolve(undefined); },
		'env.appName': 'Pine Drama Studio (test)',
		'version': '0.0.0-test',
	};
	const state = { recording: false };
	const deep = (path: string): unknown => new Proxy(function stub() { /* stand-in */ }, {
		get: (_target, prop) => {
			if (typeof prop === 'symbol' || prop === 'then') { return undefined; }
			const at = path ? `${path}.${prop}` : prop;
			if (state.recording) { touched.push(at); }
			return at in known ? known[at] : deep(at);
		},
		apply: () => deep(`${path}()`),
		construct: () => deep(`new ${path}`) as object,
	});
	const symbol = Symbol.for('pine.lock.native.test');
	const globals = globalThis as Record<symbol, unknown>;
	globals[symbol] = deep('');
	const hook = registerHooks({
		resolve: (name, context, next) => name === 'vscode' ? { url: 'pine-lock-test:vscode', shortCircuit: true } : next(name, context),
		load: (url, context, next) => url === 'pine-lock-test:vscode' ? { format: 'commonjs', source: 'module.exports = new Proxy({}, { get: (_target, prop) => globalThis[Symbol.for("pine.lock.native.test")][prop] })', shortCircuit: true } : next(url, context),
	});
	// extension.js is loaded once per process; its `vscode` forwards to the stand-in of the test that runs.
	let extension: typeof import('../extension');
	try { extension = require('../extension') as typeof import('../extension'); } finally { hook.deregister(); }
	return {
		extension, touched, warnings, lines, state, deep,
		/** Each API reached, without the namespaces read on the way to it. */
		reached: () => [...new Set(touched)].filter(at => !touched.some(other => other.startsWith(`${at}.`))).sort(),
		dispose: () => { delete globals[symbol]; },
	};
}

test('a window whose project is held elsewhere loads nothing for the project and says so in one line', async () => {
	const { base, root } = place();
	const previousHome = process.env.HOME;
	process.env.HOME = join(base, 'home'); // projectWindowLockDirectory() reads the home directory: the test never writes the person's
	const held = lockProjectWindow(root);
	assert.equal(held.kind, 'held');
	const api = standIn(root);
	try {
		const subscriptions: unknown[] = [];
		api.state.recording = true;
		await api.extension.activate({ subscriptions, extensionPath: base, globalStorageUri: { fsPath: join(base, 'storage') }, secrets: api.deep('secrets'), extensionMode: 1 } as unknown as import('vscode').ExtensionContext);
		api.state.recording = false;
		assert.deepEqual(api.warnings, ['Pine: This project is open in another Studio window. This window loads nothing for it.']);
		assert.deepEqual(api.reached(), ['env.appName', 'version', 'window.createOutputChannel', 'window.showWarningMessage', 'workspace.workspaceFolders'],
			'nothing but the output channel, the folder and the one line');
		assert.equal(subscriptions.length, 1, 'only the output channel');
		assert.ok(api.lines.some(line => line.includes('is open in another Studio window')));
		assert.ok(!existsSync(join(base, 'storage')), 'no conversation store was opened');
		api.extension.deactivate();
	} finally {
		api.state.recording = false;
		api.dispose();
		if (held.kind === 'held') { held.release(); }
		if (previousHome === undefined) { delete process.env.HOME; } else { process.env.HOME = previousHome; }
	}
});
