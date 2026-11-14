// Installing a task's return into the drama's folder (doc/protocol.md, 4.4). Computers only add: every returned version
// folder and review file is new, so nothing is merged, replaced or selected here. Nothing is refused whole: what can be
// used is installed, and only what cannot, with what was made from it, is left out and said. node-tar extracts each
// archive into a temporary sibling, writing only plain files and folders, and rename() moves it into place whole. No
// vscode import.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { extract as extractTar } from 'tar';
import { readChoices, updateChoices, withObject, writeWhole } from './choices';
import { within } from './placement';
import { snapshotState, variantRoot } from './project';
import { check, MAJOR, matches, ProtocolDocumentError, UnsupportedMajor, type Request, type Return, type VersionRef } from './protocol';
import { fetchKept, fileKey, MismatchedArtifact, MissingArtifact, sha256, stateKey, versionKey, type ArtifactStore } from './taskArtifacts';
import { scopedSnapshots, tasksOf, type DramaRecord, type Installed } from './taskRun';

/** A path's identity: two paths that differ only by case are the same path (doc/protocol.md section 1 and 4.4). */
const pathKey = (path: string) => path.normalize('NFC').toLowerCase();

/** A version the agent asks the person to choose (4.3, `review`). */
export type ReviewTarget = VersionRef & { readonly reason: string };

/**
 * Whether `path` is the scope's to add to: the Project Chat's `project` adds outside `episodes/`, a session's `episodes`
 * under it, any episode (a session's episodes are given in words, so a session is not bound to one), and under
 * `assets/` where `episodesMay` says so for its object (doc/protocol.md section 1: a shared object new to the drama, or
 * inside one made in an episodes turn).
 */
export function inScope(path: string, scope: string, episodesMay: (object: string) => boolean): boolean {
	const key = pathKey(path);
	const episode = key === 'episodes' || key.startsWith('episodes/');
	if (episode === (scope === 'episodes')) { return true; }
	return scope === 'episodes' && key.startsWith('assets/') && episodesMay(objectOf(path));
}

/** The object a returned path is of: a version folder's parent, or the object of the version a review file is in. */
function objectOf(path: string): string {
	const parts = path.split('/');
	return parts.at(-2) === 'reviews' ? parts.slice(0, -3).join('/') : parts.slice(0, -1).join('/');
}

/** The prefix of an install's temporary siblings (doc/protocol.md, 4.4). */
const TEMP = '.pine-install-';

/** Removes the temporary siblings an install cut off left in `dir`. */
function removeLeftovers(dir: string): void {
	for (const name of existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith(TEMP)) : []) { rmSync(join(dir, name), { recursive: true, force: true }); }
}

/** A part of a return the client leaves out (doc/protocol.md, 4.4), and why, in the person's words. */
export interface LeftOut {
	readonly path: string;
	readonly why: string;
	/** A returned version folder, a review file, a member of an archive, or another part of the return. */
	readonly kind: 'version' | 'review' | 'member' | 'part';
}

/**
 * Reads a return (4.3), keeping what it can use. Its envelope (`schema`, `turn`, `state`) must match the protocol; every
 * other part is checked on its own against its part of the schema, each version and review entry one by one, so a part
 * that does not match is left out, not the return. Throws when nothing can be read: not JSON (SyntaxError), another major
 * (UnsupportedMajor), or an envelope that does not match (ProtocolDocumentError).
 */
