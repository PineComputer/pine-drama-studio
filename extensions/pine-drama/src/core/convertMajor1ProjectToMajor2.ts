// Converting a major-1 project to major 2 (doc/protocol.md, section 7). Every major-1 record format the Studio knows is
// in protocol/v2/major1-to-major2-conversion.json: this module applies that table's operations as written and knows no
// record format of its own. The conversion is one write in the project's write queue, and its one commit goes through
// projectHistory. No vscode import.

import { constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { copyWhole, unusedName, writeWhole } from './placement';
import { CHOICES_FILE, dramaRecordsOf, publishKeptTurns, readChoices, readVersions, currentVersion, scopedSnapshots, snapshotState, tasksOf, turnsOf, versionRecordOf, type Choices, type VersionRecord } from './major1';
import { readProjectMajor, writeProjectMarker } from './project';
import { commitPathsToHistory, runInProjectWriteQueue } from './projectHistory';
import { sha256OfFile } from './sha256';
import { DESCRIPTION_FILE, type Edge, ENTRY_FILE, OBJECT_FILE, RECEIPT_SUFFIX, refuseWithUpgradeInstructions, STUDIO_RELEASES_URL } from './protocol';

const TABLE = require('../../protocol/v2/major1-to-major2-conversion.json') as ConversionTable;

interface RelationTarget { readonly only_on?: string; readonly first_existing_of?: readonly string[]; readonly target?: string }
interface RecordStage {
	readonly v1_object_ends_with: string;
	readonly operation: 'split_entry_record_into_object_files' | 'write_receipt_only';
	readonly reads?: string;
	readonly writes: Readonly<Record<string, unknown>>;
	readonly description_field_by_owner_kind?: Readonly<Record<string, string>>;
	readonly entry_json_drop_fields?: readonly string[];
	readonly kind_folder_to_type?: Readonly<Record<string, string>>;
	readonly type_when_owner_is_under?: Readonly<Record<string, string>>;
	readonly object_json_field_from_entry_field?: Readonly<Record<string, string>>;
	readonly relation_kind_from_entry_field?: Readonly<Record<string, string>>;
	readonly relation_target_from_entry_value?: Readonly<Record<string, RelationTarget>>;
	readonly variant_of_rule?: { readonly entry_field: string; readonly from_base_value: string; readonly when_base: string; readonly otherwise: string };
	readonly receipt_when_owner_current_entry_metadata?: Readonly<Record<string, string>>;
}
interface ConversionTable {
	readonly version_folders: {
		readonly version_folder_name_patterns: readonly string[];
		readonly records_in_a_version_folder: { readonly version_record: string; readonly outputs_and_metadata: string; readonly paid_call: string };
		readonly paid_call_settled: { readonly field: string; readonly states: readonly string[] };
	};
	readonly record_stages: readonly RecordStage[];
	readonly objects_dropped: readonly string[];
	readonly every_other_version: {
		readonly skip_folders_in_version: readonly string[];
		readonly skip_files_in_version: readonly string[];
		readonly also_copies: Readonly<Record<string, readonly string[]>>;
		readonly skip_outputs_by_object: Readonly<Record<string, readonly string[] | string>>;
	};
	readonly not_version_folders: {
		readonly newest_version_to_root: { readonly folder: string; readonly file: string };
		readonly dropped: readonly string[];
		readonly dropped_wherever_they_are: readonly string[];
	};
	readonly pictures_that_become_objects: Readonly<Record<string, { readonly type: string; readonly name: string } | string>>;
}

/** The last Studio that reads major 1: where a person goes back to for what this one cannot do with a major-1 project. */
export const LAST_MAJOR_1_STUDIO = { version: '0.2.6', downloadUrl: `${STUDIO_RELEASES_URL}/tag/v0.2.6` } as const;

const AUTHOR = 'client-found-changes-on-disk';
const NAMES = TABLE.version_folders.version_folder_name_patterns.map(p => new RegExp(p));
const RECORDS = TABLE.version_folders.records_in_a_version_folder;
const SETTLED = TABLE.version_folders.paid_call_settled;
const ENTRY = TABLE.record_stages.find(s => s.operation === 'split_entry_record_into_object_files')!;
const CONFIG = TABLE.not_version_folders.newest_version_to_root;
const DROPPED_BY_NAME = new Set(TABLE.not_version_folders.dropped_wherever_they_are);
// Its entries by folder pattern; its `note` is prose.
const PICTURE_OBJECTS = Object.entries(TABLE.pictures_that_become_objects)
	.flatMap(([pattern, rule]) => typeof rule === 'object' ? [{ pattern, ...rule }] : []);

interface Job { readonly attempt_id: string; readonly actual_usd: number | null; readonly connection?: unknown; readonly provider: string; readonly [field: string]: unknown }
interface Major1Version {
	readonly object: string;
	readonly id: string;
	readonly record: VersionRecord;
	/**
	 * Files of the version folder to copy into its object's folder, as the folder holds them (doc/protocol.md 2.1, what is on
	 * disk is the truth): a file the person edited by hand is copied as they left it, and one they deleted or renamed is
	 * not there to copy. The backup keeps the folder as it was.
	 */
	readonly outputs: readonly string[];
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly job: Job | undefined;
}

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** A file name against one of the table's file patterns, `*` standing for any run of characters but `/`. */
const fileMatches = (pattern: string, file: string) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(file);
const segmentsMatch = (pattern: string, id: string) => {
	const [p, s] = [pattern.split('/'), id.split('/')];
	return p.length === s.length && p.every((part, i) => part === '*' || part === s[i]);
};
const stageOf = (object: string) => TABLE.record_stages.find(s => object.endsWith(s.v1_object_ends_with));
const ownerOf = (object: string, stage: RecordStage) => object.slice(0, -stage.v1_object_ends_with.length);
/**
 * A character's `look` or a prop's `text` moved from entry.json into its description, in drama-cli's bytes for a new
 * asset (entries.prose); null when the entry has neither.
 */
function mergedDescription(type: string, description: string, entry: Readonly<Record<string, unknown>>): { readonly description: string; readonly entry: Record<string, unknown> } | null {
	const field = type === 'character' ? 'look' : type === 'prop' ? 'text' : null;
	if (!field || !(field in entry)) { return null; }
	const value = typeof entry[field] === 'string' ? (entry[field] as string).trim() : '';
	const { [field]: _moved, ...rest } = entry;
	const part = !value ? null : field === 'look' ? (description.includes(value) ? null : `Outfit: ${value}`)
		: description.includes(`"${value}"`) ? null : `It shows the words "${value}".`;
	const text = [description.trim(), part].filter(Boolean).join('\n\n');
	return { description: text ? `${text}\n` : '', entry: rest };
}

/** A dot path into a JSON value (receipt_when_owner_current_entry_metadata's keys). */
const at = (value: unknown, path: string) => path.split('.').reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);

