// Installing a task's return into the drama's folder (doc/protocol.md, 4.4). Computers only add: every returned version
// folder and review file is new, so nothing is merged, replaced or selected here. The OS does the work: system `tar`
// extracts each archive into a temporary sibling, and rename() moves it into place whole. No vscode import.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readChoices, updateChoices, withObject, writeWhole } from './choices';
import { within } from './placement';
import { check, type Request, type Return, type VersionRef } from './protocol';
import { fetchKept, fileKey, sha256, stateKey, versionKey, type ArtifactStore } from './taskArtifacts';
import type { DramaRecord, Installed } from './taskRun';

/** A version the agent asks the person to choose (4.3, `review`). */
export type ReviewTarget = VersionRef & { readonly reason: string };

/**
 * Whether `path` is the scope's to add to: the Project Chat's `project` adds outside `episodes/`, a session's `episodes`
 * under it, any episode (a session's episodes are given in words, so a session is not bound to one).
 */
export function inScope(path: string, scope: string): boolean {
	return (path === 'episodes' || path.startsWith('episodes/')) === (scope === 'episodes');
}

/** The prefix of an install's temporary siblings (doc/protocol.md, 4.4): `.pine-install-<hash>`. */
const TEMP = '.pine-install-';

/** Removes the temporary siblings an install cut off left in `dir`. */
function removeLeftovers(dir: string): void {
	for (const name of existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith(TEMP)) : []) { rmSync(join(dir, name), { recursive: true, force: true }); }
}

/** A return the client refuses whole: nothing of it is installed, and the person is shown `invalid` with this reason. */
export class InvalidReturn extends Error { }

/** A path as doc/protocol.md section 1 defines it: relative, `/`-separated, NFC, no empty or hidden segment, no `\` or control character. */
export function validPath(path: string): boolean {
	// eslint-disable-next-line no-control-regex
	return path.length > 0 && path.normalize('NFC') === path && path.split('/').every(s => s.length > 0 && !s.startsWith('.') && !/[\\\u0000-\u001f\u007f]/.test(s));
}

/**
 * The names an archive holds, checked as 4.1 requires: relative, no `..`, each once. Listed by system tar; a leading `./`
 * and a directory's trailing `/` are tar's spelling, not part of the name.
 */
export function archiveNames(archive: string): string[] {
	const names = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean)
		.map(n => n.replace(/^(\.\/)+/, '').replace(/\/+$/, '')).filter(n => n !== '' && n !== '.');
	const bad = names.find(n => n.startsWith('/') || n.split('/').some(s => s === '..' || s === ''));
	if (bad) { throw new InvalidReturn(`an archive names ${bad}, outside its version folder`); }
	if (new Set(names).size !== names.length) { throw new InvalidReturn('an archive names a file twice'); }
	return names;
}

/** Whether an extracted tree holds only regular files and directories: no link, hard link, device or other kind. */
function onlyFilesAndFolders(dir: string): boolean {
	return readdirSync(dir).every(name => {
		const stat = lstatSync(join(dir, name));
		return stat.isDirectory() ? onlyFilesAndFolders(join(dir, name)) : stat.isFile() && stat.nlink === 1;
	});
}

/**
 * Installs return `ret` of `request` into the folder at `root`, in two passes. The first fetches every archive and
 * review file, checks it against its hash, and extracts or writes it beside its place; any failure refuses the whole
 * return and leaves nothing. The second renames each into place. Repeating it is safe: the return is recorded before the
 * first rename, so a run cut off part way finds its own folders known and skips them. A folder another session made
 * meanwhile with the same name clashes, and refuses the return whole.
 */
export function installReturn(o: Parameters<typeof installNow>[0]): Promise<Installed> {
	// One return at a time per drama: two returns that pass their checks together could otherwise rename a folder
	// before the other's clash is found. A promise chain per folder, as choices.ts's updateChoices; one window holds a
	// project, so no lock file.
	const run = (installs.get(o.root) ?? Promise.resolve()).catch(() => undefined).then(() => installNow(o));
	installs.set(o.root, run);
	return run;
}

const installs = new Map<string, Promise<unknown>>();