export function readReturn(bytes: Buffer, what: string): { readonly ret: Return; readonly leftOut: readonly LeftOut[] } {
	const doc: unknown = JSON.parse(bytes.toString('utf8'));
	if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) { throw new ProtocolDocumentError(what, '/ must be object'); }
	const given = doc as Record<string, unknown>;
	if (given.schema !== MAJOR && given.schema !== undefined) { throw new UnsupportedMajor(what, given.schema); }
	const bad = ['schema', 'turn', 'state'].filter(key => !matches(`return/properties/${key}`, given[key]));
	if (bad.length) { throw new ProtocolDocumentError(what, bad.map(key => `/${key} does not match`).join('; ')); }
	const ret: Record<string, unknown> = { schema: given.schema, turn: given.turn, state: given.state };
	const leftOut: LeftOut[] = [];
	for (const [key, part, kind] of [['versions', 'folders', 'version'], ['reviews', 'reviewFiles', 'review']] as const) {
		if (given[key] === undefined) { continue; }
		const container = typeof given[key] === 'object' && given[key] !== null && !Array.isArray(given[key]);
		if (!container) { leftOut.push({ path: `the return's ${key}`, why: 'it does not match the protocol', kind: 'part' }); }
		const entries = container ? Object.entries(given[key] as object) : [];
		ret[key] = Object.fromEntries(entries.filter(([path, hash]) => matches(part, { [path]: hash }) || !leftOut.push({ path, why: 'its entry in the return does not match the protocol', kind })));
	}
	// A stopped or ended return carries the session's private state (4.3): one missing is said, and the session keeps the one it had.
	if (['stopped', 'ended'].includes(given.state as string) && given.private_state === undefined) {
		leftOut.push({ path: 'the return\'s private state', why: 'it is missing', kind: 'part' });
	}
	for (const key of ['private_state', 'snapshot', 'problems', 'question', 'review', 'error']) {
		if (given[key] === undefined) { continue; }
		if (matches(`return/properties/${key}`, given[key])) { ret[key] = given[key]; } else { leftOut.push({ path: `the return's ${key.replace('_', ' ')}`, why: 'it does not match the protocol', kind: 'part' }); }
	}
	return { ret: ret as unknown as Return, leftOut };
}

/** A Windows reserved name, with or without an extension (doc/protocol.md section 1). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A path as doc/protocol.md section 1 defines it: NFC, the schema's `$defs/path` (relative, `/`-separated, no empty or
 * hidden segment, no `\` or control character, at most 240 characters), and what a pattern does not hold there: no
 * segment is a Windows reserved name or ends with `.` or a space.
 */
export function validPath(path: string): boolean {
	return path.normalize('NFC') === path && matches('path', path) && path.split('/').every(segment => !RESERVED.test(segment) && !/[. ]$/.test(segment));
}

/** File system errors that are the machine's, not the archive's: an install that meets one is tried again. */
const MACHINE_FAILURES = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY']);

/**
 * Extracts an archive into `dir`, writing only what 4.1 allows: plain files and folders, each under a path of the project
 * (section 1: relative, no hidden or `..` segment). A link, a hard link, a device or any other kind, an absolute name (POSIX
 * or Windows, such as `C:/x`, which node-tar would strip to a relative one), a hidden one such as `._x` or `.DS_Store`, a
 * name given a second time (without regard to case), and anything under `reviews/` (2.2: reviews travel on their own), is
 * skipped, never written, and given to `skipped`, as the Computer side does with tarfile's `data` filter. Returns false
 * when the archive cannot be read as a tar archive at all.
 */
