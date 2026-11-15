// Everything the Studio knows of protocol major 1, kept only to convert a major-1 project to major 2
// (convertMajor1ProjectToMajor2.ts, doc/protocol.md section 7): its documents' types, its choices and version folders
// as the folder holds them, the Studio's own record of its turns, and what its snapshots said. Nothing else reads it.
// No vscode import.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeWhole } from './placement';
import { episodeIn, isEpisode } from './project';
import { projectIdentity } from './projectPlace';
import { isProtocolPath, type Edge, type ObjectType } from './protocol';
import { sha256 } from './sha256';

/** The one major these documents are. */
export const MAJOR = 1;

export type Hash = string;
/** Path → hash: version folders (of their archives), review files, client files. */
export type Folders = Readonly<Record<string, Hash>>;

export interface Chosen {
	readonly version?: string;
	readonly import?: string;
	readonly words?: string;
}

export interface ObjectChoice {
	readonly chosen?: Chosen;
	readonly discarded?: readonly string[];
	readonly prompt?: string;
	readonly description?: string;
	readonly removed?: true;
}

export interface Choices {
	readonly schema: 1;
	readonly objects: Readonly<Record<string, ObjectChoice>>;
}

export interface VersionRef {
	readonly object: string;
	readonly version: string;
}

export interface VersionRecord {
	readonly schema: 1;
	readonly made_at: string;
	readonly file: string | null;
	readonly inputs: readonly VersionRef[];
	readonly prompt: string | null;
	readonly from_import: string | null;
}

export interface Request {
	readonly turn: string;
	readonly choices: Choices | null;
	readonly versions: Folders;
}


export interface SnapshotObject {
	readonly type: ObjectType;
	readonly name: string;
	readonly segment: string | null;
	readonly inputs?: readonly string[];
}


export interface Snapshot {
	readonly observed_at: string;
	readonly objects: Readonly<Record<string, SnapshotObject>>;
	readonly edges: readonly Edge[];
}

export interface ProtocolError {
	readonly code: 'not_found' | 'not_allowed' | 'invalid' | 'missing_input' | 'interrupted' | 'failed' | 'unsupported_schema';
	readonly message: string;
	readonly action?: string;
}

/**
 * A map of a document read as one, whatever it was given as, and each member as an object: a reader then finds nothing in
 * what it does not know, rather than failing on it (section 6.1).
 */
export const mapOf = <T>(value: unknown): Record<string, T> => Object.fromEntries(Object.entries(Object(value ?? {})).map(([key, member]) => [key, Object(member)]));

/** A document of a major this client does not speak: `unsupported_schema`; nothing of it is applied. */
export class UnsupportedMajor extends Error {
	constructor(readonly what: string, readonly major: unknown) {
		super(`${what} is protocol major ${String(major)}; this Studio speaks major ${MAJOR} only`);
		this.name = 'UnsupportedMajor';
	}
}

export const CHOICES_FILE = 'choices.json';
export const VERSION_FILE = 'version.json';
export const REVIEWS = 'reviews';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The folder's `choices.json`, or null when it has none: then nothing is overridden. It is read as it is: one hand-edited, synced or written by another Studio keeps every choice it holds, and a part it lacks, or
 * gives as something else, is empty. Only another major cannot be read.
 */
export async function readChoices(root: string): Promise<Choices | null> {
	let text: string;
	try {
		text = await readFile(join(root, CHOICES_FILE), 'utf8');
	} catch (error) {
		if (missing(error)) { return null; }
		throw error;
	}
	const given = Object(JSON.parse(text)) as Partial<Choices>;
	if (given.schema !== MAJOR && given.schema !== undefined) { throw new UnsupportedMajor(join(root, CHOICES_FILE), given.schema); }
	return { ...given, schema: MAJOR, objects: mapOf(given.objects) };
}



