import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { test } from 'node:test';
import { entitlementFor, releaseMacos, validateBuild } from '../release-macos.mjs';

test('release refuses a non-minified, dirty, or differently versioned package', () => {
	const build = { target: 'vscode-darwin-arm64-min', version: '1.2.3', build: '4', extensionFrom: 'abc123' };
	validateBuild(build, 'v1.2.3');
	validateBuild(build, 'v1.2.3-b4');
	for (const [info, tag] of [[{ ...build, target: 'vscode-darwin-arm64' }, 'v1.2.3'], [build, 'v1.2.4'], [build, 'v1.2.3-b5'], [{ ...build, extensionFrom: 'abc+changes' }, 'v1.2.3']]) {
		assert.throws(() => validateBuild(info, tag));
	}
});

test('Electron helpers retain Code-OSS role-specific entitlements', () => {
	for (const [helper, plist] of [['', 'app'], [' Helper', 'helper'], [' Helper (GPU)', 'helper-gpu'], [' Helper (Renderer)', 'helper-renderer'], [' Helper (Plugin)', 'helper-plugin']]) {
		assert.equal(basename(entitlementFor(`/A/Pine Drama Studio${helper}.app/Contents/MacOS/code`, '/vscode')), `${plist}-entitlements.plist`);
	}
});

async function fixture(t, rejection) {
	const root = await mkdtemp(join(tmpdir(), 'pine-release-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const input = join(root, 'unsigned'), output = join(root, 'signed'), vscode = join(root, 'vscode');
	await mkdir(input);
	await mkdir(join(vscode, '.build/electron'), { recursive: true });
	await writeFile(join(vscode, '.build/electron/version'), 'v43.8.3\n');
	await writeFile(join(input, 'build-info.json'), JSON.stringify({ target: 'vscode-darwin-arm64-min', version: '1.2.3', build: '1', extensionFrom: 'abc123' }));
	const calls = [];
	return { output, calls, options: { input, output, vscode, identity: 'Developer ID fixture', profile: 'fixture', keychain: '/fixture/keychain', tag: 'v1.2.3' }, dependencies: {
		log: () => {},
		sign: async options => {
			calls.push(['sign', options]);
			if (rejection === 'signing') throw new Error('Signing rejected fixture');
		},
		run: async (command, args) => {
			calls.push([basename(command), args]);
			if (command.endsWith('/ditto') || args[0] === 'create') await writeFile(args.at(-1), 'fixture archive');
			if (args[0] === 'notarytool') return JSON.stringify({ id: 'fixture-submission', status: rejection === basename(args[2]) ? 'Invalid' : 'Accepted' });
			if (command.endsWith('/spctl') && rejection === 'gatekeeper') throw new Error('Gatekeeper rejected fixture');
			if (command.endsWith('/spctl') && rejection === 'dmg-gatekeeper' && args[2] === 'open') throw new Error('Gatekeeper rejected DMG fixture');
			if (args[0] === 'stapler' && args[1] === 'staple' && ((rejection === 'app-stapler' && args[2].endsWith('.app')) || (rejection === 'dmg-stapler' && args[2].endsWith('.dmg')))) throw new Error('Stapler rejected fixture');
			return '';
		},
	} };
}

test('staples the app before making a DMG, verifies both, and only then writes publishable receipts', async t => {
	const f = await fixture(t);
	const dmg = await releaseMacos(f.options, f.dependencies);
	const stapleCalls = f.calls.filter(([cmd, args]) => cmd === 'xcrun' && args[0] === 'stapler' && args[1] === 'staple');
	assert.deepEqual(stapleCalls.map(([, args]) => basename(args[2])), ['Pine Drama Studio.app', basename(dmg)]);
	assert.ok(f.calls.indexOf(stapleCalls[0]) < f.calls.findIndex(([cmd, args]) => cmd === 'hdiutil' && args[0] === 'create'));
	const notarizations = f.calls.filter(([cmd, args]) => cmd === 'xcrun' && args[0] === 'notarytool');
	assert.equal(notarizations.length, 2);
	assert.equal(f.calls.filter(([cmd]) => cmd === 'spctl').length, 2);
	assert.equal(f.calls[1][1].preAutoEntitlements, false);
	assert.equal(f.calls[1][1].optionsForFile('/A').hardenedRuntime, true);
	assert.match(await readFile(join(f.output, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  Pine-Video-Studio-1\.2\.3-darwin-arm64\.dmg\n$/);
	const info = JSON.parse(await readFile(join(f.output, 'build-info.json'), 'utf8'));
	assert.equal(info.signing.notarization, 'Accepted');
	assert.equal(info.signing.stapled, true);
	assert.equal(info.signing.gatekeeper, 'accepted');
	await assert.rejects(access(join(f.output, 'notary-app.zip')));
	await assert.rejects(access(join(f.output, 'dmg-stage')));
});

for (const rejection of ['notary-app.zip', 'Pine-Video-Studio-1.2.3-darwin-arm64.dmg', 'gatekeeper', 'dmg-gatekeeper', 'signing', 'app-stapler', 'dmg-stapler']) {
	test(`a ${rejection} refusal produces no publishable build-info or checksum`, async t => {
		const f = await fixture(t, rejection);
		await assert.rejects(releaseMacos(f.options, f.dependencies), /notarization was Invalid|Gatekeeper rejected|Signing rejected|Stapler rejected/);
		await assert.rejects(access(join(f.output, 'build-info.json')));
		await assert.rejects(access(join(f.output, 'SHA256SUMS')));
		if (rejection === 'notary-app.zip') assert.equal(f.calls.some(([cmd]) => cmd === 'hdiutil'), false);
	});
}

test('an existing output directory is refused before signing', async t => {
	const f = await fixture(t);
	await mkdir(f.output);
	await assert.rejects(releaseMacos(f.options, f.dependencies), /EEXIST/);
	assert.equal(f.calls.length, 0);
});
