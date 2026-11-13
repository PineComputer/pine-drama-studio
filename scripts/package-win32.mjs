#!/usr/bin/env node
// Package Pine Drama Studio for Windows x64: the unsigned app folder, and what Inno Setup needs to wrap it, for
// scripts/release-win32.mjs to sign and turn into the installer. The macOS twin is scripts/package-macos.sh.
//
//   node scripts/package-win32.mjs     writes dist/win32-x64/: app/ (the app folder), inno/ (the installer's inputs)
//                                      and build-info.json
//
// Runs on Windows (.github/workflows/release-win32.yml), with VSCODE_DIR (default ../vscode) at the pinned commit plus
// our patch series (scripts/upstream-setup.sh) and its dependencies installed (npm ci, as upstream's Windows build does).

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { COPYRIGHT_HOLDER, PUBLISHER } from './release-win32.mjs';

const STUDIO = resolve(import.meta.dirname, '..');
const VSCODE = resolve(process.env.VSCODE_DIR ?? join(STUDIO, '..', 'vscode'));
const EXT = join(STUDIO, 'extensions', 'pine-drama');
const ARCH = 'x64';
// Upstream's packaging target for Windows (build/gulpfile.vscode.ts, BUILD_TARGETS), minified for a release.
const TARGET = `vscode-win32-${ARCH}-min`;
const DIST = join(STUDIO, 'dist', `win32-${ARCH}`);
const ICON = join(STUDIO, 'upstream', 'icons', 'pine-drama-studio.ico');
// Upstream stamps Microsoft's name into the executables' version information (build/lib/electron.ts `companyName` and
// `copyright`; build/gulpfile.vscode.ts patchWin32DependenciesTask), which Explorer's Properties show; ours replaces it
// below, as package-macos.sh rewrites Info.plist's copyright.
const COPYRIGHT = `Copyright (C) ${new Date().getUTCFullYear()} ${COPYRIGHT_HOLDER}`;
const vscodeRequire = createRequire(join(VSCODE, 'package.json'));

const version = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8')).version;
// npm is npm.cmd on Windows, which only a shell runs (Node's child_process, "Spawning .bat and .cmd files on Windows").
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', shell: process.platform === 'win32' && /^np[mx]$/.test(file), ...options });
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
// Every file below a folder, by its path relative to it with '/' separators.
const filesBelow = root => readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
	.map(e => join(e.parentPath, e.name).slice(root.length + 1).replaceAll('\\', '/'));

// A build people get is made from committed files only, so build-info.json names what it holds.
const changed = git(['-C', STUDIO, 'status', '--porcelain', '--', 'extensions/pine-drama', 'upstream', 'scripts/package-win32.mjs']);
if (changed) {
	throw new Error(`refused: uncommitted changes in what the app is built from:\n${changed}`);
}
rmSync(DIST, { recursive: true, force: true });

