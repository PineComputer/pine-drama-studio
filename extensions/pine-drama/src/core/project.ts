// A drama read from its folder in the protocol's form (doc/protocol.md): the version folders and the person's
// choices.json, which are always current, and the snapshots of the installed returns, which say what
// the files do not: names, readiness, edges, planned objects. The Outline and Versions read
// it here; nothing writes. No vscode import.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { CHOICES_FILE, readChoices, readVersions, resolve, VERSION_FILE, type Resolved, type Version as ProtocolVersion } from './choices';
import { projectIdentity } from './projectPlace';
import { check, type Add, type Choices, type Edge, type ObjectType, type ProtocolError, type Request, type Snapshot } from './protocol';

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

/** The snapshots of the drama's installed returns, oldest installed first (core/taskRun.ts, installedSnapshots). */
export type SnapshotOf = () => readonly ScopedSnapshot[];

/**
 * A version a running task has finished and the Studio has downloaded, not installed yet (doc/protocol.md, section 4.6):
 * its folder, extracted in the drama's record outside the drama's folder (core/taskRun.ts, previewVersions).
 */
export interface PreviewVersion {
	readonly object: string;
	readonly version: string;
	/** The extracted version folder, absolute. */
	readonly dir: string;
}

/** The downloaded versions not installed yet. */
export type PreviewsOf = () => readonly PreviewVersion[];

/**
 * The drama's tasks (core/taskRun.ts, tasksOf): each request as sent, with the Chat that sent it when this Studio did
 * (empty otherwise), and each return dealt with, with the problems it named.
 */
export interface TasksOf {
	requests(): readonly { readonly sent: string; readonly chat: string; readonly request: Pick<Request, 'turn' | 'scope' | 'choices' | 'versions'> }[];
	returns(): readonly { readonly task: string; readonly scope: string; readonly sent: string; readonly problems?: readonly { readonly ref: string; readonly error: ProtocolError }[] }[];
}

/** One object as the client shows it (doc/protocol.md, section 5.3): its scope's snapshot, its files and the person's choices. */
export interface DramaObject {
	readonly id: string;
	readonly type: ObjectType;
	readonly name: string;
	readonly segment: string | null;
	readonly usable: boolean;
	readonly why: string | null;
	readonly making: boolean;
	/** The person's prompt and description where they set one, else the agent's; null when not editable. */
	readonly prompt: string | null;
	readonly description: string | null;
	/** For an object with no version yet: the objects its first version will be made from. */
	readonly plannedInputs: readonly string[];
	readonly fromAdd: string | null;
	/** When its scope's snapshot was observed: readiness, `making` and edges are as of then. */
	readonly observedAt: string;
	/**
	 * The person's choice for it that its scope's last request did not carry: the Chat that sent that
	 * request, whose next run carries it, or null when the scope has sent none. Null when nothing is outgoing.
	 */
	readonly outgoing: { readonly chat: string | null } | null;
	/** The problem the scope's last return named for it, or null. */
	readonly problem: ProtocolError | null;
	/** Oldest first, the downloaded versions not installed yet among them. */
	readonly versions: readonly ProtocolVersion[];
	/** Each downloaded version's folder, absolute, by version id; an installed version's folder is `<id>/<version>`. */
	readonly previews: ReadonlyMap<string, string>;
	readonly resolved: Resolved;
}

export interface Drama {
	readonly objects: ReadonlyMap<string, DramaObject>;
	readonly edges: readonly Edge[];
	/** The person's adds no snapshot object names yet: shown as cards until the Computer makes them objects. */
	readonly adds: readonly Add[];
	readonly choices: Choices | null;
	/** Each add a running task carries, by its id: the Chat that sent it. */
	readonly addsInFlight: ReadonlyMap<string, string>;
	/** The problem the last return of its scope named for each add, by the add's id. */
	readonly addProblems: ReadonlyMap<string, ProtocolError>;
	/**
	 * Each version listed as an input where no snapshot lists its object (a scene's floor plan), by `<object>/<version>`:
	 * its folder (versionFolder's form) and the file its version.json shows, read for display only.
	 */
	readonly unlisted: ReadonlyMap<string, { readonly folder: string; readonly file: string }>;
}

