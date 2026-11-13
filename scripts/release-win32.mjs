#!/usr/bin/env node
// Sign the Windows app, wrap it in its installer, and produce only verified release assets. The macOS twin is
// release-macos.mjs. Runs on Windows in the release workflow's signing job (.github/workflows/release-win32.yml), the only
// job that holds the signing credentials.
//
// Signing is SSL.com eSigner through its CodeSignTool (github.com/SSLcom/CodeSignTool), with the credentials from the
// environment: ES_USERNAME, ES_PASSWORD and ES_TOTP_SECRET. The certificate's credential id is asked of eSigner
// (get_credential_ids), and the account must hold exactly one. CodeSignTool adds an RFC 3161 timestamp from SSL.com's
// TSA (TSA_URL in its conf/code_sign_tool.properties).
//
//   node scripts/release-win32.mjs --input dist/win32-x64 --output dist/release-win32 --tag v1.2.3 \
//     --codesigntool <its folder> --signtool <signtool.exe>
//   node scripts/release-win32.mjs --sign-file <file> --codesigntool <its folder>   (Inno Setup's sign tool, below)

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ARCH = 'x64';
const CODESIGNTOOL_JAR = 'code_sign_tool-1.3.2.jar';
// The publisher the installer, Apps & Features and the executables' CompanyName name: the signing certificate's subject,
// so that the publisher shown matches the verified one Windows reads from the signature.
export const PUBLISHER = '19PINE PRIVATE LIMITED';
// The copyright holder LICENSE and NOTICE name, in the executables' LegalCopyright.
export const COPYRIGHT_HOLDER = '19pine corp.';

export function validateBuild(info, tag) {
	if (info.target !== `vscode-win32-${ARCH}-min`) throw new Error('Only a full minified Windows x64 package can be released.');
	if (!info.version || ![`v${info.version}`].includes(tag)) throw new Error('Release tag does not match the packaged version.');
	if (!info.extensionFrom || info.extensionFrom.includes('+changes')) throw new Error('Refusing a package with uncommitted extension changes.');
}

// What Code-OSS's own Windows build signs in the app folder (build/azure-pipelines/win32/codesign.ts): executables,
// shared libraries and native modules, then PowerShell scripts.
const SIGNED = /\.(exe|dll|node|ps1|psm1|psd1|ps1xml)$/i;
export const filesToSign = files => files.filter(f => SIGNED.test(f)).sort();

// CodeSignTool signs only the extensions it lists (1.3.2's BatchSignCommand: cab, cat, dll, exe, jar, js, msi, nupkg,
// ocx, ps1, ps1xml, sys, vbs) and refuses the rest of the batch. A native module is a DLL under Node's own extension
// (nodejs.org/api/addons.html), and a PowerShell module or manifest is a PowerShell script signed the same way as .ps1
// (learn.microsoft.com, about_Signing; Code-OSS signs .node with the PE files and .psm1/.psd1 with the scripts,
// build/azure-pipelines/win32/codesign.ts). Each is signed under the kind's name the tool takes, then put back; step 3
// verifies every signature where the file ships.
const SIGNED_AS = { node: 'dll', psm1: 'ps1', psd1: 'ps1' };
const signedName = name => {
	const as = SIGNED_AS[name.split('.').pop().toLowerCase()];
	return as ? `${name}.${as}` : name;
};

/**
 * The definitions upstream's gulp task gives code.iss for a user setup (build/gulpfile.vscode.win32.ts, buildWin32Setup),
 * with the Studio's version where it gives Code-OSS's, and no Windows 11 context-menu package: that appx is built only
 * by Microsoft's own pipeline.
 */
export function innoDefinitions({ product, version, commit, app, repo, output, productJsonPath }) {
	return {
		NameLong: product.nameLong, NameShort: product.nameShort, DirName: product.win32DirName,
		Version: version, RawVersion: version.replace(/-\w+$/, ''), Commit: commit,
		NameVersion: `${product.win32NameVersion} (User)`, ExeBasename: product.nameShort, RegValueName: product.win32RegValueName,
		ShellNameShort: product.win32ShellNameShort, AppMutex: product.win32MutexName, TunnelMutex: product.win32TunnelMutex,
		TunnelServiceMutex: product.win32TunnelServiceMutex, TunnelApplicationName: product.tunnelApplicationName,
		ApplicationName: product.applicationName, Arch: ARCH, AppId: product.win32x64UserAppId,
		IncompatibleTargetAppId: product.win32x64AppId, AppUserId: product.win32AppUserModelId,
		ArchitecturesAllowed: ARCH, ArchitecturesInstallIn64BitMode: ARCH, SourceDir: app, RepoDir: repo, OutputDir: output,
		InstallTarget: 'user', ProductJsonRelativePath: join('resources', 'app', 'product.json'), ProductJsonPath: productJsonPath,
		VersionedResourcesFolder: '', Quality: product.quality, Publisher: PUBLISHER,
	};
}

