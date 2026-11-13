import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { filesToSign, innoDefinitions, PUBLISHER, releaseWin32, validateBuild } from '../release-win32.mjs';

const CREDENTIALS = { ES_USERNAME: 'fixture-user', ES_PASSWORD: 'fixture-password', ES_TOTP_SECRET: 'fixture-totp' };
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PRODUCT = {
	nameShort: 'Pine Drama Studio', nameLong: 'Pine Drama Studio', applicationName: 'pine-drama-studio', quality: 'stable', commit: 'c0ffee',
	win32DirName: 'Pine Drama Studio', win32NameVersion: 'Pine Drama Studio', win32RegValueName: 'PineDramaStudio', win32ShellNameShort: 'Pine &Drama Studio',
	win32MutexName: 'pinedramastudio', win32TunnelMutex: 'pinedramastudio-tunnel', win32TunnelServiceMutex: 'pinedramastudio-tunnelservice',
	tunnelApplicationName: 'pine-drama-studio-tunnel', win32AppUserModelId: '19pine.PineDramaStudio', win32x64AppId: '{{A}', win32x64UserAppId: '{{B}',
};
// The kinds CodeSignTool 1.3.2's batch_sign takes (its BatchSignCommand); it refuses a batch holding any other.
const CODESIGNTOOL_KINDS = ['acm', 'bin', 'cab', 'cat', 'cpl', 'dll', 'drv', 'efi', 'exe', 'jar', 'msi', 'mui', 'nupkg', 'ocx', 'ova', 'ovf', 'ps1', 'ps1xml', 'scr', 'sys', 'tsp', 'vbs', 'wsf'];
const SHIPPED = ['Pine Drama Studio.exe', 'ffmpeg.dll', 'tools/inno_updater.exe', 'resources/app/node_modules/x/build/x.node', 'resources/app/out/y.ps1', 'resources/app/out/README.md'];

test('release refuses a package that is not the minified Windows x64 one, another version, or uncommitted changes', () => {
	const build = { target: 'vscode-win32-x64-min', version: '1.2.3', extensionFrom: 'abc123' };
	validateBuild(build, 'v1.2.3');
	for (const [info, tag] of [[{ ...build, target: 'vscode-win32-x64' }, 'v1.2.3'], [{ ...build, target: 'vscode-darwin-x64-min' }, 'v1.2.3'], [build, 'v1.2.4'], [{ ...build, extensionFrom: 'abc+changes' }, 'v1.2.3']]) {
		assert.throws(() => validateBuild(info, tag));
	}
});

test('the files signed are the kinds Code-OSS signs: executables, libraries, native modules and PowerShell scripts', () => {
	assert.deepEqual(filesToSign(SHIPPED), ['Pine Drama Studio.exe', 'ffmpeg.dll', 'resources/app/node_modules/x/build/x.node', 'resources/app/out/y.ps1', 'tools/inno_updater.exe']);
	assert.deepEqual(filesToSign(['A.EXE', 'b.Psd1', 'c.ps1xml', 'd.psm1', 'e.txt']), ['A.EXE', 'b.Psd1', 'c.ps1xml', 'd.psm1']);
});

test('the installer gets every definition code.iss needs, from the product, for a per-user setup', () => {
	const definitions = innoDefinitions({ product: PRODUCT, version: '1.2.3', commit: 'c0ffee', app: '/a', repo: '/r', output: '/o', productJsonPath: '/o/product.json' });
	for (const [key, value] of Object.entries(definitions)) assert.ok(typeof value === 'string' && (value || key === 'VersionedResourcesFolder'), key);
	assert.equal(definitions.AppId, '{{B}');
	assert.equal(definitions.IncompatibleTargetAppId, '{{A}');
	assert.equal(definitions.InstallTarget, 'user');
	assert.equal(definitions.Version, '1.2.3');
	assert.equal(definitions.NameVersion, 'Pine Drama Studio (User)');
	assert.equal(definitions.Publisher, PUBLISHER);
	assert.equal('AppxPackage' in definitions, false);
});

