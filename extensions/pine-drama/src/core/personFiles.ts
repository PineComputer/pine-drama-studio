// The files a folder held when it became a project: the person's,
// so no task's result replaces them. Kept in the Studio's own folder, which a result never writes
// (resultImporter.ts, intoStudioFolder) and every task restores to the Studio's bytes (pine-task.py, persons). No vscode import.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STUDIO_FOLDER, transportedFiles } from './taskRun';

/** The record's path in the project. */
export const PERSON_FILES = `${STUDIO_FOLDER}/person-files.json`;

/** The folder's files that travel with a task, outside the Studio's folder: the ones the record would list now. */
export function folderFiles(root: string): { readonly rel: string; readonly bytes: number }[] {
	return transportedFiles(root).filter(f => f.rel.split('/')[0] !== STUDIO_FOLDER).map(f => ({ rel: f.rel, bytes: statSync(f.path).size }))
		.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Records the folder's files as the person's, before the folder is bound (chats.ts): a project bound has its record, so
 * a crash between the two leaves an unbound folder, whose next first send keeps that record. A record already there stands,
 * whatever store binds the folder again (another Studio store, or one set aside by a schema change): what a task made
 * since is never taken for the person's. Written whole through a rename, so a reader sees no half record. A folder with
 * no files gets no record: there is nothing to keep.
 */
export function recordPersonFiles(root: string): void {
	const target = join(root, PERSON_FILES);
	if (existsSync(target)) { return; }
	const files = folderFiles(root).map(f => f.rel);
	if (!files.length) { return; }
	mkdirSync(join(root, STUDIO_FOLDER), { recursive: true });
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ files }, null, '\t')}\n`);
	renameSync(temp, target);
}

/** The recorded files; none when the project has no record (it began in an empty folder, or as a drama-cli project). */
export function personFiles(root: string): ReadonlySet<string> {
	let text: string;
	try { text = readFileSync(join(root, PERSON_FILES), 'utf8'); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return new Set(); } throw error; }
	const files = (JSON.parse(text) as { files?: unknown }).files;
	if (!Array.isArray(files) || !files.every(f => typeof f === 'string')) { throw new Error(`${PERSON_FILES}: "files" is not a list of paths`); }
	return new Set(files);
}

/**
 * What the agent is told of them, with the standing instructions (chats.ts), so every session of the project knows: a fact of
 * the setting, as the transport's own facts are (taskRun.ts), not a procedure. Undefined when there are none.
 */
export function personFilesNote(root: string): string | undefined {
	const files = [...personFiles(root)];
	return files.length
		? `The project folder held these files before the project began, and they are in drama/: ${files.join(', ')}. They are the person's own: the studio publishes no result that changes them, so write your work to other files.`
		: undefined;
}