// eSigner credential ids are UUIDs; one is kept out of every log (masked in GitHub Actions, replaced in our messages).
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const masked = text => text.replace(UUID, '***');

async function codesignTool(command, args, { run, env, tool }) {
	for (const name of ['ES_USERNAME', 'ES_PASSWORD']) {
		if (!env[name]) throw new Error(`Missing ${name} for SSL.com eSigner.`);
	}
	const output = await run(join(tool, 'jdk-11.0.2', 'bin', 'java.exe'), ['-jar', join(tool, 'jar', CODESIGNTOOL_JAR), command,
		`-username=${env.ES_USERNAME}`, `-password=${env.ES_PASSWORD}`, ...args], { cwd: tool });
	// CodeSignTool can exit 0 on a failure; SSL.com's own GitHub Action reads its output for these words instead
	// (github.com/SSLcom/esigner-codesign, src/main.ts).
	if (/Error|Exception|Missing required option|Unmatched argument/.test(output)) {
		throw new Error(`CodeSignTool ${command} failed:\n${masked(output)}`);
	}
	return output;
}

/** The account's one eSigner credential id (CodeSignTool get_credential_ids), masked in GitHub Actions' logs. */
export async function credentialId({ run, env, tool, log }) {
	const ids = [...new Set((await codesignTool('get_credential_ids', [], { run, env, tool })).match(UUID) ?? [])];
	if (ids.length !== 1) {
		throw new Error(`The eSigner account holds ${ids.length} signing credentials; signing needs exactly one.`);
	}
	// GitHub Actions' workflow command that hides a value in every later line of the log.
	log(`::add-mask::${ids[0]}`);
	return ids[0];
}

/** One CodeSignTool signing command (its `sign` and `batch_sign`), with the eSigner credentials from the environment. */
export async function codesign(command, args, { run, env, tool }) {
	for (const name of ['CREDENTIAL_ID', 'ES_TOTP_SECRET']) {
		if (!env[name]) throw new Error(`Missing ${name} for SSL.com eSigner.`);
	}
	return codesignTool(command, [`-credential_id=${env.CREDENTIAL_ID}`, `-totp_secret=${env.ES_TOTP_SECRET}`, ...args], { run, env, tool });
}

