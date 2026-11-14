// The project's one hash, SHA-256 in lowercase hex (doc/protocol.md section 1, "Hash"): of bytes or text, and of a file
// on disk, streamed, so a large take is never held whole. No vscode import.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { noFileThere } from './placement';

/** The lowercase hex SHA-256 of `bytes`. */
export const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** The SHA-256 of the file at `file` now, read in 1 MiB chunks, or null when there is none there. */
export function sha256OfFileOnDisk(file: string): string | null {
	let fd: number;
	try {
		fd = openSync(file, 'r');
	} catch (error) {
		if (noFileThere(error)) { return null; }
		throw error;
	}
	try {
		const hash = createHash('sha256');
		const chunk = Buffer.alloc(1 << 20);
		for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) { hash.update(chunk.subarray(0, n)); }
		return hash.digest('hex');
	} finally {
		closeSync(fd);
	}
}