/** Every folder under `root` whose name `names` holds, project-relative; nothing below one is looked into. */
function foldersNamed(root: string, names: ReadonlySet<string>, rel = ''): string[] {
	return readdirSync(join(root, rel), { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== '.git').flatMap(e => {
		const here = rel ? `${rel}/${e.name}` : e.name;
		return names.has(e.name) ? [here] : foldersNamed(root, names, here);
	});
}

/** The folder's own entries by name, for a commit that takes all of it: an explicit path is added even where a .gitignore of the folder's names it. */
const entriesOf = (root: string) => readdirSync(root).filter(name => name !== '.git');

/** The objects the person removed (choices.json `removed`), with every variant derived from them, down its chain, as major 1's reader removed them. */
function removedObjectsOf(choices: Choices | null, edges: readonly Edge[]): Set<string> {
	const removed = new Set(Object.entries(choices?.objects ?? {}).filter(([, c]) => c.removed).map(([id]) => id));
	for (let grew = true; grew;) {
		grew = false;
		for (const e of edges) {
			if (e.kind === 'variant_of' && removed.has(e.to) && !removed.has(e.from)) { removed.add(e.from); grew = true; }
		}
	}
	return removed;
}

/** Every major-1 version folder under `root` (the table's version_folders). */
function findMajor1Versions(root: string): Major1Version[] {
	const found: Major1Version[] = [];
	const walk = (rel: string) => {
		for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
			const here = rel ? `${rel}/${entry.name}` : entry.name;
			if (NAMES.some(n => n.test(entry.name)) && existsSync(join(root, here, RECORDS.version_record))) { found.push(readVersion(root, rel, entry.name)); } else { walk(here); }
		}
	};
	walk('');
	return found.filter(v => !TABLE.objects_dropped.includes(v.object) && !v.object.split('/').some(part => DROPPED_BY_NAME.has(part)));
}