export interface Version {
	readonly id: string;
	readonly record: VersionRecord;
	/** Whether it holds a review of its own (its reviews/ folder): an accepted version needs no words to be chosen. */
	readonly reviewed: boolean;
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
		const record = versionRecordOf(raw);
		let names: string[] = [];
		try { names = (await readdir(join(folder, id, REVIEWS))).filter(n => n.endsWith('.json') && !n.startsWith('.')); } catch (error) { if (!missing(error)) { throw error; } }
		out.push({ id, record, reviewed: names.length > 0 });
	}
	return out.sort((a, b) => a.record.made_at < b.record.made_at ? -1 : a.record.made_at > b.record.made_at ? 1 : byId(a.id, b.id));
}

/**
 * A version.json read as it is (doc/protocol.md, 6.1), by the install and the readers alike: of its `inputs`, those that
 * name a version, and none when it has none. A `file` that is not a path in the version's folder, one that leaves it, is
 * no file (section 1), so no picture is ever read from outside it.
 */
export function versionRecordOf(raw: unknown): VersionRecord {
	const record = Object(raw) as Partial<VersionRecord>;
	return { ...record, file: isProtocolPath(record.file) ? record.file : null, inputs: Object.values(record.inputs ?? {}).filter(i => typeof i?.object === 'string' && typeof i?.version === 'string') } as VersionRecord;
}

/** Version ids in order: letters as strings, then digits as numbers, so v9 comes before v10. */
function byId(a: string, b: string): number {
	const [, la = a, da = ''] = /^([a-z]+)(\d+)$/.exec(a) ?? [];
	const [, lb = b, db = ''] = /^([a-z]+)(\d+)$/.exec(b) ?? [];
	return la < lb ? -1 : la > lb ? 1 : Number(da) - Number(db);
}

/**
 * An object's current version (major 1's doc/protocol.md 3.2): the person's choice, when it names a version that is
 * there, not discarded, of an object not removed, with the words it needs (a review, or the person's own import);
 * otherwise the newest not discarded.
 */
export function currentVersion(versions: readonly Version[], choices: Choices | null, object: string): string | null {
	const entry = choices?.objects[object] ?? {};
	const discarded = new Set(entry.discarded ?? []);
	// Made from an import only when it names one: an older record has no `from_import` at all.
	const own = (v: Version) => v.record.from_import != null;
	const chosenId = entry.chosen?.version
		?? (entry.chosen?.import !== undefined ? versions.find(v => v.record.from_import === entry.chosen!.import)?.id : undefined);
	const named = entry.removed === true || chosenId === undefined || discarded.has(chosenId) ? undefined : versions.find(v => v.id === chosenId);
	const chosen = named && (entry.chosen?.words || named.reviewed || own(named)) ? named : undefined;
	return (chosen ?? versions.filter(v => !discarded.has(v.id)).at(-1))?.id ?? null;
}

/** What the Studio keeps of an installed return (doc/protocol.md, 4.3): enough for the next request and the readers. */
export interface Installed {
	readonly task: string;
	readonly scope: string;
	/** When its request was sent (DramaRecord.sentRequest): of two returns of a session, the later-sent one is the session's. */
	readonly sent: string;
	readonly versions: Folders;
	readonly reviews: Folders;
	readonly snapshot: Snapshot | null;
	/** The choices the Computer side could not apply (4.3, `problems`), shown on their cards until the session's next return. */
	readonly problems: readonly { readonly ref: string; readonly error: ProtocolError }[];
	/** When it was installed or dealt with (RFC 3339): returns are ordered by it (doc/protocol.md, 4.4). */
	readonly installed: string;
}

/**
 * What a turn leaves in the drama's folder, `turns/<turn id>.json` (doc/protocol.md, 4.4): the return as installed, and the
 * versions and choices its request carried, so that every Studio shows the project the same, from the folder alone.
 * Nothing of the person's session travels: no Chat, private state or notes.
 */
export interface Turn {
	readonly schema: 1;
	readonly task: string;
	readonly scope: string;
	readonly sent: string;
	readonly installed: string;
	readonly request: Pick<Request, 'versions' | 'choices'>;
	readonly versions: Folders;
	readonly reviews: Folders;
	readonly problems: Installed['problems'];
	readonly snapshot: Snapshot | null;
}