async function fixture(t, { env = CREDENTIALS, ids = `Credential ID(s): ${ID}`, codesignOutput = 'Code signed successfully', signtool = 'Successfully verified: x\nThe signature is timestamped: Fri Nov 13 10:00:00 2026' } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'pine-release-win32-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const input = join(root, 'win32-x64'), output = join(root, 'release'), tool = join(root, 'codesigntool');
	for (const rel of SHIPPED) {
		await mkdir(join(input, 'app', rel, '..'), { recursive: true });
		await writeFile(join(input, 'app', rel), `unsigned ${rel}`);
	}
	await writeFile(join(input, 'app', 'resources/app/product.json'), JSON.stringify(PRODUCT));
	await mkdir(join(input, 'inno', 'build', 'win32'), { recursive: true });
	await writeFile(join(input, 'build-info.json'), JSON.stringify({ target: 'vscode-win32-x64-min', version: '1.2.3', extensionFrom: 'abc123' }));
	const calls = [], logs = [], scanned = new Set();
	const run = async (file, args, opts = {}) => {
		calls.push([basename(file), args, opts]);
		if (basename(file) === 'java.exe' && args.includes('get_credential_ids')) {
			return ids;
		}
		if (basename(file) === 'java.exe' && args.includes('scan_code')) {
			const path = args.find(a => a.startsWith('-input_file_path=')).slice('-input_file_path='.length);
			scanned.add(await readFile(path, 'utf8'));
			return 'code object is not a malware. You can proceed signing this code object';
		}
		if (basename(file) === 'java.exe') {
			const value = name => args.find(a => a.startsWith(`-${name}=`))?.slice(name.length + 2);
			// Like eSigner with its malware blocker on, a file scan_code has not scanned refuses the batch.
			for (const name of (await readdir(value('input_dir_path')))) {
				if (!scanned.has(await readFile(join(value('input_dir_path'), name), 'utf8'))) {
					return `Error: hash needs to be scanned first before submitting for signing: ${name}`;
				}
			}
			// Like CodeSignTool, a file of a kind it does not list refuses the whole batch, on exit code 0.
			const refused = (await readdir(value('input_dir_path'))).find(name => !CODESIGNTOOL_KINDS.includes(name.split('.').pop().toLowerCase()));
			if (refused) {
				return `Error: File extension not allowed: ${refused}`;
			}
			for (const name of (await readdir(value('input_dir_path')))) {
				await writeFile(join(value('output_dir_path'), name), `signed ${await readFile(join(value('input_dir_path'), name), 'utf8')}`);
			}
			return codesignOutput;
		}
		if (basename(file) === 'ISCC.exe') {
			await writeFile(join(output, `${args.find(a => a.startsWith('/F')).slice(2)}.exe`), 'fixture setup');
			return '';
		}
		return signtool;
	};
	return { input, output, calls, logs, options: { input, output, tool, tag: 'v1.2.3', codesigntool: tool, signtool: 'signtool.exe', iss: '/fixture/pine-drama-studio.iss' }, dependencies: { run, env, log: line => logs.push(line), wait: async () => { calls.push(['next TOTP step']); } } };
}