/**
 * What the installed snapshots say now (doc/protocol.md, 5.3): each object from the latest snapshot that lists it, and
 * the edges from it, after the removals readDrama describes. readDrama reads the drama's files on top of it; a reader
 * that needs only names, types and edges, such as a review card's titles, reads this alone.
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

/**
 * Reads the drama. Each object, and each edge from it, comes from the latest installed snapshot that lists the object,
 * labelled with that snapshot's `observed_at`, whichever session returned it. A later snapshot that should list an object
 * and does not removes it, but only an object the client knew when that turn's request was sent: a version folder of it
 * was in the request, or a snapshot installed before then listed it (doc/protocol.md, sections 1 and 5.3). So a shared
 * object an episode turn made is not removed by a Project Chat turn that never saw it. The person's `removed` removes an
 * object with every variant derived from it.
 */
export async function readDrama(root: string, snapshotOf: SnapshotOf, previewsOf: PreviewsOf = () => [], tasks?: TasksOf): Promise<Drama> {
	const { listed, edges } = snapshotState(snapshotOf(), tasks);
	const choices = await readChoices(root);
	const removed = new Set(Object.entries(choices?.objects ?? {}).filter(([, c]) => c.removed).map(([id]) => id));
	// A variant of a removed object is removed with it, down its chain.
	for (let grew = true; grew;) {
		grew = false;
		for (const e of edges) {
			if (e.kind === 'variant_of' && removed.has(e.to) && !removed.has(e.from)) {
				removed.add(e.from);
				grew = true;
			}
		}
	}
	const objects = new Map<string, DramaObject>();
	const previewed = previewsOf();
	// A scope's last request, and its last return: what the Computer has seen of the choices, and the problems it named.
	const requests = [...tasks?.requests() ?? []].sort((a, b) => a.sent.localeCompare(b.sent));
	const returns = [...tasks?.returns() ?? []].sort((a, b) => a.sent.localeCompare(b.sent));
	const scopeOfId = (id: string) => episodeIn(id) ? 'episodes' : 'project';
	const lastRequest = (scope: string) => requests.filter(r => r.request.scope === scope).at(-1);
	const problems = new Map<string, ProtocolError>();
	for (const scope of ['project', 'episodes']) {
		for (const p of returns.filter(r => (r.scope === 'project' ? 'project' : 'episodes') === scope).at(-1)?.problems ?? []) {
			problems.set(p.ref, p.error);
		}
	}
	const outgoing = (id: string) => {
		const last = lastRequest(scopeOfId(id));
		const mine = JSON.stringify(choices?.objects[id] ?? null);
		return mine !== JSON.stringify(last?.request.choices?.objects[id] ?? null) ? { chat: last?.chat || null } : null;
	};
	await Promise.all([...listed].filter(([id]) => !removed.has(id)).map(async ([id, { object, at }]) => {
		const installed = await readVersions(root, id);
		// A downloaded version shows like any other until its return installs it.
		const previews = new Map(previewed.filter(p => p.object === id && !installed.some(v => v.id === p.version)).map(p => [p.version, p.dir]));
		const versions = [...installed, ...await Promise.all([...previews].map(async ([version, dir]) =>
			({ id: version, reviews: [], record: check('versionRecord', JSON.parse(await readFile(join(dir, VERSION_FILE), 'utf8')), join(dir, VERSION_FILE)) })))]
			.sort((a, b) => a.record.made_at < b.record.made_at ? -1 : a.record.made_at > b.record.made_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		const mine = choices?.objects[id];
		objects.set(id, {
			id, type: object.type, name: object.name, segment: object.segment, usable: object.usable, why: object.why ?? null, making: object.making === true,
			prompt: mine?.prompt ?? object.prompt ?? null, description: mine?.description ?? object.description ?? null,
			plannedInputs: object.inputs ?? [], fromAdd: object.from_add, observedAt: at, versions, previews, resolved: resolve(versions, choices, id),
			outgoing: outgoing(id), problem: problems.get(id) ?? null,
		});
	}));
	const made = new Set([...objects.values()].map(o => o.fromAdd).filter(Boolean));
	const unlistedInputs = new Set([...objects.values()].flatMap(o => o.versions.flatMap(v => v.record.inputs))
		.filter(input => !objects.has(input.object)).map(input => `${input.object}/${input.version}`));
	const unlisted = new Map((await Promise.all([...unlistedInputs].map(async key => {
		// A downloaded version's folder is its preview's (absolute), as versionFile reads it; an installed one's, in the project.
		const folder = previewed.find(p => `${p.object}/${p.version}` === key)?.dir ?? key;
		const at = join(isAbsolute(folder) ? folder : join(root, ...key.split('/')), VERSION_FILE);
		// A folder the record names but the project does not hold, or holds unreadable or invalid (its `file` a path the
		// protocol's versionRecord refuses), shows no picture.
		const file = await readFile(at, 'utf8').then(text => check('versionRecord', JSON.parse(text), at).file).catch(() => null);
		return file ? [[key, { folder, file }] as const] : [];
	}))).flat());
	return {
		objects,
		edges: edges.filter(e => objects.has(e.from) && objects.has(e.to)),
		adds: (choices?.added ?? []).filter(a => !made.has(a.id)),
		choices,
		addsInFlight: new Map(requests.filter(r => !returns.some(d => d.task === r.request.turn))
			.flatMap(r => (r.request.choices?.added ?? []).filter(a => !made.has(a.id)).map(a => [a.id, r.chat] as const))),
		addProblems: new Map((choices?.added ?? []).filter(a => problems.has(a.id)).map(a => [a.id, problems.get(a.id)!])),
		unlisted,
	};
}

/** One node of the Outline: a group, or an object of the drama. */
export interface OutlineNode {
	/** An object's id (its folder), or a group's path or synthetic `#group/...` id. */
	readonly id: string;
	readonly label: string;
	readonly kind: 'group' | 'stage';
	/** What it holds, for icons. */
	readonly role: Role;
	/** An object's id, where the node is one. */
	readonly stagePath?: string;
	readonly hasChildren: boolean;
	readonly description?: string;
	readonly tooltip?: string;
	/** A Script row's episode: the episode object's id. */
	readonly episode?: string;
}

export type Role = 'project' | 'script' | 'bible' | 'assets' | 'characters' | 'character' | 'look' | 'scenes' | 'location' | 'view' | 'props' | 'prop'
	| 'episodes' | 'episode' | 'breakdown' | 'storyboard' | 'segment' | 'cut' | 'other'
	| 'script-episode' | 'script-later' | 'voices' | 'motion' | 'note';

/** An object's role, for its icon; a variant takes its asset's (variantRoot). */
export function roleOf(drama: Drama, object: DramaObject): Role {
	switch (object.type) {
		case 'screenplay': return 'script';
		case 'bible': return 'bible';
		case 'character': return 'character';
		case 'scene': return 'location';
		case 'prop': return 'prop';
		case 'variant': {
			const root = drama.objects.get(variantRoot(drama, object.id));
			return root?.type === 'character' ? 'look' : root?.type === 'scene' ? 'view' : 'prop';
		}
		case 'episode': return 'episode';
		case 'breakdown': return 'breakdown';
		case 'storyboard': case 'keyframe': return 'storyboard';
		case 'take': return 'segment';
		case 'cut': return 'cut';
		default: return 'other';
	}
}

/** The asset a variant derives from, down its `variant_of` chain; the object itself when it is no variant. */
export function variantRoot(drama: Pick<Drama, 'edges'>, id: string): string {
	const seen = new Set<string>();
	let at = id;
	for (let up = variantParent(drama, at); up && !seen.has(up); up = variantParent(drama, at)) {
		seen.add(at);
		at = up;
	}
	return at;
}

/** Script's row of each episode, in episode order: its breakdown once it has one, which the row describes; it opens the screenplay. */
function scriptRows(drama: Drama): OutlineNode[] {
	const objects = [...drama.objects.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
	return objects.filter(ep => ep.type === 'episode').map(ep => {
		const breakdown = objects.find(b => b.type === 'breakdown' && episodeIn(b.id) === episodeIn(ep.id));
		return breakdown
			? { ...stage(drama, breakdown, ep.name, false), episode: ep.id }
			: { id: `#script/${ep.id}`, label: ep.name, kind: 'group' as const, role: 'script-episode' as const, hasChildren: false, episode: ep.id };
	});
}

/** The episode a tree row stands for: a Script row names it (`episode`), any other row by its id. */
export function episodeOfNode(node: Partial<OutlineNode> | undefined): string | undefined {
	return episodeIn(node?.episode ?? node?.id ?? '');
}

/** What naming reads: each object's name and the edges (a Drama, or the snapshots' state alone, snapshotState). */
export interface Named {
	readonly objects: ReadonlyMap<string, { readonly name: string }>;
	readonly edges: readonly Edge[];
}

/**
 * An object's name for the person, as the assets canvas names a card where no frame names its asset
 * (assetsCanvas.ts cardLabel): a variant after its asset's name, an episode's object after its episode, each from the
 * snapshots (doc/protocol.md, 5.1, `name`); an object no snapshot names yet, by its folder.
 */
export function objectTitle(drama: Named, id: string): string {
	const name = (object: string) => drama.objects.get(object)?.name ?? object.split('/').at(-1)!;
	const episode = episodeIn(id);
	const asset = variantRoot(drama, id);
	return [episode && id !== `episodes/${episode}` ? episode : '', asset !== id ? name(asset) : '', name(id)].filter(Boolean).join(' · ');
}

/** A version's name for the person: its object's (objectTitle) and the version, a take by its number (`t02` is take 2). */
export function versionTitle(drama: Named, object: string, version: string): string {
	const take = /^t(\d+)$/.exec(version);
	return `${objectTitle(drama, object)} · ${take ? `take ${Number(take[1])}` : version}`;
}

/** The object a variant derives from directly (its `variant_of` edge), or undefined. */
export function variantParent(drama: Pick<Drama, 'edges'>, id: string): string | undefined {
	return drama.edges.find(e => e.kind === 'variant_of' && e.from === id)?.to;
}

/**
 * The notes an empty step shows, its next action. Their ids are what the view maps
 * to a command: `NOTE_ATTACH` and `NOTE_INTAKE` open the project's main Chat.
 */
export const NOTE_ATTACH = 'note:script-attach';
export const NOTE_INTAKE = 'note:script-intake';
const NOTES: Record<string, string> = {
	[NOTE_ATTACH]: 'Attach the screenplay and brief in the Project Chat',
	[NOTE_INTAKE]: 'The chat turns the screenplay into Fountain; it appears here for your review',
};
function note(id: keyof typeof NOTES & string): OutlineNode {
	return { id, label: NOTES[id], kind: 'group', role: 'note', hasChildren: false };
}

export interface Pointers {
	readonly current?: string;
	readonly accepted?: string;
}

export interface Review {
	readonly reason: string;
	/** The person's own words, when the person approved. */
	readonly person: string | null;
	readonly acceptedAt: string;
}

/** A version as Versions lists it. */
export interface Version {
	readonly name: string;
	/** Its folder, project-relative. */
	readonly path: string;
	readonly createdAt: string;
	/** The file it shows, project-relative, or null (version.json `file`). */
	readonly file: string | null;
	/** Made from the person's own import. */
	readonly own: boolean;
	readonly discarded: boolean;
	readonly reviews: readonly Review[];
	/** The version it goes on from, written in parts (doc/protocol.md 2.1, `continues`), or null. */
	readonly continues: string | null;
}

/**
 * The version of an object that holds the project-relative file `rel`: the file is the version's folder or inside it.
 * Versions selects this row when a file of the object becomes the active one, as the Explorer selects the active file
 *.
 */
export function versionHolding<T extends Pick<Version, 'path'>>(versions: readonly T[], rel: string): T | undefined {
	return versions.find(version => rel === version.path || rel.startsWith(`${version.path}/`));
}

export interface StageDetail {
	readonly path: string;
	readonly pointers: Pointers;
	/** Who accepted the accepted version. */
	readonly acceptedBy: 'person' | 'agent' | null;
	/** Newest first. */
	readonly versions: readonly Version[];
}

/**
 * The file a version of `object` shows (version.json `file`): project-relative for an installed version, absolute for a
 * downloaded one in the drama's record. Null when it shows none.
 */
export function versionFile(object: DramaObject, version: string | null): string | null {
	const file = object.versions.find(v => v.id === version)?.record.file;
	if (!file || version === null) {
		return null;
	}
	return fileIn(versionFolder(object, version), file);
}

/** `file` (relative, '/'-separated) in a version's folder: a downloaded version's absolute preview folder, or project-relative. */
export function fileIn(folder: string, file: string): string {
	return isAbsolute(folder) ? join(folder, ...file.split('/')) : `${folder}/${file}`;
}

/** A version's folder: project-relative for an installed version, absolute for a downloaded one. */
export function versionFolder(object: DramaObject, version: string): string {
	return object.previews.get(version) ?? `${object.id}/${version}`;
}

/** A Chat's title by its key, as the sessions list shows it (its first message); undefined while unknown. */
export type ChatTitle = (key: string) => string | undefined;

/** The three marks a card shows of the person's choices, in the approved words. */
export function marksOf(drama: Drama, chatTitle: ChatTitle, object: DramaObject | null, add: string | null): {
	outgoing: string | null; inFlight: string | null; problem: { message: string; action: string | null } | null;
} {
	const chat = (key: string | null) => (key && chatTitle(key)) ?? 'its Chat';
	const flying = add ? drama.addsInFlight.get(add) : undefined;
	const problem = object?.problem ?? (add ? drama.addProblems.get(add) : undefined) ?? null;
	return {
		outgoing: object?.outgoing ? `Saved. The agent sees it at ${chat(object.outgoing.chat)}'s next run.` : add && !flying ? 'Saved. The agent sees it at its Chat\'s next run.' : null,
		inFlight: flying ? `Being created in ${chat(flying)}` : null,
		problem: problem && { message: problem.message, action: problem.action ?? null },
	};
}

/** An object's versions and pointers, as Versions shows them. */
export function detailOf(object: DramaObject): StageDetail {
	const { resolved } = object;
	return {
		path: object.id,
		pointers: { ...(resolved.current ? { current: resolved.current } : {}), ...(resolved.accepted ? { accepted: resolved.accepted } : {}) },
		acceptedBy: resolved.acceptedBy,
		versions: object.versions.map(v => ({
			name: v.id, path: `${object.id}/${v.id}`, createdAt: v.record.made_at,
			file: versionFile(object, v.id),
			own: resolved.own(v), discarded: resolved.discarded.has(v.id),
			reviews: v.reviews.map(r => ({ reason: r.reason, person: r.person ?? null, acceptedAt: r.accepted_at })),
			continues: v.record.continues ?? null,
		})).reverse(),
	};
}

/**
 * The parts `version` is written in, itself first: the versions it continues, one after another, while the object
 * holds them (doc/protocol.md 2.1, `continues`). One part for a version that continues none.
 */
export function partsOf(version: string, continues: (version: string) => string | null | undefined): string[] {
	const parts = [version];
	for (let up = continues(version); up && !parts.includes(up); up = continues(up)) { parts.push(up); }
	return parts;
}

/** `continues` within `detail`: the version a held version goes on from, when it is held too and folding it closes no cycle. */
function continuesIn(detail: Pick<StageDetail, 'versions'>): (version: string) => string | null {
	const held = new Map(detail.versions.map(v => [v.name, v]));
	const named = (name: string) => { const up = held.get(name)?.continues; return up && held.has(up) ? up : null; };
	return name => { const up = named(name); return up && !partsOf(up, named).includes(name) ? up : null; };
}

/** How many parts `version` of `detail` is written in: one for a version that continues none. */
export function writtenIn(detail: Pick<StageDetail, 'versions'>, version: string): number {
	return partsOf(version, continuesIn(detail)).length;
}

/** The Versions list's rows: each version no held version continues, with the earlier parts it continues. */
export function versionRows(detail: Pick<StageDetail, 'versions'>): { version: Version; parts: Version[] }[] {
	const held = new Map(detail.versions.map(v => [v.name, v]));
	const continues = continuesIn(detail);
	const continued = new Set(detail.versions.map(v => continues(v.name)));
	return detail.versions.filter(v => !continued.has(v.name))
		.map(version => ({ version, parts: partsOf(version.name, continues).slice(1).map(name => held.get(name)!) }));
}

/** An object's pointers in one line, "accepted v2 by you · working v3", and the parts the working one is written in. */
export function describeStage(detail: Pick<StageDetail, 'pointers' | 'acceptedBy' | 'versions'>): string {
	const { current, accepted } = detail.pointers;
	const parts: string[] = [];
	if (accepted) {
		parts.push(`approved ${accepted}${detail.acceptedBy ? ` by ${detail.acceptedBy === 'person' ? 'you' : 'the agent'}` : ''}`);
	}
	if (current && current !== accepted) {
		parts.push(`working ${current}`);
	}
	// The newest work's parts, after its pointer: the working version's, else the approved one's.
	const shown = current ?? accepted;
	const written = shown ? writtenIn(detail, shown) : 1;
	if (written > 1) {
		parts.push(`written in ${written} parts`);
	}
	return parts.length ? parts.join(' · ') : 'no version';
}

/** A review file as the Versions view lists it: when, who, and the person's words or that it has none. */
export function reviewText(review: Review, date: string): { text: string; tooltip: string } {
	return review.person
		? { text: `Approved ${date} by you: “${review.person}”`, tooltip: `Your words: ${review.person}\nThe agent's reason: ${review.reason}` }
		: { text: `Approved ${date} by the agent, without your words`, tooltip: `The review holds no words of yours: the agent approved it on its own reason.\nThe agent's reason: ${review.reason}` };
}

const ASSET_GROUPS: readonly [string, string, Role, ObjectType][] = [
	['assets/characters', 'characters', 'characters', 'character'], ['assets/scenes', 'scenes', 'scenes', 'scene'], ['assets/props', 'props', 'props', 'prop'],
];

export class DramaProject {
	private read: Promise<Drama> | undefined;

	/**
	 * `snapshotOf`: the installed returns' snapshots (core/taskRun.ts, installedSnapshots). `awaiting`: the empty folder New Project
	 * opened, which awaits its first request (core/projectEntry.ts): the three steps show, and Script's next action is
	 * attaching the screenplay in the Project Chat.
	 */
	constructor(readonly root: string, private readonly snapshotOf: SnapshotOf = () => [], private readonly awaiting = false, private readonly previewsOf: PreviewsOf = () => [],
		private readonly tasks?: TasksOf) { }

	/**
	 * The selected production root only. A folder is a drama to the Studio when it has
	 * choices.json at its root (doc/protocol.md, section 3.1); New Project writes an empty one.
	 */
	static async rootIn(folder: string): Promise<string | undefined> {
		return await DramaProject.isProject(folder) ? projectIdentity(folder) : undefined;
	}

	static async isProject(dir: string): Promise<boolean> {
		try { return (await stat(join(dir, CHOICES_FILE))).isFile(); }
		catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return false; } throw error; }
	}

	/** The drama as its files and snapshots say now; read once until `forget`, which a change of the folder calls. */
	drama(): Promise<Drama> {
		this.read ??= readDrama(this.root, this.snapshotOf, this.previewsOf, this.tasks);
		this.read.catch(() => { this.read = undefined; });
		return this.read;
	}

	forget(): void {
		this.read = undefined;
	}

	/** Children of an Outline node; the root is `undefined`. */
	async children(node?: OutlineNode): Promise<OutlineNode[]> {
		const drama = await this.drama();
		const ofType = (type: ObjectType) => [...drama.objects.values()].filter(o => o.type === type).sort((a, b) => (a.id < b.id ? -1 : 1));
		if (!node) {
			const screenplay = ofType('screenplay')[0];
			return [
				screenplay ? stage(drama, screenplay, '1. Script', true) : group('#script', '1. Script', 'script'),
				group('#assets', '2. Assets', 'assets'),
				group('episodes', '3. Episodes', 'episodes'),
			];
		}
		switch (node.role) {
			case 'script': {
				if (!ofType('screenplay').length) {
					return [note(this.awaiting ? NOTE_ATTACH : NOTE_INTAKE)];
				}
				// The episodes under way, then one row for those not started yet, so a long screenplay's tree starts with the
				// work under way (B18).
				const rows = scriptRows(drama);
				const later = rows.filter(row => !row.stagePath);
				return [
					...rows.filter(row => row.stagePath),
					...(later.length ? [{ ...group('#script/later', `${later.length} not started yet`, 'script-later'), hasChildren: true }] : []),
				];
			}
			case 'script-later':
				return scriptRows(drama).filter(row => !row.stagePath);
			case 'assets':
				return [
					...ASSET_GROUPS.map(([id, label, role, type]) => ({ ...group(id, label, role), hasChildren: ofType(type).length > 0 })),
					// Shown locked until drama-cli has their stages (threeSteps.ts `lockOf`).
					{ ...group('#audio', 'audio', 'voices'), hasChildren: false }, { ...group('#motion', 'motion', 'motion'), hasChildren: false },
				];
			case 'characters': case 'scenes': case 'props':
				return ofType(ASSET_GROUPS.find(([, , role]) => role === node.role)![3]).map(o => stage(drama, o, o.name, variantsOf(drama, o.id).length > 0));
			case 'episodes':
				// An episode is one row, which opens its seg editor (DESIGN-2026-11-08, R1).
				return ofType('episode').map(ep => ({ ...group(ep.id, ep.name, 'episode'), hasChildren: false }));
			default:
				return node.stagePath ? variantsOf(drama, node.stagePath).map(o => stage(drama, o, o.name, variantsOf(drama, o.id).length > 0)) : [];
		}
	}

	/**
	 * The tree's nodes from the top down to the deepest one that holds `path` (a node's own id, an object, or a file
	 * inside a version), found by walking `children()`: the tree is not the folder layout, so the tree itself is the only
	 * hierarchy. Empty when nothing in the tree holds the path.
	 */
	async locate(path: string, under?: OutlineNode): Promise<OutlineNode[]> {
		const holds = (id: string) => path === id || path.startsWith(`${id}/`) || path.startsWith(`${id}#`);
		const level = await this.children(under);
		const direct = level.find(n => holds(n.id));
		if (direct) {
			return [direct, ...(direct.id !== path && direct.hasChildren ? await this.locate(path, direct) : [])];
		}
		for (const deeper of level.filter(n => n.hasChildren)) {
			const below = await this.locate(path, deeper);
			if (below.length) {
				return [deeper, ...below];
			}
		}
		return [];
	}

	/** An object's versions and pointers; an object the drama does not list has none. */
	async detail(object: string): Promise<StageDetail> {
		const found = (await this.drama()).objects.get(object);
		return found ? detailOf(found) : { path: object, pointers: {}, acceptedBy: null, versions: [] };
	}
}

/** The variants derived directly from `id`, by their `variant_of` edges. */
export function variantsOf(drama: Drama, id: string): DramaObject[] {
	return drama.edges.filter(e => e.kind === 'variant_of' && e.to === id).map(e => drama.objects.get(e.from)).filter((o): o is DramaObject => !!o)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Whether `id` is an episode object itself (`episodes/<id>`), not an object inside one. */
function isEpisode(id: string): boolean {
	return /^episodes\/[^/]+$/.test(id);
}

/** The episode folder a tree node or an object belongs to (`EP001` for `episodes/EP001/...`), or undefined. */
export function episodeIn(id: string): string | undefined {
	return /^episodes\/([^/.#][^/#]*)(?:\/|$)/.exec(id)?.[1];
}

function group(id: string, label: string, role: Role): OutlineNode {
	return { id, label, kind: 'group', role, hasChildren: true };
}

function stage(drama: Drama, object: DramaObject, label: string, hasChildren: boolean): OutlineNode {
	return { id: object.id, label, kind: 'stage', role: roleOf(drama, object), stagePath: object.id, hasChildren };
}
