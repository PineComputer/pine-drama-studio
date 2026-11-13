// What a task moves through the Computers' artifact stores (doc/protocol.md, 4.1), and the Studio's own copy of it. Every
// archive and file is named by the SHA-256 of its bytes and written once, in the store and here alike:
//
//   versions/<hash>.tar   one version folder without its reviews/, as the Computer side archived it
//   files/<hash>          one review file or one client file
//   state/<hash>.tar      one scope's private state
//   tasks/<id>/request.json, tasks/<id>/return.json
//
// The Studio keeps each archive it received byte for byte (`kept`), so it can put it on another Computer unchanged; which
// Computer is assumed to hold anything: each task lists its store, and copies or uploads what it lacks. No vscode import.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeWhole } from './choices';

/** A Computer's artifacts, as the SDK's `client.artifacts(computerId)` offers them. */
export interface ArtifactStore {
	/** Every file under `prefix`, with its size (SDK `ArtifactFile`; a listing gives no hash). */
	list(prefix: string): Promise<{ readonly path: string; readonly size: number }[]>;
	upload(path: string, bytes: Buffer): Promise<void>;
	/** The file's bytes, or undefined when there is none at `path`. */
	read(path: string): Promise<Buffer | undefined>;
	/** Pine's server-side copy of `path` from another Computer of the project to the same path here (SDK `artifacts.copy`). */
	copy(fromComputer: string, path: string): Promise<void>;
}

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export const versionKey = (hash: string): string => `versions/${hash}.tar`;
export const fileKey = (hash: string): string => `files/${hash}`;
export const stateKey = (hash: string): string => `state/${hash}.tar`;
export const requestKey = (task: string): string => `turns/${task}/request.json`;
export const returnKey = (task: string): string => `turns/${task}/return.json`;

/** The Studio's copy of an artifact key, under `kept` (the extension's storage), or undefined when it has none. */
export function keptBytes(kept: string, key: string): Buffer | undefined {
	return existsSync(join(kept, key)) ? readFileSync(join(kept, key)) : undefined;
}

/**
 * Reads an archive or file of `store` by its key, checks it against its hash (4.1: "A reader MUST check every archive and
 * file against its hash before it uses it"), and keeps it under `kept`. A key already kept is not read again.
 */
export async function fetchKept(store: ArtifactStore, kept: string, key: string, hash: string): Promise<Buffer> {
	const here = keptBytes(kept, key);
	if (here && sha256(here) === hash) { return here; }
	const bytes = await store.read(key);
	if (!bytes) { throw new MissingArtifact(key); }
	if (sha256(bytes) !== hash) { throw new Error(`${key} does not match its hash`); }
	await mkdir(dirname(join(kept, key)), { recursive: true });
	await writeWhole(join(kept, key), bytes);
	return bytes;
}

export class MissingArtifact extends Error {
	constructor(readonly key: string) { super(`${key} is not in the Computer's artifacts`); }
}

/** The content hash an artifact key names: `versions/<hash>.tar`, `files/<hash>`, `state/<hash>.tar`. */
export const hashOf = (key: string): string => key.split('/')[1].replace(/\.tar$/, '');

/**
 * One Computer remembered per hash (doc/protocol.md, 4.1): the last one seen holding it, after an upload, a return or a
 * listing. It only saves uploads: a copy from a Computer that no longer has the file falls back to the upload.
 */
export class Holders {
	constructor(private readonly dir: string) { }

	get(hash: string): string | undefined {
		return existsSync(join(this.dir, hash)) ? readFileSync(join(this.dir, hash), 'utf8') : undefined;
	}

	async set(hashes: Iterable<string>, computer: string): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		for (const hash of hashes) { if (this.get(hash) !== computer) { await writeWhole(join(this.dir, hash), computer); } }
	}
}

/**
 * Puts every key a request names into `computer`'s store before the task is sent (4.1, "Before a task"). One listing of
 * its store; each key it lacks, or holds cut short (`size`, the Studio's copy's size), is copied inside Pine's storage from the Computer remembered holding it, so a project's
 * video never passes through the person's connection, and uploaded from `bytes`, the Studio's copy, when none is
 * remembered or the copy fails. Returns how many were copied and uploaded.
 */
export async function putAll(store: ArtifactStore, computer: string, holders: Holders, keys: readonly string[], bytes: (key: string) => Buffer, size: (key: string) => number): Promise<{ copied: number; uploaded: number }> {
	const listed = new Map((await Promise.all(['versions/', 'files/', 'state/'].map(prefix => store.list(prefix)))).flat().map(f => [f.path, f.size]));
	// A file whose size is not its bytes' is an upload cut off part way: it is put again. A listing gives sizes, not
	// hashes, and a whole file of other bytes cannot sit under its own hash's name.
	const whole = (key: string) => listed.has(key) && listed.get(key) === size(key);
	await holders.set([...new Set(keys)].filter(whole).map(hashOf), computer);
	let copied = 0;
	let uploaded = 0;
	for (const key of [...new Set(keys)].filter(key => !whole(key))) {
		const from = holders.get(hashOf(key));
		if (from && from !== computer && await store.copy(from, key).then(() => true, () => false)) {
			copied++;
		} else {
			await store.upload(key, bytes(key));
			uploaded++;
		}
		await holders.set([hashOf(key)], computer);
	}
	return { copied, uploaded };
}
