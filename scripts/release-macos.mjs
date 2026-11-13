#!/usr/bin/env node
// Sign a copy of the minified package, notarize it, and produce only verified release assets.
// Uses Code-OSS's pinned @electron/osx-sign and entitlements.
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const appName = 'Pine Drama Studio.app';

export function entitlementFor(file, vscode) {
	for (const [helper, plist] of [
		[' Helper (GPU).app', 'helper-gpu-entitlements.plist'],
		[' Helper (Renderer).app', 'helper-renderer-entitlements.plist'],
		[' Helper (Plugin).app', 'helper-plugin-entitlements.plist'],
		[' Helper.app', 'helper-entitlements.plist'],
	]) {
		if (file.includes(helper)) return join(vscode, 'build/azure-pipelines/darwin', plist);
	}
	return join(vscode, 'build/azure-pipelines/darwin/app-entitlements.plist');
}

export function validateBuild(info, tag) {
	if (!/^vscode-darwin-(arm64|x64)-min$/.test(info.target)) throw new Error('Only a full minified macOS package (arm64 or x64) can be released.');
	if (!info.version || !info.build || ![ `v${info.version}`, `v${info.version}-b${info.build}` ].includes(tag)) {
		throw new Error('Release tag does not match the packaged version/build.');
	}
	if (!info.extensionFrom || info.extensionFrom.includes('+changes')) throw new Error('Refusing a package with uncommitted extension changes.');
}

export async function releaseMacos(options, dependencies = {}) {
	const run = dependencies.run ?? (async (file, args) => (await execFile(file, args, { maxBuffer: 16 * 1024 * 1024 })).stdout);
	const log = dependencies.log ?? console.log;
	const input = resolve(options.input), output = resolve(options.output), vscode = resolve(options.vscode);
	const info = JSON.parse(await readFile(join(input, 'build-info.json'), 'utf8'));
	validateBuild(info, options.tag);
	// mkdir without recursive refuses an existing destination, so a failure can never mix with an earlier release.
	await mkdir(output);
	const app = join(output, appName);
	await run('/bin/cp', ['-cR', join(input, appName), app]);
	log('Signing application and nested code.');
	const sign = dependencies.sign ?? (await import(pathToFileURL(join(vscode, 'build/node_modules/@electron/osx-sign/dist/index.js')).href)).sign;
	await sign({
		app, platform: 'darwin', identity: options.identity, keychain: options.keychain,
		version: (await readFile(join(vscode, '.build/electron/version'), 'utf8')).trim().replace(/^v/, ''),
		// osx-sign's binary detection also includes image files. macOS file(1) identifies actual Mach-O code.
		ignore: file => statSync(file).isFile()
			&& !execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' }).includes('Mach-O'),
		preAutoEntitlements: false, preEmbedProvisioningProfile: false,
		optionsForFile: file => ({ entitlements: entitlementFor(file, vscode), hardenedRuntime: true }),
	});
	await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
	const profile = ['--keychain-profile', options.profile, ...(options.keychain ? ['--keychain', options.keychain] : [])];
	async function notarize(file, label, stapleTarget = file) {
		log(`Submitting ${label} to Apple; waiting up to 45 minutes for notarization.`);
		const result = JSON.parse(await run('/usr/bin/xcrun', ['notarytool', 'submit', file, ...profile, '--wait', '--timeout', '45m', '--output-format', 'json']));
		await writeFile(join(output, `${label}-notarization.json`), JSON.stringify(result, null, 2) + '\n');
		if (result.status !== 'Accepted') throw new Error(`${label} notarization was ${result.status}; submission ${result.id}. Nothing is published.`);
		log(`${label} notarization Accepted (${result.id}); stapling and validating ticket.`);
		await run('/usr/bin/xcrun', ['stapler', 'staple', stapleTarget]);
		await run('/usr/bin/xcrun', ['stapler', 'validate', stapleTarget]);
		return result.id;
	}
	// Staple the app before building the DMG, so the installed app also carries its ticket offline.
	const zip = join(output, 'notary-app.zip');
	await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
	const appSubmission = await notarize(zip, 'app', app);
	await rm(zip);
	// vscode-darwin-<arch>-min (validateBuild): the disk image is named for the architecture it runs on.
	const arch = info.target.split('-')[2];
	const dmg = join(output, `Pine-Drama-Studio-${options.tag.slice(1)}-darwin-${arch}.dmg`);
	const stage = join(output, 'dmg-stage');
	log('Building and signing DMG from the stapled application.');
	await mkdir(stage);
	await run('/bin/cp', ['-cR', app, join(stage, appName)]);
	await run('/bin/ln', ['-s', '/Applications', join(stage, 'Applications')]);
	await run('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Pine Drama Studio', '-srcfolder', stage, '-format', 'UDZO', dmg]);
	await rm(stage, { recursive: true });
	await run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', options.identity, ...(options.keychain ? ['--keychain', options.keychain] : []), dmg]);
	await run('/usr/bin/codesign', ['--verify', '--strict', dmg]);
	await run('/usr/bin/hdiutil', ['verify', '-quiet', dmg]);
	const dmgSubmission = await notarize(dmg, 'dmg');
	log('Assessing application and DMG with Gatekeeper.');
	await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
	await run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(dmg)) hash.update(chunk);
	const digest = hash.digest('hex');
	await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${dmg.slice(output.length + 1)}\n`);
	await writeFile(join(output, 'build-info.json'), JSON.stringify({ ...info, tag: options.tag, signing: {
		identity: options.identity, hardenedRuntime: true, notarization: 'Accepted', appSubmission, dmgSubmission,
		stapled: true, gatekeeper: 'accepted',
	}, dmgSha256: digest }, null, 2) + '\n');
	log('Verification passed; release checksum and build receipt written.');
	return dmg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: Object.fromEntries(['input', 'output', 'vscode', 'identity', 'profile', 'keychain', 'tag'].map(name => [name, { type: 'string' }])) });
	for (const name of ['input', 'output', 'vscode', 'identity', 'profile', 'tag']) {
		if (!values[name]) throw new Error(`Missing --${name}`);
	}
	console.log(await releaseMacos(values));
}