async function installNow(o: {
	readonly root: string;
	readonly record: DramaRecord;
	/** The Studio's copies of archives and files (taskArtifacts.ts). */
	readonly kept: string;
	/** The store of the Computer that ran the task. */
	readonly store: ArtifactStore;
	readonly request: Request;
	readonly ret: Return;
}): Promise<Installed> {
	const { root, record, kept, store, request, ret } = o;
	const versions = ret.versions ?? {};
	const reviews = ret.reviews ?? {};
	const sent = record.sentTask(ret.turn)!;
	const done: Installed = { task: ret.turn, scope: request.scope, chat: sent.chat, sent: sent.sent, versions, reviews, private_state: ret.private_state ?? null, snapshot: ret.snapshot ?? null, problems: ret.problems ?? [] };

	// Scope and place: every returned path is the task's scope's, and inside the folder.
	const paths = [...Object.keys(versions), ...Object.keys(reviews)];
	const outside = paths.filter(p => !validPath(p) || !inScope(p, request.scope) || !within(root, join(root, p)));
	if (outside.length) { throw new InvalidReturn(`${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the task's scope, ${request.scope}`); }

	// New folders only: one already here is skipped when it holds the same archive, and refuses the return otherwise.
	const known = new Map(record.returns().flatMap(r => Object.entries(r.versions)));
	const clash = Object.entries(versions).filter(([folder, hash]) => existsSync(join(root, folder)) && known.get(folder) !== hash);
	if (clash.length) {
		throw new InvalidReturn(`another session made ${clash.map(([f]) => f).join(', ')} while this task ran, so its result would clash with that work; you can run this work again in a new message`);
	}

	// Pass 1: everything fetched, checked and laid beside its place.
	const staged: { readonly temp: string; readonly target: string }[] = [];
	// Temporary siblings are named by what they hold, `.pine-install-<hash>`; one an earlier run left behind is removed
	// before its name is used again, with any other leftover beside the places this return writes.
	const temp = (target: string, hash: string) => join(dirname(target), `${TEMP}${hash}`);
	for (const dir of new Set(paths.map(p => dirname(join(root, p))))) { removeLeftovers(dir); }
	try {
		for (const [folder, hash] of Object.entries(versions).filter(([folder]) => !existsSync(join(root, folder)))) {
			await fetchKept(store, kept, versionKey(hash), hash);
			const archive = join(kept, versionKey(hash));
			archiveNames(archive);
			const target = join(root, folder);
			mkdirSync(dirname(target), { recursive: true });
			// Two folders of one parent with the same archive (an identical import) get the version id too, so neither removes the other's.
			const dir = staged.some(st => st.temp === temp(target, hash)) ? `${temp(target, hash)}-${basename(target)}` : temp(target, hash);
			staged.push({ temp: dir, target });
			mkdirSync(dir);
			execFileSync('tar', ['-xf', archive, '-C', dir]);
			if (!onlyFilesAndFolders(dir)) { throw new InvalidReturn(`${folder}'s archive holds something other than files and folders`); }
		}
		for (const [path, hash] of Object.entries(reviews)) {
			const target = join(root, path);
			const here = existsSync(target) ? readFileSync(target) : undefined;
			if (here && sha256(here) !== hash) { throw new InvalidReturn(`${path} already exists with other bytes`); }
			if (here) { continue; }
			const bytes = await fetchKept(store, kept, fileKey(hash), hash);
			// A review of a version this return brings goes into that version's extracted folder, which moves with it.
			const folder = staged.find(s => target.startsWith(`${s.target}/`));
			if (folder) {
				const inside = join(folder.temp, target.slice(folder.target.length + 1));
				mkdirSync(dirname(inside), { recursive: true });
				writeFileSync(inside, bytes, { flush: true });
				continue;
			}
			mkdirSync(dirname(target), { recursive: true });
			const file = temp(target, hash);
			staged.push({ temp: file, target });
			writeFileSync(file, bytes, { flush: true });
		}
		if (ret.private_state) { await fetchKept(store, kept, stateKey(ret.private_state), ret.private_state); }
	} catch (error) {
		for (const { temp: path } of staged) { rmSync(path, { recursive: true, force: true }); }
		throw error;
	}

	// Pass 2: recorded, then into place.
	await record.installed(done);
	for (const { temp: path, target } of staged) { renameSync(path, target); }

	// A version made from a version the person deleted while the task ran is installed and marked deleted too, as is every
	// returned version made from it.
	await markMadeFromDeleted(root, request, Object.keys(versions));
	return done;
}

/** Marks the versions of `folders` made, directly or through each other, from a version deleted after `request` was sent. */
async function markMadeFromDeleted(root: string, request: Request, folders: readonly string[]): Promise<void> {
	const now = await readChoices(root);
	const deleted = (choices: typeof now, input: VersionRef) => (choices?.objects[input.object]?.discarded ?? []).includes(input.version);
	const inputs = new Map(folders.map(folder => {
		const path = join(root, folder, 'version.json');
		return [folder, existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { inputs: VersionRef[] }).inputs : []];
	}));
	const marked = new Set<string>();
	for (let grew = true; grew;) {
		grew = false;
		for (const [folder, list] of inputs) {
			if (!marked.has(folder) && list.some(i => marked.has(`${i.object}/${i.version}`) || (deleted(now, i) && !deleted(request.choices, i)))) { marked.add(folder); grew = true; }
		}
	}
	if (marked.size) {
		await updateChoices(root, choices => [...marked].reduce((next, folder) => withObject(next, dirname(folder), entry => ({ ...entry, discarded: [...new Set([...(entry.discarded ?? []), basename(folder)])] })), choices));
	}
}

/**
 * Downloads the versions a running task has announced (doc/protocol.md, 4.6) and extracts each into the drama's record,
 * `previews/<hash>/`, checked as an install's archive is, then `previews/<hash>.json` = {object, version, task}. Nothing
 * reaches the drama's folder: its install later takes the same kept archive, with no second download. Returns how many
 * previews it added.
 */
export async function previewProgress(o: { readonly record: DramaRecord; readonly kept: string; readonly store: ArtifactStore; readonly task: string }): Promise<number> {
	const previews = join(o.record.dir, 'previews');
	let added = 0;
	for (const key of (await o.store.list(`turns/${o.task}/progress/`)).map(f => f.path).filter(k => k.endsWith('.json'))) {
		const hash = basename(key, '.json');
		if (existsSync(join(previews, `${hash}.json`))) { continue; }
		const bytes = await o.store.read(key);
		if (!bytes) { continue; }
		const progress = check('progress', JSON.parse(bytes.toString('utf8')), key);
		await fetchKept(o.store, o.kept, versionKey(hash), hash);
		const archive = join(o.kept, versionKey(hash));
		archiveNames(archive);
		const target = join(previews, hash);
		if (!existsSync(target)) {
			mkdirSync(previews, { recursive: true });
			const dir = join(previews, `${TEMP}${hash}`);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			try {
				execFileSync('tar', ['-xf', archive, '-C', dir]);
				if (!onlyFilesAndFolders(dir)) { throw new InvalidReturn(`${key} names an archive that holds something other than files and folders`); }
				renameSync(dir, target);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		await writeWhole(join(previews, `${hash}.json`), JSON.stringify({ object: progress.object, version: progress.version, task: o.task }));
		added++;
	}
	return added;
}
