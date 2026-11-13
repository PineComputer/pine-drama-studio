// The person's choices and what they resolve to (doc/protocol.md, section 3). `choices.json` is written only here, always
// whole: a temporary file, fsync, then rename, which the OS makes atomic. Versions and reviews are read from the folder
// itself, never from an index of ours. No vscode import.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { check, type Choices, type ObjectChoice, type Review, type VersionRecord } from './protocol';

export const CHOICES_FILE = 'choices.json';
export const VERSION_FILE = 'version.json';
export const REVIEWS = 'reviews';

const EMPTY: Choices = { schema: 1, objects: {}, added: [], imports: [] };

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The folder's `choices.json`, or null when it has none: then nothing is overridden. */
export async function readChoices(root: string): Promise<Choices | null> {
	let text: string;
	try {
		text = await readFile(join(root, CHOICES_FILE), 'utf8');
	} catch (error) {
		if (missing(error)) { return null; }
		throw error;
	}
	return check('choices', JSON.parse(text), join(root, CHOICES_FILE));
}

/**
 * Writes `file` whole: a sibling temporary file, fsync, then rename. The temporary file's name is unique to the write
 * (a random UUID, as npm's write-file-atomic makes one per call): two writes in the same folder at the same millisecond,
 * such as two sessions recording the same holder (B9), named one file, so one rename found it gone.
 */
export async function writeWhole(file: string, text: string | Uint8Array): Promise<void> {
	const temp = join(dirname(file), `.${randomUUID()}.tmp`);
	const handle = await open(temp, 'w');
	try {
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Changes the folder's choices: `change` gets the current ones (empty when there are none) and returns the new ones,
 * which are checked and written whole. Changes to one folder run one after another, so none is lost; the project window
 * lock keeps every other window out.
 */
export function updateChoices(root: string, change: (choices: Choices) => Choices): Promise<Choices> {
	const run = (queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(async () => {
		const next = check('choices', change((await readChoices(root)) ?? EMPTY), join(root, CHOICES_FILE));
		await writeWhole(join(root, CHOICES_FILE), `${JSON.stringify(next, null, '\t')}\n`);
		return next;
	});
	queues.set(root, run);
	return run;
}

/** `choices` with `object`'s entry changed by `change`; an entry left empty is dropped. */
export function withObject(choices: Choices, object: string, change: (entry: ObjectChoice) => ObjectChoice): Choices {
	const entry = change(choices.objects[object] ?? {});
	const objects = { ...choices.objects };
	if (Object.keys(entry).length) { objects[object] = entry; } else { delete objects[object]; }
	return { ...choices, objects };
}

/**
 * Copies the person's picture to `imports/<id><ext>`: a clone where the file system has them (APFS), a
 * copy otherwise, then a rename into place. Returns the project-relative path.
 */
export async function copyImport(root: string, source: string, id: string): Promise<string> {
	const rel = `imports/${id}${extname(source).toLowerCase()}`;
	const target = join(root, ...rel.split('/'));
	const temp = join(dirname(target), `.${id}.tmp`);
	await mkdir(dirname(target), { recursive: true });
	await copyFile(source, temp, constants.COPYFILE_FICLONE);
	await rename(temp, target);
	return rel;
}

export interface Version {
	readonly id: string;
	readonly record: VersionRecord;
	readonly reviews: readonly Review[];
}

async function dirs(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
	} catch (error) {
		if (missing(error)) { return []; }
		throw error;
	}
}

async function json(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (missing(error)) { return undefined; }
		throw error;
	}
}

/**
 * An object's versions, read from its folder: each subfolder with a `version.json`, with its review files,
 * ordered by `made_at`, then by version id compared as strings. A folder without `version.json` is not a
 * version the client shows.
 */
export async function readVersions(root: string, object: string): Promise<Version[]> {
	const folder = join(root, ...object.split('/'));
	const out: Version[] = [];
	for (const id of await dirs(folder)) {
		const raw = await json(join(folder, id, VERSION_FILE));
		if (raw === undefined) { continue; }
		const record = check('versionRecord', raw, join(object, id, VERSION_FILE));
		const reviews: Review[] = [];
		const reviewDir = join(folder, id, REVIEWS);
		let names: string[] = [];
		try { names = (await readdir(reviewDir)).filter(n => n.endsWith('.json') && !n.startsWith('.')); } catch (error) { if (!missing(error)) { throw error; } }
		for (const name of names.sort()) {
			reviews.push(check('review', await json(join(reviewDir, name)), join(object, id, REVIEWS, name)));
		}
		out.push({ id, record, reviews });
	}
	return out.sort((a, b) => a.record.made_at < b.record.made_at ? -1 : a.record.made_at > b.record.made_at ? 1 : byId(a.id, b.id));
}

/** Version ids in order: letters as strings, then digits as numbers, so v9 comes before v10. */
function byId(a: string, b: string): number {
	const [, la = a, da = ''] = /^([a-z]+)(\d+)$/.exec(a) ?? [];
	const [, lb = b, db = ''] = /^([a-z]+)(\d+)$/.exec(b) ?? [];
	return la < lb ? -1 : la > lb ? 1 : Number(da) - Number(db);
}

export interface Resolved {
	/** The version used from now on, or null. */
	readonly current: string | null;
	/** The accepted version, or null; never simply the newest. */
	readonly accepted: string | null;
	/** Who accepted it: the person (through choices or a review with their words), or the agent. */
	readonly acceptedBy: 'person' | 'agent' | null;
	readonly discarded: ReadonlySet<string>;
	/** The person removed the object (or an object it derives from; the caller follows `variant_of`). */
	readonly removed: boolean;
	/** Whether a version is the person's own: made from one of their imports. */
	readonly own: (version: Version) => boolean;
	/** Whether choosing `version` needs the person's words. */
	readonly needsWords: (version: Version) => boolean;
}

/** One object's state from its versions and the person's choices (doc/protocol.md, section 3.2). */
export function resolve(versions: readonly Version[], choices: Choices | null, object: string): Resolved {
	const entry = choices?.objects[object] ?? {};
	const discarded = new Set(entry.discarded ?? []);
	const removed = entry.removed === true;
	const own = (v: Version) => v.record.from_import !== null;
	const live = versions.filter(v => !discarded.has(v.id));
	const chosenId = entry.chosen?.version
		?? (entry.chosen?.import !== undefined ? versions.find(v => v.record.from_import === entry.chosen!.import)?.id : undefined);
	const named = removed || chosenId === undefined || discarded.has(chosenId) ? undefined : versions.find(v => v.id === chosenId);
	// No choice when it lacks the words it needs.
	const chosen = named && (entry.chosen?.words || named.reviews.length > 0 || named.record.from_import !== null) ? named : undefined;
	const newest = (list: readonly Version[]) => list.length ? list[list.length - 1] : undefined;
	const byPerson = newest(live.filter(v => v.reviews.some(r => r.person !== undefined)));
	const byAnyone = newest(live.filter(v => v.reviews.length > 0));
	const accepted = chosen ?? byPerson ?? byAnyone;
	return {
		current: (chosen ?? newest(live))?.id ?? null,
		accepted: accepted?.id ?? null,
		acceptedBy: chosen || (accepted && accepted === byPerson) ? 'person' : accepted ? 'agent' : null,
		discarded,
		removed,
		own,
		needsWords: v => !(v.reviews.length > 0 || own(v)),
	};
}
