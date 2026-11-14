// Converting a major-1 project to major 2 (doc/protocol.md, section 8). Every major-1 record format the Studio knows is
// in protocol/v2/major1-to-major2-conversion.json: this module applies that table's operations as written and knows no
// record format of its own. The conversion is one write in the project's write queue, so no other write comes between
// its commits, and every commit goes through projectHistory. No vscode import.

import { constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CHOICES_FILE, copyWhole, readChoices, readVersions, resolve, versionRecordOf, writeWhole } from './choices';
import { readProjectMajor, snapshotState, writeProjectMarker } from './project';
import { commitPathsToHistory, listHistoryOfFile, runInProjectWriteQueue } from './projectHistory';
import { sha256OfFileOnDisk } from './sha256';
import { DESCRIPTION_FILE, OBJECT_FILE, PROJECT_MARKER_FILE, PROMPT_FILE, RECEIPT_SUFFIX, type Choices, type Edge, type VersionRecord } from './protocol';
import { dramaRecordOf, dramaRecordsOf, publishKeptTurns, scopedSnapshots, tasksOf, turnsOf } from './taskRun';

const TABLE = require('../../protocol/v2/major1-to-major2-conversion.json') as ConversionTable;

interface RelationTarget { readonly only_on?: string; readonly first_existing_of?: readonly string[]; readonly target?: string }
interface RecordStage {
	readonly v1_object_ends_with: string;
	readonly operation: 'split_entry_record_into_object_files' | 'extract_json_field_to_markdown' | 'write_receipt_only';
	readonly reads?: string;
	readonly field?: string;
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
	};
	readonly record_stages: readonly RecordStage[];
	readonly objects_dropped: readonly string[];
	readonly every_other_version: {
		readonly skip_folders_in_version: readonly string[];
		readonly skip_files_in_version: readonly string[];
		readonly also_copies: Readonly<Record<string, readonly string[]>>;
	};
	readonly not_version_folders: {
		readonly newest_version_to_root: { readonly folder: string; readonly file: string };
		readonly dropped: readonly string[];
	};
}

/** The last Studio that reads major 1: where a person goes back to for what this one cannot do with a major-1 project. */
export const LAST_MAJOR_1_STUDIO = { version: '0.2.6', downloadUrl: 'https://github.com/PineComputer/pine-drama-studio/releases/tag/v0.2.6' } as const;

/** A refusal that names the Studio version to use and where to download it (doc/protocol.md, section 7). */
export class RefusedWithUpgradeInstructions extends Error {
	constructor(message: string, readonly studioVersion: string, readonly downloadUrl: string) { super(message); }
}

/** The one refusal for a project or Computer of a major this Studio cannot work with (doc/protocol.md, sections 7 and 8). */
export function refuseWithUpgradeInstructions(message: string, studio: { readonly version: string; readonly downloadUrl: string }): never {
	throw new RefusedWithUpgradeInstructions(message, studio.version, studio.downloadUrl);
}

const AUTHOR = 'client-found-changes-on-disk';
const NAMES = TABLE.version_folders.version_folder_name_patterns.map(p => new RegExp(p));
const RECORDS = TABLE.version_folders.records_in_a_version_folder;
const ENTRY = TABLE.record_stages.find(s => s.operation === 'split_entry_record_into_object_files')!;
const CONFIG = TABLE.not_version_folders.newest_version_to_root;

interface Job { readonly attempt_id: string; readonly actual_usd: number | null; readonly connection?: unknown; readonly provider: string }
interface Major1Version {
	readonly object: string;
	readonly id: string;
	readonly record: VersionRecord;
	/**
	 * Files of the version folder to copy into its object's folder, as the folder holds them (doc/protocol.md 2.1, what is on
	 * disk is the truth): a file the person edited by hand is copied as they left it, and one they deleted or renamed is
	 * not there to copy. Both stay in history, in the commit of the folder as found.
	 */
	readonly outputs: readonly string[];
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly job: Job | undefined;
}

/**
 * The conversion's own working record (doc/protocol.md 8: "Its working records are its own"), in this Studio's storage
 * beside its other records of the drama, never in the project's folder: which step it is at, so a run cut off goes on.
 */
