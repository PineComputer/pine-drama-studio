// What a turn moves through the Computers' artifact stores (doc/protocol.md 4.1). Every file is named by the SHA-256 of
// its bytes and written once:
//
//   files/<hash>                       one file of the drama
//   turns/<turn id>/changes/<n>.json   one change of a turn
//
// No Computer is assumed to hold anything: each turn lists its store, and copies or uploads what it lacks. No vscode
// import.

import { writeWhole } from './placement';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** A Computer's artifacts, as the SDK's `client.artifacts(computerId)` offers them. */
export interface ArtifactStore {
	/** Every file under `prefix`, with its size (SDK `ArtifactFile`; a listing gives no hash). */
	list(prefix: string): Promise<{ readonly path: string; readonly size: number }[]>;
	/** `signal`: the person's Stop of the send it belongs to (SDK CallOptions). */
	upload(path: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
	/** The file's bytes, or undefined when there is none at `path`. */
	read(path: string): Promise<Buffer | undefined>;
	/** Pine's server-side copy of `path` from another Computer of the project to the same path here (SDK `artifacts.copy`). */
	copy(fromComputer: string, path: string): Promise<void>;
}


export const fileKey = (hash: string): string => `files/${hash}`;
export const changeKey = (turn: string, changeNumber: number): string => `turns/${turn}/changes/${changeNumber}.json`;

export class MissingArtifact extends Error {
	constructor(readonly key: string) { super(`${key} is not in the Computer's artifacts`); }
}

/** The content hash an artifact key names: `files/<hash>`. */
export const hashOf = (key: string): string => key.split('/')[1];

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
 * Puts every key a request names into `computer`'s store before the turn is sent (4.1, "Bytes"). One listing of
 * its store; each key it lacks, or holds cut short (`size`, the Studio's copy's size), is copied inside Pine's storage from the Computer remembered holding it, so a project's
 * video never passes through the person's connection, and uploaded from `bytes`, the Studio's copy, when none is
 * remembered or the copy fails. Returns how many were copied and uploaded.
 */
export async function putAll(store: ArtifactStore, computer: string, holders: Holders, keys: readonly string[], bytes: (key: string) => Promise<Buffer>, size: (key: string) => number, signal?: AbortSignal): Promise<{ copied: number; uploaded: number }> {
	const listed = new Map((await store.list('files/')).map(f => [f.path, f.size]));
	// A file whose size is not its bytes' is an upload cut off part way: it is put again. A listing gives sizes, not
	// hashes, and a whole file of other bytes cannot sit under its own hash's name.
	const whole = (key: string) => listed.has(key) && listed.get(key) === size(key);
	await holders.set([...new Set(keys)].filter(whole).map(hashOf), computer);
	let copied = 0;
	let uploaded = 0;
	for (const key of [...new Set(keys)].filter(key => !whole(key))) {
		signal?.throwIfAborted();
		const from = holders.get(hashOf(key));
		if (from && from !== computer && await store.copy(from, key).then(() => true, () => false)) {
			copied++;
		} else {
			await store.upload(key, await bytes(key), signal);
			uploaded++;
		}
		await holders.set([hashOf(key)], computer);
	}
	return { copied, uploaded };
}
