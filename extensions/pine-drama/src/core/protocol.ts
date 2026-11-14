// The Pine Drama protocol, major version 1 (doc/protocol.md): its documents' types, and the public schema
// (protocol/v1/protocol.schema.json) with Ajv, a maintained JSON Schema validator, and ajv-formats for `date-time`. The
// Studio reads every document as it is (section 6.1); the schema checks only that a returned path is a path of the
// project. No vscode import.

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/** The one major this client speaks (doc/protocol.md, section 6.1). */
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

export interface Add {
	readonly id: string;
	readonly type: 'character' | 'scene' | 'prop' | 'variant';
	readonly name: string;
	readonly description: string;
	readonly from?: string;
	readonly setting?: 'interior' | 'exterior';
}

export interface Import {
	readonly id: string;
	readonly object: string;
	readonly file: string;
}

export interface Choices {
	readonly schema: 1;
	readonly objects: Readonly<Record<string, ObjectChoice>>;
	readonly added: readonly Add[];
	readonly imports: readonly Import[];
}

export interface VersionRef {
	readonly object: string;
	readonly version: string;
}

/** A finished version a running task announces before its return; its archive is `versions/<hash>.tar`. */
export interface Progress {
	readonly schema: 1;
	readonly object: string;
	readonly version: string;
	readonly file: string;
}

export interface VersionRecord {
	readonly schema: 1;
	readonly made_at: string;
	readonly file: string | null;
	readonly inputs: readonly VersionRef[];
	readonly prompt: string | null;
	readonly from_import: string | null;
	/** The version of the same object this one goes on from (doc/protocol.md 2.1); absent when it redoes its object as a whole, and in older records. */
	readonly continues?: string;
}

export interface Review {
	readonly schema: 1;
	readonly accepted_at: string;
	readonly reason: string;
	readonly person?: string;
}

export interface Note {
	readonly object: string;
	readonly version?: string;
	readonly text: string;
	readonly file?: string;
	readonly at?: { readonly x: number; readonly y: number };
	readonly time?: number;
}

export interface Request {
	readonly schema: 1;
	readonly turn: string;
	readonly scope: 'project' | 'episodes';
	readonly choices: Choices | null;
	readonly versions: Folders;
	readonly reviews: Folders;
	readonly files: Folders;
	readonly private_state: Hash | null;
	readonly notes: readonly Note[];
}

export type ObjectType = 'episode' | 'screenplay' | 'bible' | 'character' | 'scene' | 'prop' | 'variant' | 'breakdown'
	| 'storyboard' | 'keyframe' | 'video_prompts' | 'take' | 'cut' | 'subtitles';

export interface SnapshotObject {
	readonly type: ObjectType;
	readonly name: string;
	readonly segment: string | null;
	readonly usable: boolean;
	readonly why?: string;
	readonly making?: boolean;
	readonly prompt?: string;
	readonly description?: string;
	readonly inputs?: readonly string[];
	readonly from_add: string | null;
	/** Made in an `episodes` turn: later `episodes` turns may add inside it (doc/protocol.md, section 1). */
	readonly episode_made?: true;
}

export interface Edge {
	readonly from: string;
	readonly to: string;
	readonly kind: 'variant_of' | 'inside_of' | 'appears_in' | 'needs';
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

export interface Return {
	readonly schema: 1;
	readonly turn: string;
	readonly state: 'stopped' | 'ended' | 'failed' | 'refused';
	readonly versions?: Folders;
	readonly reviews?: Folders;
	readonly private_state?: Hash;
	readonly snapshot?: Snapshot;
	readonly problems?: readonly { readonly ref: string; readonly error: ProtocolError }[];
	readonly question?: string;
	readonly review?: readonly (VersionRef & { readonly reason: string })[];
	readonly error?: ProtocolError;
}

/**
 * A list of a document read as one, whatever it was given as, and each member as an object: a reader then finds nothing in
 * what it does not know, rather than failing on it (section 6.1).
 */
export const listOf = <T>(value: unknown): T[] => Object.values(value ?? {}).map(Object) as T[];

/** A map of a document read as one, each member as an object (listOf). */
export const mapOf = <T>(value: unknown): Record<string, T> => Object.fromEntries(Object.entries(Object(value ?? {})).map(([key, member]) => [key, Object(member)]));

/** A document of a major this client does not speak: `unsupported_schema`; nothing of it is applied. */
export class UnsupportedMajor extends Error {
	constructor(readonly what: string, readonly major: unknown) {
		super(`${what} is protocol major ${String(major)}; this Studio speaks major ${MAJOR} only`);
		this.name = 'UnsupportedMajor';
	}
}

/**
 * The schema, protocol/v1 at the extension's root, loaded by a static `require` of its JSON (Node: "require() can load
 * .json files"): compiled by tsc, out/core/protocol.js finds it two folders up; in a release, esbuild bundles it into the
 * one extension.js (its default json loader), so no path has to survive the bundling.
 */
// A require, not an import: tsc refuses to import a file outside rootDir (src/).
const SCHEMA = require('../../protocol/v1/protocol.schema.json') as { readonly $id: string };

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