function extractSafely(archive: string, dir: string, skipped: (name: string) => void): boolean {
	const seen = new Set<string>();
	let readable = true;
	// node-tar reports a member it could not write as a warning, a file system failure the same way. A failure of the
	// machine (no space, no permission, an I/O error) is thrown, so the install is tried again; any other, such as a member
	// that clashes with another of the archive (a file `a`, then `a/b`), is that member left out (its unpack.ts).
	let failure: Error | undefined;
	const warned = (code: string, message: string, data?: unknown) => {
		const cause = data instanceof Error ? data as Error & { code?: string } : undefined;
		if (cause?.code && MACHINE_FAILURES.has(cause.code)) { failure ??= cause; return; }
		if (code === 'TAR_BAD_ARCHIVE' || code === 'TAR_ABORT') { readable = false; return; }
		skipped((data as { path?: string } | undefined)?.path ?? message);
	};
	try {
		extractTar({
			file: archive, cwd: dir, sync: true, strict: false, onwarn: warned,
			filter: (path, entry) => {
				const name = path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
				const plain = 'type' in entry && ['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(entry.type)
					&& name !== '' && validPath(name) && !posix.isAbsolute(name) && !win32.isAbsolute(name)
					&& !seen.has(pathKey(name)) && pathKey(name.split('/')[0]) !== 'reviews';
				if (plain) { seen.add(pathKey(name)); } else if (name) { skipped(name); }
				return plain;
			},
		});
	} catch (error) {
		// An archive node-tar cannot read at all throws even when not strict, with a TAR_ code in `code` or, when its
		// decompressor failed (Z_DATA_ERROR), in `tarCode` (its warn-method.ts); a failure of the machine, or anything else,
		// is thrown on.
		const { code, tarCode } = error as { code?: unknown; tarCode?: unknown };
		const archiveFault = [code, tarCode].some(c => typeof c === 'string' && c.startsWith('TAR_'));
		if (!archiveFault || (typeof code === 'string' && MACHINE_FAILURES.has(code))) { throw error; }
		readable = false;
	}
	if (failure) { throw failure; }
	return readable;
}

/**
 * Installs return `ret` of `request` into the folder at `root`, in two passes (doc/protocol.md, 4.4). The first fetches
 * every archive and review file, checks it against its hash, and extracts or writes it beside its place. The second
 * renames each into place. Nothing is refused whole: a part that cannot be used is left out, with every returned version
 * made from it (`inputs`, 2.1, the full list) and its reviews, and said in `leftOut`, with what `readReturn` left out
 * (`unread`). Repeating it is safe: the return is recorded before the first rename, so a run cut off part way finds its own
 * folders known and skips them.
 */
export function installReturn(o: Parameters<typeof installNow>[0]): Promise<{ readonly done: Installed; readonly leftOut: readonly LeftOut[] }> {
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
	/** What reading the return left out (readReturn). */
	readonly unread?: readonly LeftOut[];
}): Promise<{ readonly done: Installed; readonly leftOut: readonly LeftOut[] }> {
	const { root, record, kept, store, request, ret } = o;
	const returned = ret.versions ?? {};
	const returnedReviews = ret.reviews ?? {};
	const sent = record.sentTask(ret.turn)!;
	// What is left out, by path (without regard to case), with why: the first reason given for a path is the one said.
	// Members skipped in an archive are said too, apart: they leave out nothing returned on its own.
	const left = new Map<string, LeftOut>((o.unread ?? []).map(l => [pathKey(l.path), l]));
	const members: LeftOut[] = [];
	const leave = (path: string, why: string, kind: LeftOut['kind']) => { if (!left.has(pathKey(path))) { left.set(pathKey(path), { path, why, kind }); } };
	const isLeft = (path: string) => left.has(pathKey(path));
	const out = (path: string) => dropped.has(path) || isLeft(path);
	const kindOf = (path: string): LeftOut['kind'] => path in returned ? 'version' : 'review';
	// A returned path left out by its exact spelling only (a second spelling of another): the other spelling stays.
	const dropped = new Set<string>();
	const paths = [...Object.keys(returned), ...Object.keys(returnedReviews)];

	// One path, one item: a second returned path that differs from another only by case is left out.
	const named = new Set<string>();
	for (const path of paths) {
		if (named.has(pathKey(path))) { members.push({ path, why: 'another returned path differs from it only by case', kind: kindOf(path) }); dropped.add(path); }
		named.add(pathKey(path));
	}

	// New folders only: one already here is skipped when it holds the archive recorded for it, and left out otherwise.
	const known = new Map([...record.returns().flatMap(r => Object.entries(r.versions)), ...record.adopted().map(a => [a.path, a.hash] as const)]);
	const recorded = record.returns().find(r => r.task === ret.turn)?.versions ?? {};
	const own = (folder: string) => returned[folder] !== undefined && recorded[folder] === returned[folder];
	for (const [folder, hash] of Object.entries(returned)) {
		if (existsSync(join(root, folder)) && known.get(folder) !== hash) { leave(folder, 'another session made a version with the same name while this task ran; run this work again to make it anew', 'version'); }
	}

	// Scope and place: every returned path is the task's scope's, and inside the folder.
	// An object new to the drama (section 1): no version folder of it is here but this return's own (one installed before,
	// with the archive recorded for it, so installing it again after a crash is safe), and no snapshot installed before
	// this return lists it.
	const before = record.returns().filter(r => r.task !== ret.turn);
	const listedBefore = new Set(before.flatMap(r => Object.keys(r.snapshot?.objects ?? {})).map(pathKey));
	const isNew = (object: string) => !listedBefore.has(pathKey(object))
		&& !(existsSync(join(root, object)) ? readdirSync(join(root, object)) : []).some(name => !own(`${object}/${name}`) && existsSync(join(root, object, name, 'version.json')));
	// Inside an object made in an episodes turn (section 1): the snapshots installed before this return, reconciled as the
	// readers do (5.3, snapshotState), mark it `episode_made`, and the request holds a version of its asset, by the latest
	// `variant_of` edges, other than the marked object's own.
	const state = snapshotState(scopedSnapshots(before), tasksOf(record, root));
	const marked = [...state.listed].filter(([, { object }]) => object.episode_made).map(([id]) => id);
	const edges = { edges: state.edges };
	const held = Object.keys(request.versions);
	const under = (path: string, object: string) => pathKey(path) === pathKey(object) || pathKey(path).startsWith(`${pathKey(object)}/`);
	const insideMade = (object: string) => marked.some(m => under(object, m) && held.some(f => under(f, variantRoot(edges, m)) && !under(f, m)));
	for (const path of paths) {
		if (!validPath(path) || !within(root, join(root, path))) { leave(path, 'its name is not a path in the project', kindOf(path)); }
		else if (!inScope(path, request.scope, object => isNew(object) || insideMade(object))) { leave(path, `this session may not add there (${request.scope === 'project' ? 'only an episode\'s sessions add under episodes/' : 'an episode\'s session adds to a shared object only when it is new'})`, kindOf(path)); }
	}

	// An archive or file not in the Computer's store, or whose bytes do not match its hash, is left out; a failed read is
	// not a reason, and is thrown, so the install is tried again.
	const fetched = async (key: string, hash: string, path: string, kind: LeftOut['kind']): Promise<Buffer | undefined> => {
		try { return await fetchKept(store, kept, key, hash); } catch (error) {
			if (error instanceof MissingArtifact) { leave(path, 'the Computer did not store it', kind); return undefined; }
			if (error instanceof MismatchedArtifact) { leave(path, 'its bytes do not match what the Computer named', kind); return undefined; }
			throw error;
		}
	};

	// Pass 1: everything fetched, checked and laid beside its place.
	const staged: { readonly temp: string; readonly target: string; readonly path: string }[] = [];
	// Each temporary sibling has a name of its own, `.pine-install-<random UUID>`, as writeWhole names its file: two places
	// of one folder can hold the same bytes (an identical import, two identical review files), and a name built from a
	// place's own could pass the file system's limit. Leftovers of an earlier run are found by the prefix and removed.
	const temp = (target: string) => join(dirname(target), `${TEMP}${randomUUID()}`);
	// The folders this install makes to hold what it lays down: one left empty once what was left out is removed is
	// removed too, so nothing left out leaves a trace in the drama's folder.
	const made = new Set<string>();
	const parentOf = (target: string) => {
		const first = mkdirSync(dirname(target), { recursive: true });
		for (let dir = dirname(target); first && dir.length >= first.length; dir = dirname(dir)) { made.add(dir); }
	};
	const removeEmpty = () => {
		for (const dir of [...made].sort((a, b) => b.length - a.length)) {
			if (existsSync(dir) && !readdirSync(dir).length) { rmdirSync(dir); }
		}
	};
	for (const dir of new Set(paths.filter(p => !out(p)).map(p => dirname(join(root, p))))) { removeLeftovers(dir); }
	// A private state that cannot be used, here or when the return was read, is left out: the session's next task carries
	// the one it had.
	const previous = () => record.latest(sent.chat)?.private_state ?? null;
	let privateState = ret.private_state ?? ((o.unread ?? []).some(l => l.path === 'the return\'s private state') ? previous() : null);
	try {
		const inputs = new Map<string, string[]>();
		for (const [folder, hash] of Object.entries(returned).filter(([folder]) => !out(folder) && !existsSync(join(root, folder)))) {
			if (!await fetched(versionKey(hash), hash, folder, 'version')) { continue; }
			const target = join(root, folder);
			parentOf(target);
			const dir = temp(target);
			staged.push({ temp: dir, target, path: folder });
			mkdirSync(dir);
			if (!extractSafely(join(kept, versionKey(hash)), dir, name => members.push({ path: `${folder}/${name}`, why: 'it is not a plain file or folder of the project, so it was not written', kind: 'member' }))) {
				leave(folder, 'its archive could not be read', 'version');
				continue;
			}
			const from = inputsOf(join(dir, 'version.json'));
			if (from) { inputs.set(folder, from); } else { leave(folder, 'its version.json cannot be read', 'version'); }
		}
		// A returned version made from one left out is left out too, through the whole of its `inputs` (2.1).
		for (let grew = true; grew;) {
			grew = false;
			for (const [folder, from] of inputs) {
				const gone = !out(folder) && from.find(input => isLeft(input));
				if (gone) { leave(folder, `it was made from ${gone}, which was left out`, 'version'); grew = true; }
			}
		}
		for (const [path, hash] of Object.entries(returnedReviews).filter(([path]) => !out(path))) {
			const version = path.slice(0, path.lastIndexOf('/reviews/'));
			if (isLeft(version)) { leave(path, `its version, ${version}, was left out`, 'review'); continue; }
			const target = join(root, path);
			const here = existsSync(target) ? readFileSync(target) : undefined;
			if (here && sha256(here) !== hash) { leave(path, 'a review file with other contents is already there', 'review'); continue; }
			if (here) { continue; }
			const bytes = await fetched(fileKey(hash), hash, path, 'review');
			if (!bytes) { continue; }
			// A review of a version this return brings goes into that version's extracted folder, which moves with it.
			const folder = staged.find(s => pathKey(target).startsWith(`${pathKey(s.target)}/`));
			if (folder) {
				const inside = join(folder.temp, target.slice(folder.target.length + 1));
				mkdirSync(dirname(inside), { recursive: true });
				writeFileSync(inside, bytes, { flush: true });
				continue;
			}
			parentOf(target);
			const file = temp(target);
			staged.push({ temp: file, target, path });
			writeFileSync(file, bytes, { flush: true });
		}
		if (privateState && privateState === ret.private_state && !await fetched(stateKey(privateState), privateState, 'the session\'s private state', 'part')) {
			privateState = previous();
		}
	} catch (error) {
		for (const { temp: path } of staged) { rmSync(path, { recursive: true, force: true }); }
		removeEmpty();
		throw error;
	}

	// Pass 2: recorded, then into place; what was left out after it was laid beside its place is removed.
	const versions = Object.fromEntries(Object.entries(returned).filter(([folder]) => !out(folder)));
	const reviews = Object.fromEntries(Object.entries(returnedReviews).filter(([path]) => !out(path)));
	const done: Installed = { task: ret.turn, scope: request.scope, chat: sent.chat, sent: sent.sent, versions, reviews, private_state: privateState, snapshot: ret.snapshot ?? null, problems: ret.problems ?? [], installed: new Date().toISOString() };
	await record.installed(done);
	for (const { temp: path, target, path: name } of staged) {
		if (out(name)) { rmSync(path, { recursive: true, force: true }); } else { renameSync(path, target); }
	}
	removeEmpty();

	// A version made from a version the person deleted while the task ran is installed and marked deleted too, as is every
	// returned version made from it.
	await markMadeFromDeleted(root, request, Object.keys(versions));
	return { done, leftOut: [...left.values(), ...members] };
}