async function filesBelow(root) {
	return (await readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
		.map(e => join(e.parentPath, e.name).slice(root.length + 1));
}

async function sha256(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

export async function releaseWin32(options, dependencies = {}) {
	const run = dependencies.run ?? (async (file, args, opts = {}) => {
		const { stdout, stderr } = await execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
		return stdout + stderr;
	});
	const log = dependencies.log ?? console.log;
	const input = resolve(options.input), output = resolve(options.output), tool = resolve(options.codesigntool);
	const given = dependencies.env ?? process.env;
	const info = JSON.parse(await readFile(join(input, 'build-info.json'), 'utf8'));
	validateBuild(info, options.tag);
	// mkdir without recursive refuses an existing destination, so a failure can never mix with an earlier release.
	await mkdir(output);
	const app = join(output, 'app');
	await cp(join(input, 'app'), app, { recursive: true });
	const product = JSON.parse(await readFile(join(app, 'resources', 'app', 'product.json'), 'utf8'));
	// The credential id travels to Inno Setup's sign tool, a process of its own, in the environment.
	const env = { ...given, CREDENTIAL_ID: await credentialId({ run, env: given, tool, log }) };

	// 1. Every file of the list, in one batch: one eSigner session, one one-time password. batch_sign signs the files of
	// one folder, so they are laid out flat under numbered names it takes and put back where they came from.
	const files = filesToSign(await filesBelow(app));
	if (!files.length) throw new Error('The app folder holds nothing to sign.');
	const unsigned = join(output, 'sign-in'), signed = join(output, 'sign-out');
	await mkdir(unsigned);
	await mkdir(signed);
	const flat = files.map((rel, i) => signedName(`${String(i).padStart(4, '0')}-${basename(rel)}`));
	await Promise.all(files.map((rel, i) => cp(join(app, rel), join(unsigned, flat[i]))));
	log(`Signing ${files.length} files in the app with SSL.com eSigner.`);
	await codesign('batch_sign', [`-input_dir_path=${unsigned}`, `-output_dir_path=${signed}`], { run, env, tool });
	await Promise.all(files.map((rel, i) => cp(join(signed, flat[i]), join(app, rel))));
	await rm(unsigned, { recursive: true });
	await rm(signed, { recursive: true });

	// 2. The installer: code.iss through our wrapper, with Inno Setup signing the uninstaller it embeds and the setup it
	// writes (code.iss: SignTool=esrp when Sign is defined; gulpfile.vscode.win32.ts packageInnoSetup defines the tool on
	// ISCC's command line, as here).
	const repo = join(input, 'inno');
	const productJsonPath = join(output, 'product.json');
	await writeFile(productJsonPath, JSON.stringify({ ...product, target: 'user' }, undefined, '\t'));
	const definitions = innoDefinitions({ product, version: info.version, commit: product.commit, app, repo, output, productJsonPath });
	// Upstream's own check (packageInnoSetup): every definition is a string; VersionedResourcesFolder is an empty one.
	for (const [key, value] of Object.entries(definitions)) {
		if (typeof value !== 'string') throw new Error(`Missing value for '${key}' in the Inno Setup step.`);
	}
	const self = resolve(import.meta.filename);
	const setupName = `Pine-Drama-Studio-${info.version}-win32-${ARCH}-setup`;
	log('Building the installer; Inno Setup signs its uninstaller and the setup.');
	await run(join(repo, 'innosetup', 'bin', 'ISCC.exe'), [
		resolve(options.iss ?? join(import.meta.dirname, '..', 'upstream', 'win32', 'pine-drama-studio.iss')),
		`/dCodeIss=${join(repo, 'build', 'win32', 'code.iss')}`, ...Object.entries(definitions).map(([key, value]) => `/d${key}=${value}`),
		// Inno Setup puts the file, quoted, where $f stands (its help, "SignTool").
		'/dSign=true', `/sesrp="${process.execPath}" "${self}" --codesigntool "${tool}" --sign-file $f`, `/F${setupName}`,
	], { env });
	const installer = join(output, `${setupName}.exe`);

	// 3. Every signed file, and the setup: a valid Authenticode signature with a trusted timestamp (signtool verify, the
	// default Authenticode policy /pa, verbose output naming the timestamp).
	log('Verifying every signature and its timestamp.');
	const report = [];
	for (const file of [installer, ...files.map(rel => join(app, rel))]) {
		const out = await run(options.signtool, ['verify', '/pa', '/v', file]);
		if (!/Successfully verified/.test(out) || !/The signature is timestamped/.test(out)) {
			throw new Error(`signtool verify refused ${file}:\n${out}`);
		}
		report.push(`${file.slice(output.length + 1)}: ${out.match(/The signature is timestamped: .*/)[0]}`);
	}
	await writeFile(join(output, 'signatures.txt'), report.join('\n') + '\n');

	// 4. The release files: the setup and its checksum; the app is inside the setup.
	await rm(app, { recursive: true });
	await rm(productJsonPath);
	const digest = await sha256(installer);
	await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${basename(installer)}\n`);
	await writeFile(join(output, 'build-info.json'), JSON.stringify({ ...info, tag: options.tag, signing: {
		service: 'SSL.com eSigner', tool: `CodeSignTool ${CODESIGNTOOL_JAR}`, files: files.length + 1, timestamped: true,
	}, publisher: PUBLISHER, installerSha256: digest }, null, 2) + '\n');
	log('Verification passed; release checksum and build receipt written.');
	return installer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: Object.fromEntries(['input', 'output', 'tag', 'codesigntool', 'signtool', 'sign-file', 'iss'].map(name => [name, { type: 'string' }])) });
	if (values['sign-file']) {
		// Inno Setup's sign tool: one file, signed in place.
		const run = async (file, args, opts) => { const { stdout, stderr } = await execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...opts }); return stdout + stderr; };
		await codesign('sign', [`-input_file_path=${resolve(values['sign-file'])}`, '-override=true'], { run, env: process.env, tool: resolve(values.codesigntool) });
	} else {
		for (const name of ['input', 'output', 'tag', 'codesigntool', 'signtool']) {
			if (!values[name]) throw new Error(`Missing --${name}`);
		}
		console.log(await releaseWin32(values));
	}
}
