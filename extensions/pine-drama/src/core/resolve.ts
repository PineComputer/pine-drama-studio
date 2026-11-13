// One resolver from a path a task returned to what the person sees. It is the
// only place that maps a returned `drama/<path>` to the drama's folder, its only copy since local first; Review and
// Chat links call it. States:
// - arrived: the folder holds the file; with `verify`, also the SHA-256 asked for. For a version the folder no longer
//   holds (a record drama-cli has since updated), the library's bytes for that SHA-256, read-only, and a newer copy exists;
// - arriving: a stop is still settling and Pine listed the file for it;
// - failed: the stop that listed it failed to settle, with its error;
// - not returned: no stop of the session listed it. Pine's listing is the source, never the absence of a local file;
// - refused: the path leaves drama/ (containment, core/projectPlace.ts refusedPath and placement.within).
// Showing a file needs only its recorded identity and presence; deciding on it needs its exact bytes. So the folder's file
// is hashed only with `verify`, at the decision boundaries and when a version under review is opened, as Code-OSS shows a
// file freely and checks its etag only when writing (files.ts, IWriteFileOptions; fileService.ts, validateWriteFile).
// Fix plan, item 4. No vscode import.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { hashFile, refusedPath } from './projectPlace';
import { within } from './placement';
import type { Store } from './store';

export type Resolved =
	| { readonly state: 'arrived'; readonly where: 'folder'; readonly path: string }
	| { readonly state: 'arrived'; readonly where: 'library'; readonly sha: string; readonly newer: boolean }
	| { readonly state: 'arriving' }
	| { readonly state: 'failed'; readonly error: string }
	| { readonly state: 'notReturned' }
	| { readonly state: 'refused'; readonly reason: string };

export interface ResolveSources {
	readonly store: Store;
	/** Whether the content store holds these bytes. */
	has(sha: string): boolean;
	/** The session's mirror (`projectRootOf`). */
	readonly root: string;
	/** The folder the mirror must lie in, by real path: the bound folder (`projectPlaceOf`). */
	readonly boundary: string;
	readonly key: string;
}

export function resolveReturned(src: ResolveSources, remotePath: string, sha?: string, verify = false): Resolved {
	if (!remotePath.startsWith('drama/')) {
		return { state: 'refused', reason: `${remotePath} is not in the drama's folder` };
	}
	if (!within(src.boundary, src.root)) {
		return { state: 'refused', reason: `the drama's folder ${src.root} leads outside ${src.boundary} through a link` };
	}
	const rel = remotePath.slice('drama/'.length);
	const refused = refusedPath(rel) ?? (within(src.root, join(src.root, rel)) ? undefined : `${rel} leads outside the drama's folder through a link`);
	if (refused) {
		return { state: 'refused', reason: refused };
	}
	const place = { path: join(src.root, rel) };
	// A file, not merely a name: a directory in its place is not the file (it would also make hashing throw).
	const present = statSync(place.path, { throwIfNoEntry: false })?.isFile() ?? false;
	if (present && (sha === undefined || !verify || hashFile(place.path) === sha)) {
		return { state: 'arrived', where: 'folder', path: place.path };
	}
	if (sha !== undefined && src.has(sha)) {
		return { state: 'arrived', where: 'library', sha, newer: present };
	}
	const listing = src.store.turnFollowUps(src.key).filter(row => (JSON.parse(row.returned) as string[]).includes(remotePath));
	if (listing.length === 0) {
		return { state: 'notReturned' };
	}
	const last = listing[listing.length - 1];
	if (last.save_error) {
		return { state: 'failed', error: last.save_error };
	}
	if (!last.done) {
		return { state: 'arriving' };
	}
	return { state: 'failed', error: `${remotePath} is not in the drama's folder, though its stop was settled` };
}
