// The project read from its folder in protocol major 2's form (doc/protocol.md 2.2, section 5): every folder holding
// object.json is an object, with its shown file, the receipt beside it, and the person's description and prompt. Every
// view reads it here (readProjectFromFolder); nothing writes. The major-1 turn flow's snapshots stay below until the
// turn flow moves to major 2. No vscode import.

import { readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHOICES_FILE } from './major1';
import { noFileThere, writeWhole } from './placement';
import { projectIdentity } from './projectPlace';
import { DESCRIPTION_FILE, OBJECT_FILE, PROJECT_MARKER_FILE, PROMPT_FILE, RECEIPT_SUFFIX, majorTwo, type Edge, type ObjectType } from './protocol';




/** A relation object.json states (doc/protocol.md 2.2), or a variant's derivation. */
export interface ObjectEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: 'variant_of' | 'inside_of' | 'appears_in' | 'needs';
}

/** The receipt beside a paid output (doc/protocol.md 2.3): what it was made from, with what prompt, for what cost. */
export interface Receipt {
	readonly paidCallId: string;
	readonly finishedAt: string;
	/** The files it was sent, in order (Image 1..N), each with the sha256 of its bytes then. */
	readonly inputsSentInOrder: readonly { readonly path: string; readonly sha256: string }[];
	readonly promptSent: string | null;
	readonly cost: { readonly usd: number; readonly reportedBy: string } | null;
}

/** One object of the project as every view shows it: a folder holding object.json (doc/protocol.md 2.2). */
export interface ProjectObject {
	/** Its folder, project-relative. */
	readonly id: string;
	readonly type: ObjectType;
	readonly name: string;
	/** Its episode's folder name (`EP001` for `episodes/EP001/…`), or null for a shared object. */
	readonly episode: string | null;
	readonly segment: string | null;
	readonly setting: 'interior' | 'exterior' | null;
	/** Its shown file, project-relative, or null for a planned, empty card. */
	readonly shownFile: string | null;
	/** The receipt beside the shown file, or null: the person's own file, a text, or nothing shown. */
	readonly shownFileReceipt: Receipt | null;
	/** For a variant: the object it derives from. */
	readonly variantOf: string | null;
	/**
	 * The objects its draw request sends, in order, Image 1..N (object.json `objects_sent_by_draw_request`,
	 * doc/protocol.md 2.2): the one source of its lines, drawn or not.
	 */
	readonly objectsSentByDrawRequest: readonly string[];
	/** The text of its description.md and prompt.md, or null without one. */
	readonly description: string | null;
	readonly prompt: string | null;
	/** A paid call for it is under way: sent to the provider, with no terminal state yet (doc/protocol.md 4.5). */
	readonly makingNow: boolean;
}

/** The project as every view reads it, from its folder alone (readProjectFromFolder). */
export interface ProjectReadModel {
	readonly objects: ReadonlyMap<string, ProjectObject>;
	/** Each variant's derivation and each relation its object.json states, between objects the project holds. */
	readonly edges: readonly ObjectEdge[];
}

/** The object a file belongs to among `ids`: the deepest object folder that holds it. */
function owning(ids: Iterable<string>, path: string): string | undefined {
	return [...ids].filter(id => path.startsWith(`${id}/`)).sort((a, b) => b.length - a.length)[0];
}

/** The object of `drama` whose folder holds the project file `path` (its deepest), or undefined. */
export function objectOwningFile(drama: ProjectReadModel, path: string): string | undefined {
	return owning(drama.objects.keys(), path);
}

/**
 * A webview address of a project file that changes when the file does: `address` with its size and modification time
 * as a query, since a result overwrites its file in place (doc/protocol.md 4.4) and a webview keeps what it loaded from
 * an address it has seen.
 */
export function fileAddressByVersion(projectRoot: string, address: (rel: string) => string): (rel: string) => string {
	return rel => {
		const stat = statSync(join(projectRoot, ...rel.split('/')), { throwIfNoEntry: false });
		return stat ? `${address(rel)}?v=${stat.size}-${Math.trunc(stat.mtimeMs)}` : address(rel);
	};
}

/** A file's text, or null when there is none. */
const readTextOrNull = (file: string): Promise<string | null> => readFile(file, 'utf8').catch(error => {
	if (noFileThere(error)) { return null; }
	throw error;
});

