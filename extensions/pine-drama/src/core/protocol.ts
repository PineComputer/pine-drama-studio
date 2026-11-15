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

/** The folder of the files the person attaches to a note or a chat message, `<id>.<ext>` (doc/protocol.md section 3). */
export const PERSON_ATTACHMENTS_FOLDER = 'person-attachments';

export type Hash = string;

export type ObjectType = 'episode' | 'screenplay' | 'bible' | 'character' | 'scene' | 'prop' | 'variant' | 'breakdown'
	| 'storyboard' | 'keyframe' | 'video_prompts' | 'take' | 'cut' | 'subtitles';

export interface Edge {
	readonly from: string;
	readonly to: string;
	readonly kind: 'variant_of' | 'inside_of' | 'appears_in' | 'needs';
}

/** The person's feedback for Pine Computer (doc/protocol.md 4.2, `$defs/note`). */
export interface Note {
	readonly object_id: string;
	readonly text: string;
	readonly attached_file?: string;
	readonly position_in_shown_file?: { readonly x: number; readonly y: number };
	readonly seconds_into_video?: number;
}

/** `turns/<turn id>/request.json` (doc/protocol.md 4.2, `$defs/request`). */
export interface Request {
	readonly schema: 2;
	readonly turn_id: string;
	readonly seed_files: Readonly<Record<string, Hash>>;
	readonly session_private_state: Hash | null;
	readonly notes_for_pine_computer: readonly Note[];
}

/** `turns/<turn id>/changes/<change number>.json` (doc/protocol.md 4.3, `$defs/change`): one finished result. */
export interface Change {
	readonly schema: 2;
	readonly turn_id: string;
	readonly change_number: number;
	readonly previous_change_sha256: Hash | null;
	readonly files_after_change: Readonly<Record<string, Hash | null>>;
}

/** An error a document names (doc/protocol.md section 6, `$defs/error`). */
export interface ProtocolError {
	readonly code: string;
	readonly message: string;
	readonly action?: string;
	/** On a refusal of another major: the lowest client version that reads it, and where to download it (section 7). */
}

/** `turns/<turn id>/return.json` (doc/protocol.md 4.6, `$defs/return`), written last. */
export interface Return {
	readonly schema: 2;
	readonly turn_id: string;
	readonly state: 'pine_computer_is_waiting_for_person_answer' | 'pine_computer_finished_the_work' | 'pine_computer_broke_off_the_turn_partway'
		| 'pine_computer_refused_the_turn_before_running';
	readonly last_change?: { readonly change_number: number; readonly sha256: Hash } | null;
	readonly session_private_state?: Hash | null;
	readonly pine_computer_could_not_do?: readonly { readonly object_or_file: string; readonly error: ProtocolError }[];
	readonly question_for_person?: string;
	readonly error?: ProtocolError;
}

/** `turns/<turn id>/paid-calls/<paid call id>/<state>.json` (doc/protocol.md 4.5, `$defs/paidCallState`). */
export interface PaidCallState {
	readonly schema: 2;
	readonly paid_call_id: string;
	readonly object_id: string;
	readonly state: 'pine_computer_sent_request_to_provider' | 'provider_returned_output_to_pine_computer' | 'provider_reported_failure_to_pine_computer'
		| 'pine_computer_cancelled_call_after_person_pressed_stop' | 'pine_computer_cannot_learn_call_outcome';
	readonly state_written_at: string;
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