/** A request as the Studio sent it (DramaRecord.sentRequest). */
export interface SentTask {
	readonly sent: string;
	readonly computer: string;
	readonly chat: string;
	readonly request: Request;
}

/** Writes `path` whole (placement.ts, writeWhole), its folder made first. */
async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeWhole(path, JSON.stringify(value));
}

const readJson = <T>(path: string): T | undefined => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined;

/** The turns the drama's folder holds (Turn), oldest installed first. */
export function turnsOf(root: string): Turn[] {
	const dir = join(root, 'turns');
	return (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : []).map(n => readJson<Turn>(join(dir, n))!)
		.sort((a, b) => a.installed.localeCompare(b.installed));
}

/**
 * The Studio's record of one drama, under its storage, outside the drama's folder: each request as sent
 * (`requests/<task>.json`), each return dealt with (`returns/<task>.json`), and each session's latest
 * (`sessions/<chat>.json`). What the project is travels with the folder instead (Turn): the returns read from there, so a
 * request names the archives every Studio knows of.
 */
export class DramaRecord {
	constructor(readonly dir: string, readonly root: string) { }

	returnPath(task: string): string { return join(this.dir, 'returns', `${task}.json`); }
	requestPath(task: string): string { return join(this.dir, 'requests', `${task}.json`); }


	sentTask(task: string): SentTask | undefined { return readJson<SentTask>(this.requestPath(task)); }

	/** Whether the task's return was dealt with: installed, refused, or found missing at its turn's end (handle). */
	handled(task: string): boolean { return existsSync(this.returnPath(task)); }

	/** Writes the turn of a return dealt with into the drama's folder (Turn), from the return and its request as sent. */
	publish(done: Installed): Promise<void> {
		const request = this.sentTask(done.task)?.request;
		return writeJson(join(this.root, 'turns', `${done.task}.json`), {
			schema: 1, task: done.task, scope: done.scope, sent: done.sent, installed: done.installed,
			request: { versions: request?.versions ?? {}, choices: request?.choices ?? null },
			versions: done.versions, reviews: done.reviews, problems: done.problems, snapshot: done.snapshot,
		} satisfies Turn);
	}

	/**
	 * Writes into the folder every return this record dealt with whose turn the folder lacks: those dealt with before turns
	 * travelled with the folder, or by a Studio stopped between the two writes.
	 */
	async publishKept(): Promise<void> {
		for (const done of this.keptReturns()) { await this.publish(done); }
	}

	/** The returns publishKept writes: those this record dealt with whose turn the folder lacks. */
	keptReturns(): Installed[] {
		const dir = join(this.dir, 'returns');
		return (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : []).map(n => readJson<Installed>(join(dir, n))!)
			.filter(done => done.installed && !existsSync(join(this.root, 'turns', `${done.task}.json`)));
	}

	/** Every request sent from this drama, oldest first. */
	requests(): SentTask[] {
		const dir = join(this.dir, 'requests');
		return (existsSync(dir) ? readdirSync(dir) : []).filter(n => n.endsWith('.json')).map(n => this.sentTask(n.slice(0, -'.json'.length))!)
			.sort((a, b) => a.sent.localeCompare(b.sent));
	}
}

/** The record of the drama at `root` under the protocol storage `storage` (the extension's `<globalStorage>/protocol`). */
export function dramaRecordOf(storage: string, root: string): DramaRecord {
	return new DramaRecord(join(storage, 'dramas', sha256(projectIdentity(root)).slice(0, 32)), root);
}

/**
 * Writes into the folder at `root` the turns every record of this Studio profile holds for it and the folder lacks
 * (DramaRecord.publishKept): the protocol storage of each connection, and the one used before connections had their own.
 */
export async function publishKeptTurns(globalStorage: string, root: string): Promise<void> {
	for (const record of dramaRecordsOf(globalStorage, root)) { await record.publishKept(); }
}

/** Every record of this Studio profile for the drama at `root`: the protocol storage of each connection, and the one used before connections had their own. */
export function dramaRecordsOf(globalStorage: string, root: string): DramaRecord[] {
	const connections = join(globalStorage, 'connections');
	const storages = [join(globalStorage, 'protocol'), ...(existsSync(connections) ? readdirSync(connections).map(c => join(connections, c, 'protocol')) : [])];
	return storages.map(storage => dramaRecordOf(storage, root));
}