test('signs every listed file in one batch, builds the signed installer, verifies every signature, and only then writes the checksum', async t => {
	const f = await fixture(t);
	const installer = await releaseWin32(f.options, f.dependencies);
	assert.equal(basename(installer), 'Pine-Drama-Studio-1.2.3-win32-x64-setup.exe');
	const javas = f.calls.filter(([cmd]) => cmd === 'java.exe');
	assert.deepEqual(javas.map(([, args]) => args[2]), ['get_credential_ids', ...Array(5).fill('scan_code'), 'batch_sign']);
	assert.ok(javas.slice(1).every(([, args]) => args.includes(`-credential_id=${ID}`)));
	// batch_sign takes its one-time password on a fresh TOTP step (RFC 6238, 5.2).
	const batch = f.calls.findIndex(([cmd, args]) => cmd === 'java.exe' && args[2] === 'batch_sign');
	assert.deepEqual(f.calls[batch - 1], ['next TOTP step']);
	// The id reaches Inno Setup's sign tool through the environment, and the log only as GitHub's mask command.
	assert.equal(f.calls.find(([cmd]) => cmd === 'ISCC.exe')[2].env.CREDENTIAL_ID, ID);
	assert.deepEqual(f.logs.filter(line => line.includes(ID)), [`::add-mask::${ID}`]);
	const iscc = f.calls.find(([cmd]) => cmd === 'ISCC.exe')[1];
	assert.ok(iscc.includes('/dSign=true'));
	assert.ok(iscc.some(a => a.startsWith('/sesrp=') && a.includes('--sign-file $f')));
	assert.ok(iscc.some(a => a.startsWith('/dCodeIss=') && a.endsWith('code.iss')));
	assert.ok(iscc.includes('/dAppId={{B}'));
	// The files the setup wraps were the signed ones when Inno Setup ran.
	assert.ok(f.calls.findIndex(([cmd]) => cmd === 'java.exe') < f.calls.findIndex(([cmd]) => cmd === 'ISCC.exe'));
	const verified = f.calls.filter(([cmd]) => cmd === 'signtool.exe').map(([, args]) => basename(args.at(-1)));
	assert.deepEqual(verified.sort(), ['Pine Drama Studio.exe', 'Pine-Drama-Studio-1.2.3-win32-x64-setup.exe', 'ffmpeg.dll', 'inno_updater.exe', 'x.node', 'y.ps1'].sort());
	assert.match(await readFile(join(f.output, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  Pine-Drama-Studio-1\.2\.3-win32-x64-setup\.exe\n$/);
	assert.equal((await readFile(join(f.output, 'signatures.txt'), 'utf8')).trim().split('\n').length, 6);
	const info = JSON.parse(await readFile(join(f.output, 'build-info.json'), 'utf8'));
	assert.equal(info.signing.files, 6);
	assert.equal(info.publisher, PUBLISHER);
	assert.equal(JSON.stringify(info).includes(ID), false);
	await assert.rejects(access(join(f.output, 'app')));
	await assert.rejects(access(join(f.output, 'sign-in')));
	assert.equal(f.logs.some(line => line.includes('fixture-password') || line.includes('fixture-totp')), false);
});

test('the signed files go back where they came from, each replaced by its signed copy', async t => {
	const f = await fixture(t);
	let seen;
	const run = f.dependencies.run;
	f.dependencies.run = async (file, args) => {
		if (basename(file) === 'ISCC.exe') {
			seen = await readFile(join(f.output, 'app', 'resources/app/node_modules/x/build/x.node'), 'utf8');
		}
		return run(file, args);
	};
	await releaseWin32(f.options, f.dependencies);
	assert.equal(seen, 'signed unsigned resources/app/node_modules/x/build/x.node');
});

test('native modules and PowerShell modules and manifests, kinds CodeSignTool does not list, are signed and go back under their own names', async t => {
	const f = await fixture(t);
	for (const rel of ['resources/app/out/m.psm1', 'resources/app/out/m.psd1']) {
		await writeFile(join(f.input, 'app', rel), `unsigned ${rel}`);
	}
	let seen;
	const run = f.dependencies.run;
	f.dependencies.run = async (file, args, opts) => {
		if (basename(file) === 'ISCC.exe') {
			seen = await Promise.all(['resources/app/node_modules/x/build/x.node', 'resources/app/out/m.psm1', 'resources/app/out/m.psd1'].map(rel => readFile(join(f.output, 'app', rel), 'utf8')));
		}
		return run(file, args, opts);
	};
	await releaseWin32(f.options, f.dependencies);
	assert.deepEqual(seen, ['signed unsigned resources/app/node_modules/x/build/x.node', 'signed unsigned resources/app/out/m.psm1', 'signed unsigned resources/app/out/m.psd1']);
});

for (const [name, options, error] of [
	['a missing credential', { env: { ...CREDENTIALS, ES_TOTP_SECRET: '' } }, /Missing ES_TOTP_SECRET/],
	['an account with no signing credential', { ids: 'Credential ID(s):' }, /holds 0 signing credentials/],
	['an account with two signing credentials', { ids: `Credential ID(s): ${ID} 1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d` }, /holds 2 signing credentials/],
	['a CodeSignTool error it exits 0 on', { codesignOutput: `Error: invalid credentials for ${ID}` }, /CodeSignTool batch_sign failed:\nError: invalid credentials for \*\*\*$/],
	['a signature without a timestamp', { signtool: 'Successfully verified: x' }, /signtool verify refused/],
]) {
	test(`${name} produces no checksum or build receipt`, async t => {
		const f = await fixture(t, options);
		await assert.rejects(releaseWin32(f.options, f.dependencies), error);
		await assert.rejects(access(join(f.output, 'SHA256SUMS')));
		await assert.rejects(access(join(f.output, 'build-info.json')));
	});
}

test('an existing output directory is refused before signing', async t => {
	const f = await fixture(t);
	await mkdir(f.output);
	await assert.rejects(releaseWin32(f.options, f.dependencies), /EEXIST/);
	assert.equal(f.calls.length, 0);
});
