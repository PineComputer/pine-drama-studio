// The Pine Drama protocol, major version 2 (doc/protocol.md): its documents' types, and the public schema
// (protocol/v2/protocol.schema.json) with Ajv, a maintained JSON Schema validator, and ajv-formats for `date-time`. The
// Studio reads every document as it is (section 6.1); the schema checks only that a returned path is a path of the
// project. No vscode import.

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/** The one major this client speaks (doc/protocol.md, section 6.1). */
export const MAJOR = 2;

/** Where every Pine Drama Studio is downloaded: the product's pineReleasesUrl (upstream/product.package.json), which the extension cannot read. */
export const STUDIO_RELEASES_URL = 'https://github.com/PineComputer/pine-drama-studio/releases';

/**
 * A refusal of a project, a document or a Pine Computer of a major this Studio cannot work with (doc/protocol.md,
 * sections 7 and 8): what the person is told, and the Studio to use and where to get it when the refusal knows them.
 */
export class RefusedWithUpgradeInstructions extends Error {
	constructor(message: string, readonly studioVersion?: string, readonly downloadUrl?: string) { super(message); }

	/** The words of its download, wherever it is offered: a button, a link. Undefined without one. */
	get downloadLabel(): string | undefined {
		return this.downloadUrl && `Download Pine Drama Studio${this.studioVersion ? ` ${this.studioVersion}` : ''}`;
	}
}

/** The one refusal for every major mismatch: a newer project or document, an older Pine Computer, a major-1 project's conversion. */
export function refuseWithUpgradeInstructions(message: string, studio: { readonly version?: string; readonly downloadUrl?: string } = {}): never {
	throw new RefusedWithUpgradeInstructions(message, studio.version, studio.downloadUrl);
}

// The file names of protocol major 2, each spelled here only: every module that reads or writes one imports it.

/** The marker of a Pine Drama project of major 2, `{"schema": 2}` at its folder's root (doc/protocol.md 2.1, `$defs/projectMarker`). */
export const PROJECT_MARKER_FILE = 'pine-drama-project.json';

/** An object's own file, in its folder: a folder holding it is an object (doc/protocol.md 2.2, `$defs/object`). */
export const OBJECT_FILE = 'object.json';

/** The text the person and Pine Computer edit in an object's folder (doc/protocol.md 2.2). */
export const DESCRIPTION_FILE = 'description.md';
export const PROMPT_FILE = 'prompt.md';

/** The suffix of a paid output's receipt beside it, `<file>.receipt.json` (doc/protocol.md 2.3). */
export const RECEIPT_SUFFIX = '.receipt.json';

/** Pine Computer's records of the drama, ordinary files that travel both ways; a client may show them and decides nothing from them (doc/protocol.md 2.4). */
export const PINE_COMPUTER_RECORDS = 'pine-computer-records';

/**
 * A paid call's ledger among them, drama-cli's: its name, and the one an older drama's calls keep (short_drama
 * drama_cli/records.py LEDGER and NAMED_BEFORE, D334), in the call's attempt folder, named by when it was made
 * (records.py ATTEMPT_ID), under the object's path (drama_cli/project.py Object.work); and the states in which its
 * call is under way (records.py IN_FLIGHT).
 */
export const PAID_CALL_LEDGER = 'drama_cli_paid_call_ledger.json';
export const PAID_CALL_LEDGER_BEFORE = 'job.json';
export const PAID_CALL_ATTEMPT = /^\d{8}T\d{12}-[0-9a-f]{8}$/;
export const PAID_CALL_UNDER_WAY: ReadonlySet<string> = new Set(['submitting', 'submitted', 'queued', 'running', 'unknown', 'verifying']);

/** The drama's folder on Pine Computer, in the session's working directory (where Pine's exec starts). */
export const DRAMA_FOLDER = 'drama';

/** The folder of the files the person attaches to a note or a chat message, `<id>.<ext>` (doc/protocol.md section 3). */
export const PERSON_ATTACHMENTS_FOLDER = 'person-attachments';

export type ObjectType = 'episode' | 'screenplay' | 'bible' | 'character' | 'scene' | 'prop' | 'variant' | 'breakdown'
	| 'storyboard' | 'keyframe' | 'video_prompts' | 'take' | 'cut' | 'subtitles';

export interface Edge {
	readonly from: string;
	readonly to: string;
	readonly kind: 'variant_of' | 'inside_of' | 'appears_in';
}

/**
 * A document of protocol major 2 as it was read (`raw`, parsed JSON), named `name` for the person: one of another major
 * is refused whole, since a client applies nothing of a major it does not speak (doc/protocol.md section 7), by
 * `refuse` when its caller knows what the major means, and otherwise as a document this Studio does not read, a newer
 * one with the Studio's update.
 */
export function majorTwo(name: string, raw: unknown, refuse = (schema: unknown): never => {
	const unread = `${name} is a document of protocol major ${JSON.stringify(schema)}, which this Studio does not read`;
	return typeof schema === 'number' && schema > MAJOR
		? refuseWithUpgradeInstructions(`${unread}. Update Pine Drama Studio to its newest version.`, { downloadUrl: STUDIO_RELEASES_URL })
		: refuseWithUpgradeInstructions(unread);
}): Record<string, any> {
	const document = Object(raw);
	if (document.schema !== MAJOR) { refuse(document.schema); }
	return document;
}

/**
 * The schema, protocol/v2 at the extension's root, loaded by a static `require` of its JSON (Node: "require() can load
 * .json files"): compiled by tsc, out/core/protocol.js finds it two folders up; in a release, esbuild bundles it into the
 * one extension.js (its default json loader), so no path has to survive the bundling.
 */
// A require, not an import: tsc refuses to import a file outside rootDir (src/).
const SCHEMA = require('../../protocol/v2/protocol.schema.json') as { readonly $id: string };

let ajv: Ajv2020 | undefined;
let schemaId = '';

function validator(def: string) {
	if (!ajv) {
		ajv = new Ajv2020({ allErrors: true, strict: false });
		addFormats(ajv);
		ajv.addSchema(SCHEMA);
		schemaId = SCHEMA.$id;
	}
	const validate = ajv.getSchema(`${schemaId}#/$defs/${def}`);
	if (!validate) {
		throw new Error(`protocol schema has no $defs/${def} (${schemaId})`);
	}
	return validate;
}

/**
 * Whether `value` matches the part of the schema at `pointer` under its `$defs` (a JSON Pointer, RFC 6901, such as
 * `path`): how the install checks that a returned path is a path of the project (doc/protocol.md, section 1).
 */
export function matches(pointer: string, value: unknown): boolean {
	return validator(pointer)(value) as boolean;
}
