// The project window lock: one Studio window per project. No vscode import.
//
// The window holds an SQLite transaction opened with BEGIN EXCLUSIVE on a per-project lock file for as long as it lives.
// SQLite "uses POSIX advisory locks to implement locking on Unix" (https://www.sqlite.org/lockingv3.html), and POSIX
// removes a process's locks on a file when "the process holding that file descriptor terminates" (fcntl, POSIX.1-2024),
// so a crashed window never leaves its project locked; no timestamp decides anything. Firefox locks its profile the same
// way: an fcntl lock on `.parentlock`, released by the OS when Firefox exits (toolkit/profile/nsProfileLock.cpp,
// `LockWithFcntl` and `LOCKFILE_NAME`, mozilla-firefox/firefox db547b6, lines 193-237 and 416-420).
//
// The lock file lives in one per-user directory outside every app's storage, so an installed Studio and a development
// build share it, and the person's project is not written to on open. It is named by the
// project's real path (projectIdentity), so a symlink leads to the same file. The Studio never deletes a lock file:
// a file deleted while held lets the next window create a new one and hold that too (spike (a), test 5). For the same
// reason the directory is not one the OS cleans, such as $TMPDIR.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectIdentity } from './projectPlace';

/** SQLite's result code when another connection holds the lock (https://www.sqlite.org/rescode.html#busy). */
const SQLITE_BUSY = 5;

/** The per-user directory of every Studio's project window locks. */
export function projectWindowLockDirectory(home = homedir()): string {
	return join(home, '.pine-drama-studio', 'locks');
}

/** A project's lock file: the SHA-256 of its real path, so every path to one folder names one file. */
export function projectWindowLockFile(directory: string, root: string): string {
	return join(directory, `${createHash('sha256').update(projectIdentity(root)).digest('hex')}.lock`);
}

export type ProjectWindowLock =
	| { readonly kind: 'held'; readonly file: string; release(): void }
	| { readonly kind: 'elsewhere'; readonly file: string };

/**
 * Takes the project's lock for this process, or says that another holds it. Refused at once: SQLite's default busy
 * timeout is 0, so a second window never waits. Any other failure throws, for the caller to say.
 */
export function lockProjectWindow(root: string, directory = projectWindowLockDirectory()): ProjectWindowLock {
	mkdirSync(directory, { recursive: true });
	const file = projectWindowLockFile(directory, root);
	const db = new DatabaseSync(file);
	try {
		db.exec('BEGIN EXCLUSIVE');
	} catch (error) {
		db.close();
		if ((error as { errcode?: number }).errcode === SQLITE_BUSY) {
			return { kind: 'elsewhere', file };
		}
		throw error;
	}
	let released = false;
	// Closing the connection ends the transaction and releases the lock; the file stays.
	return { kind: 'held', file, release: () => { if (!released) { released = true; db.close(); } } };
}