function readVersion(root: string, object: string, id: string): Major1Version {
	const folder = join(root, object, id);
	const artifact = existsSync(join(folder, RECORDS.outputs_and_metadata)) ? json(join(folder, RECORDS.outputs_and_metadata)) : {};
	const { skip_folders_in_version: skipFolders, skip_files_in_version: skipFiles, also_copies: also } = TABLE.every_other_version;
	const listed = ((artifact.outputs ?? []) as { path: string }[]).map(o => o.path.slice(`${object}/${id}/`.length));
	const extra = Object.entries(also).filter(([pattern]) => segmentsMatch(pattern, object)).flatMap(([, files]) => files);
	// skip_outputs_by_object: its entries by object pattern; its `note` is prose.
	const skipped = Object.entries(TABLE.every_other_version.skip_outputs_by_object)
		.flatMap(([pattern, files]) => typeof files !== 'string' && segmentsMatch(pattern, object) ? files : []);
	return {
		object, id, record: versionRecordOf(json(join(folder, RECORDS.version_record))), metadata: artifact.metadata ?? {},
		outputs: [...listed, ...extra].filter(file => !skipFolders.includes(file.split('/')[0]) && !skipFiles.includes(file)
			&& !skipped.some(pattern => fileMatches(pattern, file)) && existsSync(join(folder, file))),
		job: existsSync(join(folder, RECORDS.paid_call)) ? json(join(folder, RECORDS.paid_call)) as Job : undefined,
	};
}

/** What a conversion made: the backup's path, and what major 1 left unsettled, whose results the conversion cannot keep. */
export interface Converted {
	readonly backup: string;
	/** Each 0.2.6 turn with no return (`turn <id>`), and each version whose paid call is not settled (`<object>/<version> (<state>)`). */
	readonly unsettled: readonly string[];
}

/**
 * Converts the window's major-1 project at `projectRoot` (doc/protocol.md, section 7), as one write in its queue. It
 * refuses only when the folder has no snapshot to give its objects. A turn with no return and a paid call not settled can
 * no longer settle once Pine runs the major-2 tools, so they are converted as found and named in the result. It backs
 * the folder up beside itself under the first free name, writes each object at its major-1 current version, removes the
 * major-1 folders, writes the project marker and records the result as one commit. Earlier versions are in the backup
 * only.
 */