/**
 * The versions a version was made from (2.1, `inputs`), as `<object>/<version>`: none for a folder without version.json,
 * which is not a version, and undefined when its version.json is not a file of JSON. Read as leniently as that, not against the
 * schema, so a version.json an older Computer side wrote still installs: an input that is not `{object, version}` is
 * passed over.
 */
function inputsOf(versionFile: string): string[] | undefined {
	if (!existsSync(versionFile)) { return []; }
	if (!statSync(versionFile).isFile()) { return undefined; }
	let record: unknown;
	try { record = JSON.parse(readFileSync(versionFile, 'utf8')); } catch (error) { if (error instanceof SyntaxError) { return undefined; } throw error; }
	const inputs = (record as { inputs?: unknown } | null)?.inputs;
	return (Array.isArray(inputs) ? inputs : []).filter((i): i is VersionRef => typeof i?.object === 'string' && typeof i?.version === 'string').map(i => `${i.object}/${i.version}`);
}

/** Marks the versions of `folders` made, directly or through each other, from a version deleted after `request` was sent. */
async function markMadeFromDeleted(root: string, request: Request, folders: readonly string[]): Promise<void> {
	const now = await readChoices(root);
	const deleted = (choices: typeof now, input: VersionRef) => (choices?.objects[input.object]?.discarded ?? []).includes(input.version);
	const inputs = new Map(folders.map(folder => [folder, (inputsOf(join(root, folder, 'version.json')) ?? []).map(ref => ({ object: dirname(ref), version: basename(ref) }))]));
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
		// A preview that cannot be used is skipped: its version comes with the return, or is said there.
		let progress: ReturnType<typeof check<'progress'>>;
		try {
			progress = check('progress', JSON.parse(bytes.toString('utf8')), key);
			await fetchKept(o.store, o.kept, versionKey(hash), hash);
		} catch (error) {
			if (error instanceof ProtocolDocumentError || error instanceof SyntaxError || error instanceof MissingArtifact || error instanceof MismatchedArtifact) { continue; }
			throw error;
		}
		const target = join(previews, hash);
		if (!existsSync(target)) {
			mkdirSync(previews, { recursive: true });
			const dir = join(previews, `${TEMP}${hash}`);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			try {
				extractSafely(join(o.kept, versionKey(hash)), dir, () => undefined);
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