// 1. The product overlay: Pine's product fields, and only the built-in extensions on the allowlist (package-macos.sh, 2).
const productFile = join(VSCODE, 'product.json');
const allow = new Set(readFileSync(join(STUDIO, 'upstream', 'builtin-extensions.allow'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
const product = { ...JSON.parse(readFileSync(productFile, 'utf8')), ...JSON.parse(readFileSync(join(STUDIO, 'upstream', 'product.package.json'), 'utf8')) };
product.builtInExtensions = (product.builtInExtensions || []).filter(e => allow.has(e.name));
writeFileSync(productFile, JSON.stringify(product, null, '\t') + '\n');
// GitHub Copilot is packaged by a task of its own, which skips a missing extensions/copilot (package-macos.sh, 2).
rmSync(join(VSCODE, 'extensions', 'copilot'), { recursive: true, force: true });

// 2. Upstream's packaging target, then its inno updater (build/azure-pipelines/win32/steps/product-build-win32-compile.yml,
// "Build client"). The commit goes to product.json as in package-macos.sh, 3.
const commit = git(['-C', VSCODE, 'rev-parse', 'HEAD']);
const gulpEnv = { ...process.env, BUILD_SOURCEVERSION: commit };
run('npm', ['run', 'gulp', '--', TARGET], { cwd: VSCODE, env: gulpEnv });
run('npm', ['run', 'gulp', '--', `vscode-win32-${ARCH}-inno-updater`], { cwd: VSCODE, env: gulpEnv });
const OUT = join(dirname(VSCODE), `VSCode-win32-${ARCH}`);
// No versioned resources folder: product.json sets no win32VersionedUpdate (build/lib/util.ts getVersionedResourcesFolder).
const appRoot = join(OUT, 'resources', 'app');
const exe = join(OUT, `${product.nameShort}.exe`);
for (const path of [exe, join(appRoot, 'product.json'), join(OUT, 'tools', 'inno_updater.exe')]) {
	if (!existsSync(path)) {
		throw new Error(`packaging wrote no ${path}`);
	}
}

// 3. Leave out what the allowlist does not keep, then add our built-in extension (package-macos.sh, 4 and stage_extension).
for (const name of readdirSync(join(appRoot, 'extensions'))) {
	const manifest = join(appRoot, 'extensions', name, 'package.json');
	if (existsSync(manifest)) {
		const { publisher, name: id } = JSON.parse(readFileSync(manifest, 'utf8'));
		if (!allow.has(`${publisher}.${id}`)) {
			rmSync(join(appRoot, 'extensions', name), { recursive: true });
		}
	}
}
run('npm', ['run', '--silent', 'compile'], { cwd: EXT });
const stage = join(DIST, 'stage', 'pine-drama');
mkdirSync(stage, { recursive: true });
for (const item of ['package.json', 'package-lock.json', 'media', 'syntaxes', 'protocol']) {
	cpSync(join(EXT, item), join(stage, item), { recursive: true });
}
// A release ships the extension as one minified bundle, without comments or source maps (package-macos.sh, stage_extension).
run('npx', ['--no-install', 'esbuild', 'src/extension.ts', '--bundle', '--platform=node', '--format=cjs', '--target=node20',
	'--packages=external', '--external:vscode', '--minify', '--legal-comments=none', '--log-level=warning', `--outfile=${join(stage, 'out', 'extension.js')}`], { cwd: EXT });
// Its production dependencies for this platform: npm's --cpu and --os choose an optional native package (npm install).
run('npm', ['ci', '--omit=dev', `--cpu=${ARCH}`, '--os=win32', '--no-audit', '--no-fund'], { cwd: stage });
rmSync(join(stage, 'package-lock.json'));
rmSync(join(appRoot, 'extensions', 'pine-drama'), { recursive: true, force: true });
cpSync(stage, join(appRoot, 'extensions', 'pine-drama'), { recursive: true });
rmSync(join(DIST, 'stage'), { recursive: true });

// 4. No source maps in a release (package-macos.sh: upstream publishes its own to a CDN instead).
for (const rel of filesBelow(join(appRoot, 'out')).filter(f => f.endsWith('.map'))) {
	rmSync(join(appRoot, 'out', rel));
}

// 5. The icon and the version information Explorer shows: the app's and the inno updater's icon (upstream sets
// resources/win32/code.ico on both: build/lib/electron.ts `winIcon`, gulpfile.vscode.win32.ts updateIcon), the Studio's
// version as the product version, and our name where upstream wrote Microsoft's, on the app and on the files
// patchWin32DependenciesTask stamps (its own list, build/gulpfile.vscode.ts).
const rcedit = promisify(vscodeRequire('rcedit'));
const ours = { CompanyName: PUBLISHER, LegalCopyright: COPYRIGHT };
await rcedit(exe, { icon: ICON, 'product-version': version, 'version-string': { ...ours, ProductName: product.nameLong, FileDescription: product.nameLong, ProductVersion: version } });
await rcedit(join(OUT, 'tools', 'inno_updater.exe'), { icon: ICON });
const stamped = filesBelow(OUT).filter(f => (/\.node$/.test(f) && !f.startsWith('resources/app/extensions/node_modules/@parcel/watcher/'))
	|| /(^|\/)(rg|tgrep)\.exe$/.test(f) || /explorer_command[^/]*\.dll$/.test(f) || /(^|\/)OneAuthInterop\.dll$/.test(f));
for (const rel of stamped) {
	await rcedit(join(OUT, rel), { 'version-string': ours });
}

// 6. Code-OSS refuses a changed install when a file product.json lists under `checksums` no longer hashes as recorded
// (package-macos.sh, verify_checksums): nothing above may change those files.
const sums = JSON.parse(readFileSync(join(appRoot, 'product.json'), 'utf8')).checksums || {};
const bad = Object.entries(sums).filter(([rel, want]) => createHash('sha256').update(readFileSync(join(appRoot, 'out', rel))).digest('base64').replace(/=+$/, '') !== want);
if (!Object.keys(sums).length || bad.length) {
	throw new Error(`product.json checksums: ${Object.keys(sums).length ? `mismatch in ${bad.map(([rel]) => rel).join(', ')}` : 'none'}`);
}
if (!JSON.parse(readFileSync(join(appRoot, 'product.json'), 'utf8')).commit) {
	throw new Error('product.json has no commit');
}

// 7. The app folder, and the installer's inputs as build/gulpfile.vscode.win32.ts buildWin32Setup reads them from the
// Code-OSS tree: build/win32 (code.iss and its messages), resources/win32 (the wizard's pictures and the icon, ours in
// place of code.ico), the license the wizard shows (ours, at the name code.iss looks for), Inno Setup itself (the
// innosetup package, whose bin/ISCC.exe the gulp task runs) and the Node version the release step runs on.
cpSync(OUT, join(DIST, 'app'), { recursive: true });
const inno = join(DIST, 'inno');
cpSync(join(VSCODE, 'build', 'win32'), join(inno, 'build', 'win32'), { recursive: true });
cpSync(join(VSCODE, 'resources', 'win32'), join(inno, 'resources', 'win32'), { recursive: true });
cpSync(ICON, join(inno, 'resources', 'win32', 'code.ico'));
cpSync(join(STUDIO, 'LICENSE'), join(inno, 'LICENSE.txt'));
cpSync(dirname(dirname(vscodeRequire.resolve('innosetup'))), join(inno, 'innosetup'), { recursive: true });
cpSync(join(VSCODE, '.nvmrc'), join(DIST, '.nvmrc'));
const studio = git(['-C', STUDIO, 'rev-parse', '--short', 'HEAD']);
const base = readFileSync(join(STUDIO, 'upstream', 'vscode.lock'), 'utf8').match(/^base=(\w+)$/m)[1];
const patches = readdirSync(join(STUDIO, 'upstream', 'patches')).filter(f => f.endsWith('.patch')).length;
writeFileSync(join(DIST, 'build-info.json'), JSON.stringify({
	target: TARGET, version, builtFrom: `studio ${studio}, Code-OSS ${base.slice(0, 11)} + ${patches} patch(es)`, extensionFrom: studio,
	at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
}, null, '\t') + '\n');
console.log(`packaged ${TARGET} ${version} into ${DIST}`);