/** The drama's requests as snapshotState reads them (TasksOf): the request of every turn the folder holds. */
export function tasksOf(root: string): TasksOf {
	return { requests: () => turnsOf(root).map(t => ({ request: { turn: t.task, versions: t.request.versions } })) };
}

/** The snapshots of `returns`, in install order, each with its session's scope, its task and its times. */
export function scopedSnapshots(returns: readonly Pick<Turn, 'task' | 'scope' | 'sent' | 'installed' | 'snapshot'>[]): { readonly scope: 'project' | 'episodes'; readonly snapshot: Snapshot; readonly task: string; readonly sent: string; readonly installed: string }[] {
	return [...returns].sort((a, b) => a.installed.localeCompare(b.installed))
		.flatMap(r => r.snapshot ? [{ scope: r.scope === 'project' ? 'project' as const : 'episodes' as const, snapshot: r.snapshot, task: r.task, sent: r.sent, installed: r.installed }] : []);
}

/**
 * An installed return's snapshot, with the scope of the task it came from (doc/protocol.md, section 1), its task id, when
 * its request was sent and when its return was installed (section 4.4).
 */
export interface ScopedSnapshot {
	readonly scope: 'project' | 'episodes';
	readonly snapshot: Snapshot;
	readonly task: string;
	readonly sent: string;
	readonly installed: string;
}

/** The drama's requests (tasksOf): each one's turn and the version folders it carried. */
export interface TasksOf {
	requests(): readonly { readonly request: Pick<Request, 'turn' | 'versions'> }[];
}

/**
 * What the installed snapshots say now (doc/protocol.md, 5.3): each object from the latest snapshot that lists it, and
 * the edges from it. An object a later snapshot of its scope no longer lists is removed, when that turn's request
 * knew it: a version folder of it was in the request, or a snapshot installed before then listed it (5.3).
 */
export function snapshotState(snapshots: readonly ScopedSnapshot[], tasks?: TasksOf): { readonly listed: ReadonlyMap<string, { readonly object: Snapshot['objects'][string]; readonly at: string; readonly from: Snapshot }>; readonly edges: readonly Edge[] } {
	const requested = new Map((tasks?.requests() ?? []).map(r => [r.request.turn, Object.keys(r.request.versions)]));
	const listed = new Map<string, { object: Snapshot['objects'][string]; at: string; from: Snapshot }>();
	for (const { scope, snapshot, task, sent } of snapshots) {
		const ids = Object.keys(snapshot.objects);
		const folders = requested.get(task) ?? [];
		const before = snapshots.filter(s => s.installed < sent);
		const knew = (id: string) => folders.some(f => f.startsWith(`${id}/`)) || before.some(s => id in s.snapshot.objects);
		// The Project Chat's snapshot lists the shared objects and every episode: one it no longer lists is removed.
		if (scope === 'project') {
			for (const id of [...listed.keys()].filter(id => !(id in snapshot.objects) && (!episodeIn(id) || isEpisode(id)) && knew(id))) {
				listed.delete(id);
			}
		}
		// An episode session's snapshot that lists an episode lists all of that episode's objects: one it no longer lists
		// is removed. (The Project Chat's lists every episode object, but not what lies inside them.)
		for (const episode of scope === 'episodes' ? ids.filter(isEpisode) : []) {
			for (const id of [...listed.keys()].filter(id => !(id in snapshot.objects) && !isEpisode(id) && episodeIn(id) === episodeIn(episode) && knew(id))) {
				listed.delete(id);
			}
		}
		for (const [id, object] of Object.entries(snapshot.objects)) {
			listed.set(id, { object, at: snapshot.observed_at, from: snapshot });
		}
	}
	// An edge goes with its `from` object: the snapshot that object comes from gives its edges.
	const edges = snapshots.flatMap(({ snapshot }) => snapshot.edges.filter(e => listed.get(e.from)?.from === snapshot));
	return { listed, edges };
}