interface Journal {
	readonly step: 'writing turns' | 'backing up' | 'converting versions' | 'removing major-1 folders';
	readonly backup: string;
	/** The SHA-256 of every file the conversion reads, by project-relative path: on resume, a changed source refuses it. */
	readonly inventory: Readonly<Record<string, string>>;
	readonly done: number;
	readonly removed: readonly string[];
}
const journalOf = (globalStorage: string, root: string) => join(dramaRecordOf(globalStorage, root).dir, 'major1-conversion.json');

/**
 * Whether a conversion of the folder was started and not finished: the window offers to go on with it. Once the marker is
 * written the project is of major 2, whatever the journal says: only the marker's own commit was left, which the next
 * opening commits as found on disk.
 */
export function major1ConversionPending(globalStorage: string, root: string): boolean {
	return existsSync(journalOf(globalStorage, root)) && readProjectMajor(root) !== 2;
}

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const segmentsMatch = (pattern: string, id: string) => {
	const [p, s] = [pattern.split('/'), id.split('/')];
	return p.length === s.length && p.every((part, i) => part === '*' || part === s[i]);
};
const stageOf = (object: string) => TABLE.record_stages.find(s => object.endsWith(s.v1_object_ends_with));
const ownerOf = (object: string, stage: RecordStage) => object.slice(0, -stage.v1_object_ends_with.length);
const byOrder = (a: Major1Version, b: Major1Version) => a.record.made_at.localeCompare(b.record.made_at)
	|| a.object.localeCompare(b.object) || a.id.localeCompare(b.id, 'en', { numeric: true });
/** A dot path into a JSON value (receipt_when_owner_current_entry_metadata's keys). */
const at = (value: unknown, path: string) => path.split('.').reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);
const filesUnder = (root: string, rel: string): string[] => readdirSync(join(root, rel), { withFileTypes: true })
	.flatMap(e => e.isDirectory() ? filesUnder(root, `${rel}/${e.name}`) : [`${rel}/${e.name}`]);

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

/** Every major-1 version folder under `root` (the table's version_folders), in the table's one global order. */
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
	return found.filter(v => !TABLE.objects_dropped.includes(v.object)).sort(byOrder);
}

function readVersion(root: string, object: string, id: string): Major1Version {
	const folder = join(root, object, id);
	const artifact = existsSync(join(folder, RECORDS.outputs_and_metadata)) ? json(join(folder, RECORDS.outputs_and_metadata)) : {};
	const { skip_folders_in_version: skipFolders, skip_files_in_version: skipFiles, also_copies: also } = TABLE.every_other_version;
	const listed = ((artifact.outputs ?? []) as { path: string }[]).map(o => o.path.slice(`${object}/${id}/`.length));
	const extra = Object.entries(also).filter(([pattern]) => segmentsMatch(pattern, object)).flatMap(([, files]) => files);
	return {
		object, id, record: versionRecordOf(json(join(folder, RECORDS.version_record))), metadata: artifact.metadata ?? {},
		outputs: [...listed, ...extra].filter(file => !skipFolders.includes(file.split('/')[0]) && !skipFiles.includes(file) && existsSync(join(folder, file))),
		job: existsSync(join(folder, RECORDS.paid_call)) ? json(join(folder, RECORDS.paid_call)) as Job : undefined,
	};
}

/**
 * Everything the conversion reads, by content: every file of every version folder, the configs (a project drama-cli never
 * set up has none), choices.json, which makes the folder major 1, and the turns, which the snapshot refusal ensures.
 */
function inventoryOf(root: string, versions: readonly Major1Version[]): Record<string, string> {
	const sources = [...versions.flatMap(v => filesUnder(root, `${v.object}/${v.id}`)), ...existsSync(join(root, CONFIG.folder)) ? filesUnder(root, CONFIG.folder) : [],
		CHOICES_FILE, ...filesUnder(root, 'turns')];
	return Object.fromEntries(sources.map(path => [path, sha256OfFileOnDisk(join(root, path))!]));
}
const sameInventory = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
	JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Converts the window's major-1 project at `projectRoot` (doc/protocol.md, section 8), as one write in its queue. It
 * refuses while a major-1 turn is owed a return, or when the folder has no snapshot to give its objects. It backs the
 * folder up beside itself, commits it as found, makes one commit per major-1 version in the table's order, sets each object
 * to its major-1 current and checks it, removes the major-1 folders, and writes the project marker in a commit of its own.
 * A run cut off goes on from its journal. Returns the backup's path.
 */