/** A receipt's fields as protocol major 2 names them, in the Studio's names. */
function receiptOf(raw: unknown): Receipt {
	const r = Object(raw);
	return {
		paidCallId: String(r.paid_call_id), finishedAt: String(r.finished_at), promptSent: typeof r.prompt_sent === 'string' ? r.prompt_sent : null,
		inputsSentInOrder: Array.isArray(r.inputs_sent_in_order) ? r.inputs_sent_in_order.map((i: unknown) => ({ path: String(Object(i).path), sha256: String(Object(i).sha256) })) : [],
		cost: r.cost && typeof r.cost === 'object' ? { usd: Number(r.cost.usd), reportedBy: String(r.cost.reported_by) } : null,
	};
}

/**
 * Every object.json below `dir` (project-relative `prefix`), never descending into a name starting with "." (.git, a
 * cache): such a name is never a path of the protocol (doc/protocol.md section 1).
 */
async function objectFiles(dir: string, prefix: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const below = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => objectFiles(join(dir, e.name), `${prefix}${e.name}/`)));
	return [...entries.some(e => e.isFile() && e.name === OBJECT_FILE) ? [`${prefix}${OBJECT_FILE}`] : [], ...below.flat()];
}

/** An object's object.json as written, every field kept, a document of protocol major 2 (doc/protocol.md 2.2). */
export async function readObjectFile(projectRoot: string, id: string): Promise<Record<string, any>> {
	return majorTwo(`${id}/${OBJECT_FILE}`, JSON.parse(await readFile(join(projectRoot, ...id.split('/'), OBJECT_FILE), 'utf8')));
}

/**
 * Reads the project at `projectRoot` from its folder (doc/protocol.md 2.2, section 5), the one reader every view uses:
 * every folder holding object.json, outside names starting with "." (section 1), is an object. `makingNow` names the
 * objects a paid call is under way for, as the Studio has read their paid-call states.
 */
