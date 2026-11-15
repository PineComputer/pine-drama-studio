// The project's one hash, SHA-256 in lowercase hex (doc/protocol.md section 1, "Hash"): of bytes or text, and of a
// stream, read as it comes, so a large take is never held whole: a file on disk, or a blob of the project's history
// (projectHistory.ts sha256OfBlob). No vscode import.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { noFileThere } from './placement';

/** The lowercase hex SHA-256 of `bytes`. */
export const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** The SHA-256 of what `stream` gives, read as it comes. */
export async function sha256OfStream(stream: Readable): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of stream) { hash.update(chunk as Buffer); }
	return hash.digest('hex');
}

/** The SHA-256 of the file at `file` now, or null when there is none there. */
export async function sha256OfFile(file: string): Promise<string | null> {
	try {
		return await sha256OfStream(createReadStream(file));
	} catch (error) {
		if (noFileThere(error)) { return null; }
		throw error;
	}
}