export function convertMajor1ProjectToMajor2(projectRoot: string, globalStorage: string, today: string): Promise<string> {
	return runInProjectWriteQueue(projectRoot, async () => {
		const journalPath = journalOf(globalStorage, projectRoot);
		let journal = existsSync(journalPath) ? json(journalPath) as Journal : undefined;
		const step = async (next: Journal) => { await mkdir(dirname(journalPath), { recursive: true }); await writeWhole(journalPath, JSON.stringify(next)); journal = next; };
		// The versions and their inventory, read once: when this run reads them first, there is nothing to compare them with.
		let versions: Major1Version[] | undefined;
		const inventoried = async (from: Journal) => { versions = findMajor1Versions(projectRoot); await step({ ...from, step: 'backing up', inventory: inventoryOf(projectRoot, versions) }); };
		if (!journal) {
			if (readProjectMajor(projectRoot) !== 1) { throw new Error(`${projectRoot} is not a major-1 project; nothing was changed.`); }
			if (dramaRecordsOf(globalStorage, projectRoot).some(r => r.requests().some(t => !r.handled(t.request.turn)))) {
				refuseWithUpgradeInstructions(`Nothing was changed. A turn sent from Pine Drama Studio ${LAST_MAJOR_1_STUDIO.version} has not returned yet: finish or stop it there, then open this project here again.`, LAST_MAJOR_1_STUDIO);
			}
			const backup = join(dirname(projectRoot), `${basename(projectRoot)}.backup-${today}`);
			if (existsSync(backup)) { throw new Error(`${backup} already exists beside the project, so it cannot be its backup; nothing was changed. Rename or move it, then convert again.`); }
			// The snapshots come from the folder's turns/, else from this Studio profile's own returns (the table's snapshots.read_from).
			const fromProfile = turnsOf(projectRoot).length === 0;
			if (!scopedSnapshots(fromProfile ? dramaRecordsOf(globalStorage, projectRoot).flatMap(r => r.keptReturns()) : turnsOf(projectRoot)).length) {
				refuseWithUpgradeInstructions(`Nothing was changed. This project has no record of its turns: open it once in Pine Drama Studio ${LAST_MAJOR_1_STUDIO.version}, which writes them, then open it here again.`, LAST_MAJOR_1_STUDIO);
			}
			const started: Journal = { step: 'writing turns', backup, inventory: {}, done: 0, removed: [] };
			if (fromProfile) { await step(started); } else { await inventoried(started); }
		}
		if (journal!.step === 'writing turns') {
			// Into turns/ as a Studio of major 1 writes them there itself on opening it; after a cut-off, the ones not written yet.
			await publishKeptTurns(globalStorage, projectRoot);
			await inventoried(journal!);
		}
		if (!versions && journal!.step !== 'removing major-1 folders') {
			versions = findMajor1Versions(projectRoot);
			if (!sameInventory(inventoryOf(projectRoot, versions), journal!.inventory)) {
				throw new Error(`${projectRoot} changed while its conversion was cut off; nothing more was changed. Its backup is ${journal!.backup}.`);
			}
		}
		if (journal!.step === 'backing up') {
			// The backup's path did not exist when the conversion started, so whatever is there now is this conversion's own.
			await rm(journal!.backup, { recursive: true, force: true });
			// A clone where the file system has them (APFS clonefile), a plain copy otherwise (Node fs.cp, mode COPYFILE_FICLONE).
			await cp(projectRoot, journal!.backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
			await step({ ...journal!, step: 'converting versions' });
		}
		if (journal!.step === 'converting versions') {
			// The folder as found, its first commit: committing it again after a cut-off finds nothing new to commit. Its own
			// entries by name, so that a .gitignore of the folder's keeps none of them out (an explicit path is added with
			// --force): the major-1 originals are deleted once converted, and this commit is where history keeps them.
			if (journal!.done === 0) { await commitPathsToHistory(projectRoot, AUTHOR, entriesOf(projectRoot), 'The major-1 project as found, before its conversion to major 2'); }
			const conversion = await Conversion.of(projectRoot, versions!, await readChoices(projectRoot), journal!.inventory);
			for (const [i, version] of versions!.entries()) {
				if (i < journal!.done) { conversion.replay(version); continue; }
				await commitPathsToHistory(projectRoot, AUTHOR, await conversion.apply(version), `Major-1 ${version.object}/${version.id}, converted`);
				await step({ ...journal!, done: i + 1 });
			}
			const removed = await conversion.setCurrent();
			await conversion.verify();
			const major1Folders = [...versions!.map(v => `${v.object}/${v.id}`), ...new Set(versions!.map(v => v.object).filter(o => stageOf(o))),
				...TABLE.objects_dropped, CONFIG.folder, ...TABLE.not_version_folders.dropped.filter(path => path !== CHOICES_FILE)];
			await step({ ...journal!, step: 'removing major-1 folders', removed: [...removed, ...major1Folders] });
		}
		// A variant is a folder below its asset's, so it goes with it (doc/protocol.md 2.2, "Removal").
		for (const path of journal!.removed) { await rm(join(projectRoot, path), { recursive: true, force: true }); }
		await commitPathsToHistory(projectRoot, AUTHOR, [...entriesOf(projectRoot), ...journal!.removed], 'Each object set to its major-1 current; the major-1 folders removed');
		// The marker last, and choices.json right after it: the folder is always of one major, 1 until the marker is written
		// (the window then offers to go on, from the journal) and 2 from then on (project.ts, readProjectMajor).
		await writeProjectMarker(projectRoot);
		await rm(join(projectRoot, CHOICES_FILE));
		await commitPathsToHistory(projectRoot, AUTHOR, [PROJECT_MARKER_FILE, CHOICES_FILE], 'A Pine Drama project of major 2');
		await rm(journalPath);
		return journal!.backup;
	});
}

/** The conversion's state between its commits. */
class Conversion {
	private readonly byObject = new Map<string, Major1Version[]>();
	/** The files each object's folder holds from its versions, project-relative, as the last applied version left them. */
	private readonly holds = new Map<string, Set<string>>();
	private readonly everListed: ReadonlySet<string>;
	/** The objects an object.json describes so far: written by each version's copy, and in setCurrent for the rest. */
	private readonly described = new Set<string>();

	private constructor(private readonly root: string, versions: readonly Major1Version[], private readonly choices: Choices | null,
		private readonly current: ReadonlyMap<string, Major1Version>, private readonly kept: ReturnType<typeof snapshotState>, snapshots: ReturnType<typeof scopedSnapshots>,
		private readonly inventory: Readonly<Record<string, string>>) {
		for (const v of versions) { this.byObject.set(v.object, [...this.byObject.get(v.object) ?? [], v]); }
		this.everListed = new Set(snapshots.flatMap(s => Object.keys(s.snapshot.objects)));
	}

	static async of(root: string, versions: readonly Major1Version[], choices: Choices | null, inventory: Readonly<Record<string, string>>): Promise<Conversion> {
		// Major 1's 3.2 current: the chosen version, else the newest not discarded, as major 1's own reader resolves it
		// (choices.ts, readVersions and resolve), reviews included.
		const current = new Map<string, Major1Version>();
		for (const object of new Set(versions.map(v => v.object))) {
			const id = resolve(await readVersions(root, object), choices, object).current;
			const version = versions.find(v => v.object === object && v.id === id);
			if (version) { current.set(object, version); }
		}
		// Kept as major 1's 5.3 reads them: an object is kept while the latest snapshot of its scope lists it.
		const snapshots = scopedSnapshots(turnsOf(root));
		return new Conversion(root, versions, choices, current, snapshotState(snapshots, tasksOf(undefined, root)), snapshots, inventory);
	}

	/** Records what an already committed version left in its object's folder, for a resumed run. */
	replay(version: Major1Version): void {
		if (!stageOf(version.object)) { this.holds.set(version.object, new Set(version.outputs.map(file => `${version.object}/${file}`))); }
	}

	/** Writes one version's files by the table and returns the paths it wrote or deleted, for its commit. */
	async apply(version: Major1Version): Promise<string[]> {
		const stage = stageOf(version.object);
		if (!stage) { return this.copyOutputs(version); }
		const owner = ownerOf(version.object, stage);
		const record = () => json(join(this.root, version.object, version.id, stage.reads!)) as Record<string, unknown>;
		const [written] = Object.keys(stage.writes).map(path => path.replace('{owner}', owner));
		if (stage.operation === 'extract_json_field_to_markdown') {
			await writeWhole(join(this.root, written), String(record()[stage.field!] ?? ''));
			return [written];
		}
		if (stage.operation === 'split_entry_record_into_object_files') {
			const entry = record();
			const field = stage.description_field_by_owner_kind![this.descriptionKeyOf(owner)];
			const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== field && !stage.entry_json_drop_fields!.includes(key)));
			const [description, entryJson] = Object.keys(stage.writes).map(path => path.replace('{owner}', owner));
			await writeWhole(join(this.root, description), String(entry[field] ?? ''));
			await writeWhole(join(this.root, entryJson), `${JSON.stringify(rest, null, '\t')}\n`);
			return [description, entryJson];
		}
		// write_receipt_only, for the call the owner's current entry version was written from.
		const metadata = this.current.get(`${owner}${ENTRY.v1_object_ends_with}`)?.metadata;
		const when = Object.entries(stage.receipt_when_owner_current_entry_metadata!)
			.every(([path, value]) => at(metadata, path) === value.replace('<this version>', `${version.object}/${version.id}`));
		if (!version.job || !when) { return []; }
		await this.writeReceipt(version, written.slice(0, -RECEIPT_SUFFIX.length));
		return [written];
	}

	private async copyOutputs(version: Major1Version): Promise<string[]> {
		const now = new Set<string>();
		for (const file of version.outputs) {
			const target = `${version.object}/${file}`;
			// An output in a subfolder of its version (a bible's input/brief.md) lands in a subfolder of the object.
			await mkdir(dirname(join(this.root, target)), { recursive: true });
			await copyWhole(join(this.root, version.object, version.id, file), join(this.root, target));
			// A file an earlier version made by a paid call and this one made locally keeps no receipt of that call.
			if (version.job) { await this.writeReceipt(version, target); } else { await rm(join(this.root, `${target}${RECEIPT_SUFFIX}`), { force: true }); }
			now.add(target);
		}
		const described = await this.writeObjectJson(version.object, version) ? [`${version.object}/${OBJECT_FILE}`] : [];
		return [...[...now, ...await this.clear(version.object, now)].flatMap(p => [p, `${p}${RECEIPT_SUFFIX}`]), ...described];
	}

	/** Deletes the files, with their receipts, that the object's folder holds from its versions and `keep` does not name. */
	private async clear(object: string, keep: ReadonlySet<string> = new Set()): Promise<string[]> {
		const dropped = [...this.holds.get(object) ?? []].filter(p => !keep.has(p));
		for (const path of dropped) { await rm(join(this.root, path), { force: true }); await rm(join(this.root, `${path}${RECEIPT_SUFFIX}`), { force: true }); }
		this.holds.set(object, new Set(keep));
		return dropped;
	}

	/** A version's shown file (version.json `file`) when its folder holds it, else null. */
	private shownFile(version: Major1Version | undefined): string | null {
		const file = version?.record.file;
		return file && version.outputs.includes(file) ? file : null;
	}

	/** The table's receipt_rule, beside `target`. An input whose version has no shown file is left out. */
	private writeReceipt(version: Major1Version, target: string): Promise<void> {
		const job = version.job!;
		const inputs = version.record.inputs.flatMap(input => {
			const file = this.shownFile(this.byObject.get(input.object)?.find(v => v.id === input.version));
			return file ? [{ path: `${input.object}/${file}`, sha256: this.inventory[`${input.object}/${input.version}/${file}`] }] : [];
		});
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
	 * The table's `current`: each object's files set to its major-1 current version's (record stages included), and an
	 * object with none, every version discarded, cleared; every object.json written for its current version; the person's pending text; the
	 * newest config at the root. Returns the objects to delete: those the person removed, and those a later snapshot of
	 * their scope stopped listing.
	 */
	async setCurrent(): Promise<string[]> {
		for (const object of this.byObject.keys()) {
			const version = this.current.get(object);
			const stage = stageOf(object);
			if (version) { await this.apply(version); } else if (!stage) { await this.clear(object); } else {
				for (const path of Object.keys(stage.writes)) { await rm(join(this.root, path.replace('{owner}', ownerOf(object, stage))), { force: true }); }
			}
		}
		const removed = [...removedObjectsOf(this.choices, this.kept.edges), ...[...this.everListed].filter(id => !this.kept.listed.has(id))];
		const owners = [...this.byObject.keys()].filter(o => stageOf(o) === ENTRY).map(o => ownerOf(o, ENTRY));
		// The objects no version's copy described: planned ones, assets with only an entry, and those whose versions were all discarded.
		for (const object of new Set([...this.kept.listed.keys(), ...owners])) { if (!this.current.has(object)) { await this.writeObjectJson(object); } }
		// The person's pending text, for the objects major 2 has (written_for), none of them removed.
		for (const [object, choice] of Object.entries(this.choices?.objects ?? {}).filter(([id]) => this.described.has(id) && !removed.includes(id))) {
			if (choice.prompt !== undefined) { await writeWhole(join(this.root, object, PROMPT_FILE), choice.prompt); }
			if (choice.description !== undefined) { await writeWhole(join(this.root, object, DESCRIPTION_FILE), choice.description); }
		}
		const configs = existsSync(join(this.root, CONFIG.folder)) ? readdirSync(join(this.root, CONFIG.folder))
			.filter(v => existsSync(join(this.root, CONFIG.folder, v, CONFIG.file))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
		if (configs.length) { await writeWhole(join(this.root, CONFIG.file), await readFile(join(this.root, CONFIG.folder, configs.at(-1)!, CONFIG.file))); }
		return removed;
	}

	/**
	 * object_json: from the current entry version when the object has an entry stage, else from the latest snapshot listing
	 * it; its shown file and what its draw sent are `version`'s. Each version's commit writes it for that version, so
	 * history says which file each past result showed, and the last commit writes it for the current one. Returns whether
	 * the object has one.
	 */
	private async writeObjectJson(object: string, version = this.current.get(object)): Promise<boolean> {
		const snapshot = this.kept.listed.get(object)?.object;
		const entry = this.current.get(`${object}${ENTRY.v1_object_ends_with}`);
		// written_for: an object the kept snapshots list, or an asset with a current entry version; no other folder gets one.
		if (!entry && !snapshot) { return false; }
		const edges = this.kept.edges.filter(e => e.from === object);
		const fields = entry ? this.entryFields(object, entry) : {
			type: snapshot!.type, name: snapshot!.name, variant_of: edges.find(e => e.kind === 'variant_of')?.to,
			relations: edges.filter(e => e.kind !== 'variant_of').map(e => ({ kind: e.kind, to: e.to })),
		};
		// The pictures the draw sent (as the receipt's inputs_sent_in_order), else a planned object's snapshot inputs.
		const sent = version ? version.record.inputs.filter(input => this.shownFile(this.byObject.get(input.object)?.find(v => v.id === input.version))).map(input => input.object)
			: snapshot?.inputs ?? [];
		const value = { schema: 2, ...fields, ...(snapshot?.segment ? { segment: snapshot.segment } : {}), shown_file: this.shownFile(version),
			...(sent.length ? { objects_sent_by_draw_request: sent } : {}) };
		await mkdir(join(this.root, object), { recursive: true });
		await writeWhole(join(this.root, object, OBJECT_FILE), `${JSON.stringify(value, null, '\t')}\n`);
		this.described.add(object);
		return true;
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

	/**
	 * §8 step 6: every object's files are the bytes of its current version, as the inventory read them, and every converted
	 * version's bytes are in its major-2 path's history: the commit of the folder as found holds them at their major-1 path,
	 * and its blob there is one the major-2 path's history names (projectHistory.listHistoryOfFile).
	 */
	async verify(): Promise<void> {
		const kept = `the major-1 folders were kept, and the backup is beside the project`;
		for (const [object, version] of this.current) {
			for (const file of stageOf(object) ? [] : version.outputs) {
				if (sha256OfFileOnDisk(join(this.root, object, file)) !== this.inventory[`${object}/${version.id}/${file}`]) {
					throw new Error(`${object}/${file} is not its current version's file after conversion; ${kept}.`);
				}
			}
		}
		const blobsOf = async (path: string) => new Set((await listHistoryOfFile(this.root, path)).map(e => e.blob));
		const history = new Map<string, Set<string | null>>();
		for (const [object, list] of this.byObject) {
			for (const version of stageOf(object) ? [] : list) {
				for (const file of version.outputs) {
					const [found] = await blobsOf(`${object}/${version.id}/${file}`);
					const path = `${object}/${file}`;
					if (!history.has(path)) { history.set(path, await blobsOf(path)); }
					if (!history.get(path)!.has(found)) { throw new Error(`${object}/${version.id}/${file} is not in ${path}'s history after conversion; ${kept}.`); }
				}
			}
		}
	}
}