export async function readProjectFromFolder(projectRoot: string, makingNow: ReadonlySet<string> = new Set()): Promise<ProjectReadModel> {
	const listed = await objectFiles(projectRoot, '');
	const read = await Promise.all(listed.map(async name => {
		const id = name === OBJECT_FILE ? '' : name.slice(0, -OBJECT_FILE.length - 1);
		const at = (file: string) => join(projectRoot, ...id.split('/'), file);
		const raw = await readObjectFile(projectRoot, id);
		const shown = typeof raw.shown_file === 'string' ? raw.shown_file : null;
		const receipt = shown ? await readTextOrNull(at(`${shown}${RECEIPT_SUFFIX}`)) : null;
		return {
			id, raw, shownFile: shown ? `${id}/${shown}` : null, shownFileReceipt: receipt === null ? null : receiptOf(majorTwo(`${id}/${shown}${RECEIPT_SUFFIX}`, JSON.parse(receipt))),
			description: await readTextOrNull(at(DESCRIPTION_FILE)), prompt: await readTextOrNull(at(PROMPT_FILE)),
		};
	}));
	const ids = new Set(read.map(o => o.id));
	const objects = new Map(read.map(({ id, raw, ...files }): [string, ProjectObject] => [id, {
		id, type: raw.type, name: String(raw.name),
		episode: episodeIn(id) ?? null, segment: typeof raw.segment === 'string' ? raw.segment : null,
		setting: raw.setting === 'interior' || raw.setting === 'exterior' ? raw.setting : null,
		variantOf: typeof raw.variant_of === 'string' ? raw.variant_of : null,
		objectsSentByDrawRequest: Array.isArray(raw.objects_sent_by_draw_request) ? raw.objects_sent_by_draw_request.map(String) : [],
		makingNow: makingNow.has(id), ...files,
	}]));
	const relations = read.flatMap(({ id, raw }) => (Array.isArray(raw.relations) ? raw.relations : []).map((r: unknown) => ({ from: id, to: String(Object(r).to), kind: Object(r).kind })));
	const edges: ObjectEdge[] = [...[...objects.values()].filter(o => o.variantOf).map(o => ({ from: o.id, to: o.variantOf!, kind: 'variant_of' as const })), ...relations]
		.filter(e => ids.has(e.from) && ids.has(e.to));
	return { objects, edges };
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
export function roleOf(drama: ProjectReadModel, object: ProjectObject): Role {
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
export function variantRoot(drama: { readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[] }, id: string): string {
	const seen = new Set<string>();
	let at = id;
	for (let up = variantParent(drama, at); up && !seen.has(up); up = variantParent(drama, at)) {
		seen.add(at);
		at = up;
	}
	return at;
}

/** Script's row of each episode, in episode order: its breakdown once it has one, which the row describes; it opens the screenplay. */
function scriptRows(drama: ProjectReadModel): OutlineNode[] {
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

/** What naming reads: each object's name and the edges (the read model). */
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


/** The object a variant derives from directly (its `variant_of` edge), or undefined. */
function variantParent(drama: { readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[] }, id: string): string | undefined {
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

/** The asset folders (doc/protocol.md 2.2): each folder, its heading, its role and the type of the objects in it. */
export const ASSET_GROUPS: readonly [string, string, Role, ObjectType][] = [
	['assets/characters', 'characters', 'characters', 'character'], ['assets/scenes', 'scenes', 'scenes', 'scene'], ['assets/props', 'props', 'props', 'prop'],
];

/**
 * The major of the drama at `dir`: its pine-drama-project.json's `schema` (doc/protocol.md 2.1); 1 for a major-1 drama, which has
 * choices.json and no marker; undefined for a folder that is neither. A marker or choices.json that is not a file is
 * neither.
 */
export function readProjectMajor(dir: string): number | undefined {
	const marker = fileAt(join(dir, PROJECT_MARKER_FILE));
	if (marker) {
		// A marker always names its major: one that names none is unreadable, never a folder with no project.
		const { schema } = Object(JSON.parse(readFileSync(marker, 'utf8')));
		if (!Number.isInteger(schema)) { throw new Error(`${marker} names no protocol major ("schema")`); }
		return schema;
	}
	return fileAt(join(dir, CHOICES_FILE)) ? 1 : undefined;
}

/** `path` when it is a file (a linked one too), else undefined. */
const fileAt = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;

/** Makes `root` a drama of major 2: its pine-drama-project.json, written whole (doc/protocol.md 2.1). New Project writes it, a conversion last. */
export function writeProjectMarker(root: string): Promise<void> {
	return writeWhole(join(root, PROJECT_MARKER_FILE), `${JSON.stringify({ schema: 2 })}\n`);
}

export class DramaProject {
	private read: Promise<ProjectReadModel> | undefined;

	/**
	 * `awaiting`: the empty folder New Project opened, which awaits its first request (core/projectEntry.ts): the three
	 * steps show, and Script's next action is attaching the screenplay in the Project Chat. `makingNow`: the objects a paid
	 * call is under way for (readProjectFromFolder).
	 */
	constructor(readonly root: string, private readonly awaiting = false, private readonly makingNow: () => ReadonlySet<string> = () => new Set()) { }

	/**
	 * The selected production root only. A folder is a drama to the Studio when its pine-drama-project.json says major 2
	 * (doc/protocol.md 2.1); New Project writes it.
	 */
	static async rootIn(folder: string): Promise<string | undefined> {
		return await DramaProject.isProject(folder) ? projectIdentity(folder) : undefined;
	}

	static async isProject(dir: string): Promise<boolean> {
		return readProjectMajor(dir) === 2;
	}

	/** The project as its folder says now (readProjectFromFolder); read once until `forget`, which a change of the folder calls. */
	drama(): Promise<ProjectReadModel> {
		this.read ??= readProjectFromFolder(this.root, this.makingNow());
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
}

/** The variants derived directly from `id`, by their `variant_of` edges. */
export function variantsOf(drama: ProjectReadModel, id: string): ProjectObject[] {
	return drama.edges.filter(e => e.kind === 'variant_of' && e.to === id).map(e => drama.objects.get(e.from)).filter((o): o is ProjectObject => !!o)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Whether `id` is an episode object itself (`episodes/<id>`), not an object inside one. */
export function isEpisode(id: string): boolean {
	return /^episodes\/[^/]+$/.test(id);
}

/** The episode folder a tree node or an object belongs to (`EP001` for `episodes/EP001/...`), or undefined. */
export function episodeIn(id: string): string | undefined {
	return /^episodes\/([^/.#][^/#]*)(?:\/|$)/.exec(id)?.[1];
}

function group(id: string, label: string, role: Role): OutlineNode {
	return { id, label, kind: 'group', role, hasChildren: true };
}

function stage(drama: ProjectReadModel, object: ProjectObject, label: string, hasChildren: boolean): OutlineNode {
	return { id: object.id, label, kind: 'stage', role: roleOf(drama, object), stagePath: object.id, hasChildren };
}