export function convertMajor1ProjectToMajor2(projectRoot: string, globalStorage: string, today: string): Promise<Converted> {
	return runInProjectWriteQueue(projectRoot, async () => {
		if (readProjectMajor(projectRoot) !== 1) { throw new Error(`${projectRoot} is not a major-1 project; nothing was changed.`); }
		// A turn is unreturned when this profile sent it, dealt with no return of it, and the folder holds no turn of it.
		const turns = turnsOf(projectRoot);
		const returned = new Set(turns.map(t => t.task));
		const unreturned = dramaRecordsOf(globalStorage, projectRoot).flatMap(r => r.requests().map(t => t.request.turn).filter(turn => !r.handled(turn) && !returned.has(turn)));
		const versions = findMajor1Versions(projectRoot);
		const unsettled = [...unreturned.map(turn => `turn ${turn}`),
			...versions.filter(v => v.job && !SETTLED.states.includes(String(v.job[SETTLED.field]))).map(v => `${v.object}/${v.id} (${String(v.job![SETTLED.field])})`)];
		// The snapshots come from the folder's turns/, else from this Studio profile's own returns (the table's snapshots.read_from).
		const fromProfile = turns.length === 0;
		if (!scopedSnapshots(fromProfile ? dramaRecordsOf(globalStorage, projectRoot).flatMap(r => r.keptReturns()) : turns).length) {
			refuseWithUpgradeInstructions(`Nothing was changed. This project has no record of its turns: open it once in Pine Drama Studio ${LAST_MAJOR_1_STUDIO.version}, which writes them, then open it here again.`, LAST_MAJOR_1_STUDIO);
		}
		// The first free name beside the folder, `<name>.backup-<today>`, else `-2`, `-3`…; cp refuses a target made meanwhile (errorOnExist).
		const base = `${basename(projectRoot)}.backup-${today}`;
		const backup = join(dirname(projectRoot), unusedName(dirname(projectRoot), base, n => `${base}-${n}`));
		// A clone where the file system has them (APFS clonefile), a plain copy otherwise (Node fs.cp, mode COPYFILE_FICLONE).
		await cp(projectRoot, backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
		// Into turns/ as a Studio of major 1 writes them there itself on opening it, so the snapshots are read from one place.
		if (fromProfile) { await publishKeptTurns(globalStorage, projectRoot); }
		const removed = await (await Conversion.of(projectRoot, versions, await readChoices(projectRoot))).writeCurrent();
		const major1Folders = [...versions.map(v => `${v.object}/${v.id}`), ...new Set(versions.map(v => v.object).filter(o => stageOf(o))),
			...TABLE.objects_dropped, CONFIG.folder, ...TABLE.not_version_folders.dropped.filter(path => path !== CHOICES_FILE), ...foldersNamed(projectRoot, DROPPED_BY_NAME)];
		const gone = [...removed, ...major1Folders, CHOICES_FILE];
		// A variant is a folder below its asset's, so it goes with it (doc/protocol.md 2.2, "Removal").
		for (const path of gone.slice(0, -1)) { await rm(join(projectRoot, path), { recursive: true, force: true }); }
		// The marker before choices.json goes: the folder reads as major 1 until the marker is there (project.ts, readProjectMajor).
		await writeProjectMarker(projectRoot);
		await rm(join(projectRoot, CHOICES_FILE));
		// The folder's own entries by name, so that a .gitignore of the folder's keeps none of them out (an explicit path is
		// added with --force), and what was removed, which a repository the folder already was still holds.
		await commitPathsToHistory(projectRoot, AUTHOR, [...entriesOf(projectRoot), ...gone], 'Converted from major 1');
		return { backup, unsettled };
	});
}

/** What the conversion reads of the major-1 folder, and the major-2 files it writes from it. */
class Conversion {
	private readonly byObject = new Map<string, Major1Version[]>();
	private readonly everListed: ReadonlySet<string>;
	/** The objects an object.json describes so far: written with each current version's copy, then for the rest. */
	private readonly described = new Set<string>();

	private constructor(private readonly root: string, versions: readonly Major1Version[], private readonly choices: Choices | null,
		private readonly current: ReadonlyMap<string, Major1Version>, private readonly kept: ReturnType<typeof snapshotState>, snapshots: ReturnType<typeof scopedSnapshots>) {
		for (const v of versions) { this.byObject.set(v.object, [...this.byObject.get(v.object) ?? [], v]); }
		this.everListed = new Set(snapshots.flatMap(s => Object.keys(s.snapshot.objects)));
	}

	static async of(root: string, versions: readonly Major1Version[], choices: Choices | null): Promise<Conversion> {
		// Major 1's 3.2 current: the chosen version, else the newest not discarded, as major 1's own reader resolves it
		// (major1.ts, readVersions and currentVersion), reviews included.
		const current = new Map<string, Major1Version>();
		for (const object of new Set(versions.map(v => v.object))) {
			const id = currentVersion(await readVersions(root, object), choices, object);
			const version = versions.find(v => v.object === object && v.id === id);
			if (version) { current.set(object, version); }
		}
		// Kept as major 1's 5.3 reads them: an object is kept while the latest snapshot of its scope lists it.
		const snapshots = scopedSnapshots(turnsOf(root));
		return new Conversion(root, versions, choices, current, snapshotState(snapshots, tasksOf(root)), snapshots);
	}

	/** Writes an object's current version's files by the table. */
	private async apply(version: Major1Version): Promise<void> {
		const stage = stageOf(version.object);
		if (!stage) { return this.copyOutputs(version); }
		const owner = ownerOf(version.object, stage);
		const record = () => json(join(this.root, version.object, version.id, stage.reads!)) as Record<string, unknown>;
		const [written] = Object.keys(stage.writes).map(path => path.replace('{owner}', owner));
		if (stage.operation === 'split_entry_record_into_object_files') {
			const entry = record();
			const field = stage.description_field_by_owner_kind![this.descriptionKeyOf(owner)];
			const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== field && !stage.entry_json_drop_fields!.includes(key)));
			const [description, entryJson] = Object.keys(stage.writes).map(path => path.replace('{owner}', owner));
			await writeWhole(join(this.root, description), String(entry[field] ?? ''));
			return writeWhole(join(this.root, entryJson), `${JSON.stringify(rest, null, '\t')}\n`);
		}
		// write_receipt_only, for the call the owner's current entry version was written from.
		const metadata = this.current.get(`${owner}${ENTRY.v1_object_ends_with}`)?.metadata;
		const when = Object.entries(stage.receipt_when_owner_current_entry_metadata!)
			.every(([path, value]) => at(metadata, path) === value.replace('<this version>', `${version.object}/${version.id}`));
		if (version.job && when) { await this.writeReceipt(version, written.slice(0, -RECEIPT_SUFFIX.length)); }
	}

	private async copyOutputs(version: Major1Version): Promise<void> {
		for (const file of version.outputs) {
			const target = `${version.object}/${file}`;
			// An output in a subfolder of its version (a bible's input/brief.md) lands in a subfolder of the object.
			await mkdir(dirname(join(this.root, target)), { recursive: true });
			await copyWhole(join(this.root, version.object, version.id, file), join(this.root, target));
			if (version.job) { await this.writeReceipt(version, target); }
		}
		await this.writeObjectJson(version.object, version);
	}

	/** A version's shown file (version.json `file`) when its folder holds it, else null. */
	private shownFile(version: Major1Version | undefined): string | null {
		const file = version?.record.file;
		return file && version.outputs.includes(file) ? file : null;
	}

	/** The table's receipt_rule, beside `target`. An input whose version has no shown file is left out. */
	private async writeReceipt(version: Major1Version, target: string): Promise<void> {
		const job = version.job!;
		const inputs = [];
		for (const input of version.record.inputs) {
			const file = this.shownFile(this.byObject.get(input.object)?.find(v => v.id === input.version));
			if (file) { inputs.push({ path: `${input.object}/${file}`, sha256: (await sha256OfFile(join(this.root, input.object, input.version, file)))! }); }
		}
		const receipt = {
			schema: 2, paid_call_id: job.attempt_id, finished_at: version.record.made_at, inputs_sent_in_order: inputs, prompt_sent: version.record.prompt,
			cost: job.actual_usd === null ? null : { usd: job.actual_usd, reported_by: job.connection ? 'pine' : job.provider },
		};
		return writeWhole(join(this.root, `${target}${RECEIPT_SUFFIX}`), `${JSON.stringify(receipt, null, '\t')}\n`);
	}

	/** An entry owner's type by the table: type_when_owner_is_under for the folder it is under, else its kind folder's type. */
	private typeOf(owner: string): string {
		const under = Object.keys(ENTRY.type_when_owner_is_under!).find(folder => owner.split('/').includes(folder));
		return under ? ENTRY.type_when_owner_is_under![under] : ENTRY.kind_folder_to_type![owner.split('/')[1]];
	}

	/** The key description_field_by_owner_kind gives an owner: its kind folder, or its type when it is under one (a variant). */
	private descriptionKeyOf(owner: string): string {
		const type = this.typeOf(owner);
		return Object.values(ENTRY.type_when_owner_is_under!).includes(type) ? type : owner.split('/')[1];
	}

	/**
	 * The table's `current`: each object's files from its major-1 current version (record stages included), none for an
	 * object whose every version was discarded; every object.json; the person's pending text; the newest config at the
	 * root. Returns the objects to delete: those the person removed, and those a later snapshot of their scope stopped
	 * listing.
	 */
	async writeCurrent(): Promise<string[]> {
		for (const [object, list] of this.byObject) {
			// A receipt-only stage writes for the call its owner's current entry names, which need not be the stage's own current.
			const writing = stageOf(object)?.operation === 'write_receipt_only' ? list : [this.current.get(object)].filter(v => v !== undefined);
			for (const version of writing) { await this.apply(version); }
		}
		const removed = [...removedObjectsOf(this.choices, this.kept.edges), ...[...this.everListed].filter(id => !this.kept.listed.has(id))];
		const owners = [...this.byObject.keys()].filter(o => stageOf(o) === ENTRY).map(o => ownerOf(o, ENTRY));
		const pictures = [...this.byObject.keys()].filter(o => PICTURE_OBJECTS.some(p => segmentsMatch(p.pattern, o)));
		// The objects no version's copy described: planned ones, assets with only an entry, and those whose versions were all discarded.
		for (const object of new Set([...this.kept.listed.keys(), ...owners, ...pictures])) { if (!this.current.has(object)) { await this.writeObjectJson(object); } }
		// The person's pending text, for the objects major 2 has (written_for), none of them removed.
		for (const [object, choice] of Object.entries(this.choices?.objects ?? {}).filter(([id]) => this.described.has(id) && !removed.includes(id))) {
			if (choice.description !== undefined) { await writeWhole(join(this.root, object, DESCRIPTION_FILE), choice.description); }
		}
		// One editable text per card (doc/protocol.md 2.2): an outfit or printed words join the description, after the pending text.
		for (const owner of owners.filter(id => !removed.includes(id) && existsSync(join(this.root, id, ENTRY_FILE)))) {
			const description = join(this.root, owner, DESCRIPTION_FILE);
			const merged = mergedDescription(String(this.fieldsOf(owner)?.type), existsSync(description) ? await readFile(description, 'utf8') : '',
				JSON.parse(await readFile(join(this.root, owner, ENTRY_FILE), 'utf8')));
			if (merged) { await writeWhole(join(this.root, owner, ENTRY_FILE), `${JSON.stringify(merged.entry, null, '\t')}\n`); await writeWhole(description, merged.description); }
		}
		const configs = existsSync(join(this.root, CONFIG.folder)) ? readdirSync(join(this.root, CONFIG.folder))
			.filter(v => existsSync(join(this.root, CONFIG.folder, v, CONFIG.file))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
		if (configs.length) { await writeWhole(join(this.root, CONFIG.file), await readFile(join(this.root, CONFIG.folder, configs.at(-1)!, CONFIG.file))); }
		return removed;
	}

	/**
	 * object_json: from the current entry version when the object has an entry stage, else from the latest snapshot listing
	 * it; its shown file and what its draw sent are its current version's.
	 */
	private async writeObjectJson(object: string, version = this.current.get(object)): Promise<void> {
		const fields = this.fieldsOf(object);
		if (!fields) { return; }
		const snapshot = this.kept.listed.get(object)?.object;
		// The pictures the draw sent (as the receipt's inputs_sent_in_order), else a planned object's snapshot inputs.
		const sent = version ? version.record.inputs.filter(input => this.shownFile(this.byObject.get(input.object)?.find(v => v.id === input.version))).map(input => input.object)
			: snapshot?.inputs ?? [];
		const value = { schema: 2, ...fields, ...(snapshot?.segment ? { segment: snapshot.segment } : {}), shown_file: this.shownFile(version),
			...(sent.length ? { objects_sent_by_draw_request: sent } : {}) };
		await mkdir(join(this.root, object), { recursive: true });
		await writeWhole(join(this.root, object, OBJECT_FILE), `${JSON.stringify(value, null, '\t')}\n`);
		this.described.add(object);
	}

	/**
	 * object_json's one source per field, for the objects written_for names: the current entry version's, else the latest
	 * snapshot's that lists the object, else a picture that becomes an object (pictures_that_become_objects). Such a
	 * picture is named after its owner, the object the deepest `*` before its last segment stands in (a scene for its
	 * plan and its views, a variant for its views), and `<side>` is its last segment. Undefined for every other folder.
	 */
	private fieldsOf(object: string): Record<string, unknown> | undefined {
		const entry = this.current.get(`${object}${ENTRY.v1_object_ends_with}`);
		if (entry) { return this.entryFields(object, entry); }
		const snapshot = this.kept.listed.get(object)?.object;
		if (snapshot) {
			const edges = this.kept.edges.filter(e => e.from === object);
			return { type: snapshot.type, name: snapshot.name, variant_of: edges.find(e => e.kind === 'variant_of')?.to,
				relations: edges.filter(e => e.kind !== 'variant_of').map(e => ({ kind: e.kind, to: e.to })) };
		}
		const picture = PICTURE_OBJECTS.find(p => segmentsMatch(p.pattern, object));
		const segments = object.split('/');
		const owner = picture && this.fieldsOf(segments.slice(0, picture.pattern.split('/').slice(0, -1).lastIndexOf('*') + 1).join('/'));
		return owner && { type: picture.type, name: picture.name.replace(/<side>/g, () => segments.at(-1)!).replace(/<[^>]+>/g, () => String(owner.name)) };
	}

	private entryFields(owner: string, version: Major1Version): Record<string, unknown> {
		const entry = json(join(this.root, version.object, version.id, ENTRY.reads!)) as Record<string, unknown>;
		const [, kindFolder, id] = owner.split('/');
		const type = this.typeOf(owner);
		const fields: Record<string, unknown> = { type };
		for (const [to, from] of Object.entries(ENTRY.object_json_field_from_entry_field!)) { if (entry[from] !== undefined) { fields[to] = entry[from]; } }
		if (Object.values(ENTRY.type_when_owner_is_under!).includes(type)) {
			const rule = ENTRY.variant_of_rule!;
			const from = String(entry[rule.entry_field]);
			fields.variant_of = (from === rule.from_base_value ? rule.when_base : rule.otherwise).replace('<kind>', kindFolder).replace('<id>', id).replace('<from>', from);
		}
		fields.relations = Object.entries(ENTRY.relation_kind_from_entry_field!).flatMap(([kind, field]) => {
			const target = ENTRY.relation_target_from_entry_value![kind];
			if (entry[field] === undefined || (target.only_on && target.only_on !== kindFolder)) { return []; }
			return [entry[field]].flat().flatMap(value => {
				const to = target.first_existing_of ? target.first_existing_of.map(t => t.replace('<value>', String(value))).find(t => existsSync(join(this.root, t)))
					: target.target!.replace('<value>', String(value));
				return to ? [{ kind, to }] : [];
			});
		});
		return fields;
	}
}
