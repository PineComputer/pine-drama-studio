// The library: every file a turn returns, kept by the Studio so reading, review and delivery outlive the
// Computer. Bytes are stored once, named by SHA-256; the index row (store.ts `library_files`) says what the
// file is and which turn returned it.
// Ported from open-pinedrama, branch main at 3e7dc81, src/engine/library.ts (`blobPath` :41, `store` :46, `seenBefore` :84,
// `save` :93, `filesOfTurn` :174); the file is the same on main as on redesign/studio. Differences: the scope is a Chat key, not a drama id; the root folder is given
// by the caller (the extension's global storage), not a module constant; the index is in the Studio's SQLite
// store; the columns that describe a drama's pictures (subject, look, segment, style, version) are not kept, since
// classify(rel_path) gives them again. No vscode import.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, type ReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LibraryFile, Store } from './store';
import { hashFile } from './projectPlace';

interface Origin {
	chatKey: string;
	turnId: string;
	relPath: string;
	type: string;
	/** What the file is, for the library: `archive` for a part of a packed project; `other` when not given. */
	kind?: string;
}

export class Library {
	constructor(private readonly store: Store, readonly root: string) { }

	blobPath(sha: string): string {
		return join(this.root, sha.slice(0, 2), sha);
	}

	openBlob(sha: string): ReadStream {
		return createReadStream(this.blobPath(sha));
	}

	/** Whether the Chat already has this file, at the same path with the same bytes: the agent returned it before. */
	seenBefore(key: string, relPath: string, sha: string): boolean {
		return this.store.libraryFileBySha(key, relPath, sha) !== undefined;
	}

	/** Whether the Chat has a file at this path, whatever its bytes. */
	known(key: string, relPath: string): boolean {
		return this.store.libraryKnows(key, relPath);
	}

	/** Whether the content store has these bytes. */
	has(sha: string): boolean {
		return existsSync(this.blobPath(sha));
	}

	/** These bytes from the content store, when it has them (a live read put them there): read here, not from Pine. */
	stored(sha: string): ReadableStream<Uint8Array> | undefined {
		return existsSync(this.blobPath(sha)) ? Readable.toWeb(this.openBlob(sha)) as ReadableStream<Uint8Array> : undefined;
	}

	filesOfTurn(turnId: string): LibraryFile[] {
		return this.store.libraryFiles(turnId);
	}

	/** Writes bytes or a stream to the library and returns their SHA-256 and size. */
	async put(body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ sha: string; size: number }> {
		mkdirSync(this.root, { recursive: true });
		const temp = join(this.root, `.incoming-${randomUUID()}`);
		const hash = createHash('sha256');
		let size = 0;
		const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.fromWeb(body as never);
		source.on('data', (chunk: Buffer) => {
			hash.update(chunk);
			size += chunk.length;
		});
		try {
			await pipeline(source, createWriteStream(temp));
			const sha = hash.digest('hex');
			const target = this.blobPath(sha);
			if (existsSync(target) && hashFile(target) === sha) {
				rmSync(temp);
			} else {
				mkdirSync(dirname(target), { recursive: true });
				renameSync(temp, target);
			}
			return { sha, size };
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	}

	/**
	 * Saves one file and indexes it. A file already saved for the same turn and path is not saved again, so settling
	 * a turn twice is safe; nor is one the agent returns again unchanged, which stays with the turn that first
	 * returned it. `write` wraps the index write (the caller's Pine session generation check); the bytes are written outside it.
	 */
	async save(body: ReadableStream<Uint8Array> | Uint8Array, origin: Origin, write: <T>(work: () => T) => T = work => work()): Promise<number> {
		const existing = this.store.libraryFile(origin.turnId, origin.relPath);
		if (existing) {
			return existing.id;
		}
		const { sha, size } = await this.put(body);
		const kind = origin.kind ?? 'other';
		return write(() => {
			// A pack's parts are saved with every turn that returns them: the newest turn's set is whole on its own.
			if (kind !== 'archive') {
				const earlier = this.store.libraryFileBySha(origin.chatKey, origin.relPath, sha);
				if (earlier) {
					return earlier.id;
				}
			}
			return this.store.insertLibraryFile({
				chat_key: origin.chatKey,
				turn_id: origin.turnId,
				sha,
				rel_path: origin.relPath,
				size,
				type: origin.type || 'application/octet-stream',
				kind,
			});
		});
	}
}
