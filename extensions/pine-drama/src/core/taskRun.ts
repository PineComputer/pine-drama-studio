// A task's start on the Studio's side (doc/protocol.md, 4.1 and 4.2): the request, built from the drama's folder and the
// returns installed in it, and the message that starts it. No vscode import.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeWhole } from './choices';
import type { TasksOf } from './project';
import { projectIdentity } from './projectPlace';
import type { Choices, Folders, Note, ProtocolError, Request, Snapshot } from './protocol';
import { fileKey, sha256, stateKey, versionKey } from './taskArtifacts';

/**
 * Whether a file travels with a task, by its POSIX path below the client folder walked (CLIENT_FOLDERS): only if no part
 * of it is hidden, so .git, .DS_Store, .env and every other hidden name stay on this machine.
 */
export function transportedPath(rel: string): boolean {
	return rel.split('/').every(part => !part.startsWith('.'));
}

/**
 * The folder's tree as a task carries it (transportedPath): its files, by project-relative POSIX path and absolute path,
 * and the folders below the root. It never descends into a folder that does not travel, so a hidden one (.git, or one
 * the person cannot read) is neither read nor a reason to fail. A link is not followed, and a linked file does not travel.
 */
export function transportedTree(root: string): { readonly files: { readonly rel: string; readonly path: string }[]; readonly folders: string[] } {
	const files: { rel: string; path: string }[] = [];
	const folders: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = `${prefix}${entry.name}`;
			const path = join(dir, entry.name);
			if (entry.isDirectory() && transportedPath(`${rel}/-`)) {
				folders.push(path);
				walk(path, `${rel}/`);
			} else if (entry.isFile() && transportedPath(rel)) {
				files.push({ rel, path });
			}
		}
	};
	walk(root, '');
	return { files, folders };
}

/** Every file of the folder that travels with a task. */
export function transportedFiles(root: string): { readonly rel: string; readonly path: string }[] { return transportedTree(root).files; }

/** What the Studio keeps of an installed return (doc/protocol.md, 4.3): enough for the next request and the readers. */
export interface Installed {
	readonly task: string;
	readonly scope: string;
	/** The Chat that sent it: its session's private state is the one its later tasks carry. */
	readonly chat: string;
	/** When its request was sent (DramaRecord.sentRequest): of two returns of a session, the later-sent one is the session's. */
	readonly sent: string;
	readonly versions: Folders;
	readonly reviews: Folders;
	readonly private_state: string | null;
	readonly snapshot: Snapshot | null;
	/** The choices the Computer side could not apply (4.3, `problems`), shown on their cards until the session's next return. */
	readonly problems: readonly { readonly ref: string; readonly error: ProtocolError }[];
	/** When it was installed or dealt with (RFC 3339): returns are ordered by it (doc/protocol.md, 4.4). */
	readonly installed: string;
}

/**
 * What a turn leaves in the drama's folder, `turns/<turn id>.json` (doc/protocol.md, 4.4): the return as installed, and the
 * versions and choices its request carried, so that every Studio shows the project the same, from the folder alone.
 * Nothing of the person's session travels: no Chat, private state or notes.
 */
export interface Turn {
	readonly schema: 1;
	readonly task: string;
	readonly scope: string;
	readonly sent: string;
	readonly installed: string;
	readonly request: Pick<Request, 'versions' | 'choices'>;
	readonly versions: Folders;
	readonly reviews: Folders;
	readonly problems: Installed['problems'];
	readonly snapshot: Snapshot | null;
}

/** A request as the Studio sent it (DramaRecord.sentRequest). */
export interface SentTask {
	readonly sent: string;
	readonly computer: string;
	readonly chat: string;
	readonly request: Request;
}

/** Writes `path` whole (choices.ts, writeWhole), its folder made first. */
async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeWhole(path, JSON.stringify(value));
}

const readJson = <T>(path: string): T | undefined => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined;

/** The turns the drama's folder holds (Turn), oldest installed first. */
export function turnsOf(root: string): Turn[] {
	const dir = join(root, 'turns');
	return (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : []).map(n => readJson<Turn>(join(dir, n))!)
		.sort((a, b) => a.installed.localeCompare(b.installed));
}

/**
 * The Studio's record of one drama, under its storage, outside the drama's folder: each request as sent
 * (`requests/<task>.json`), each return dealt with (`returns/<task>.json`), and each session's latest
 * (`sessions/<chat>.json`). What the project is travels with the folder instead (Turn): the returns read from there, so a
 * request names the archives every Studio knows of.
 */
export class DramaRecord {
	constructor(readonly dir: string, readonly root: string) { }

	returnPath(task: string): string { return join(this.dir, 'returns', `${task}.json`); }
	requestPath(task: string): string { return join(this.dir, 'requests', `${task}.json`); }
	sessionPath(chat: string): string { return join(this.dir, 'sessions', `${encodeURIComponent(chat)}.json`); }

	/** Keeps the request as sent: when (RFC 3339, so the strings order as the times do), to which Computer, from which Chat. */
	sentRequest(request: Request, computer: string, chat: string, at = new Date()): Promise<void> {
		return writeJson(this.requestPath(request.turn), { sent: at.toISOString(), computer, chat, request } satisfies SentTask);
	}

	sentTask(task: string): SentTask | undefined { return readJson<SentTask>(this.requestPath(task)); }

	/** Whether the task's return was dealt with: installed, refused, or found missing at its turn's end (handle). */
	handled(task: string): boolean { return existsSync(this.returnPath(task)); }

	/** Records an installed return, and makes it its session's latest unless a later-sent task of the session has returned. */
	async installed(done: Installed): Promise<void> {
		await writeJson(this.returnPath(done.task), done);
		await this.publish(done);
		this.dropPreviews(done.task);
		const latest = this.latest(done.chat);
		if (!latest || latest.sent <= done.sent) { await writeJson(this.sessionPath(done.chat), done); }
	}

	/** Records a task whose return installed nothing (refused, invalid, or never written), with any problems it carried: it is not read again. */
	async handle(task: string, problems: Installed['problems'] = []): Promise<void> {
		const sent = this.sentTask(task)!;
		this.dropPreviews(task);
		const done: Installed = { task, scope: sent.request.scope, chat: sent.chat, sent: sent.sent, versions: {}, reviews: {}, private_state: null, snapshot: null, problems, installed: new Date().toISOString() };
		await writeJson(this.returnPath(task), done);
		await this.publish(done);
	}

	/** Writes the turn of a return dealt with into the drama's folder (Turn), from the return and its request as sent. */
	publish(done: Installed): Promise<void> {
		const request = this.sentTask(done.task)?.request;
		return writeJson(join(this.root, 'turns', `${done.task}.json`), {
			schema: 1, task: done.task, scope: done.scope, sent: done.sent, installed: done.installed,
			request: { versions: request?.versions ?? {}, choices: request?.choices ?? null },
			versions: done.versions, reviews: done.reviews, problems: done.problems, snapshot: done.snapshot,
		} satisfies Turn);
	}

	/**
	 * Writes into the folder every return this record dealt with whose turn the folder lacks: those dealt with before turns
	 * travelled with the folder, or by a Studio stopped between the two writes. Returns how many it wrote.
	 */
	async publishKept(): Promise<number> {
		const dir = join(this.dir, 'returns');
		const kept = (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : []).map(n => readJson<Installed>(join(dir, n))!)
			.filter(done => done.installed && !existsSync(join(this.root, 'turns', `${done.task}.json`)));
		for (const done of kept) { await this.publish(done); }
		return kept.length;
	}

	/** Every request sent from this drama, oldest first. */
	requests(): SentTask[] {
		const dir = join(this.dir, 'requests');
		return (existsSync(dir) ? readdirSync(dir) : []).filter(n => n.endsWith('.json')).map(n => this.sentTask(n.slice(0, -'.json'.length))!)
			.sort((a, b) => a.sent.localeCompare(b.sent));
	}

	/** A Chat's sent tasks whose return was not dealt with yet, oldest first. */
	unhandled(chat: string): SentTask[] {
		return this.requests().filter(t => t.chat === chat && !this.handled(t.request.turn));
	}

	/** Every return dealt with in the drama, by any Studio: the folder's turns. */
	returns(): Turn[] { return turnsOf(this.root); }

	latest(chat: string): Installed | undefined { return readJson<Installed>(this.sessionPath(chat)); }

	/** The version folders and review files found on disk with no return naming them, each kept by its hash (adoptLoose). */
	adopted(): { readonly path: string; readonly hash: string; readonly kind: 'version' | 'review' }[] {
		const dir = join(this.dir, 'adopted');
		return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readJson<{ path: string; hash: string; kind: 'version' | 'review' }>(join(dir, n))!) : [];
	}

	adopt(path: string, hash: string, kind: 'version' | 'review'): Promise<void> {
		return writeJson(join(this.dir, 'adopted', `${sha256(path)}.json`), { path, hash, kind });
	}

	/** The previews of running tasks (resultImporter.ts, previewProgress): each version's folder in `previews/<hash>/`. */
	previews(): { readonly object: string; readonly version: string; readonly hash: string; readonly task: string; readonly dir: string }[] {
		const dir = join(this.dir, 'previews');
		return (existsSync(dir) ? readdirSync(dir) : []).filter(n => n.endsWith('.json')).map(n => {
			const hash = n.slice(0, -'.json'.length);
			return { ...readJson<{ object: string; version: string; task: string }>(join(dir, n))!, hash, dir: join(dir, hash) };
		});
	}

	/** A task's previews end with it: its return is installed (taking the same kept archives) or it ended without one. */
	private dropPreviews(task: string): void {
		for (const preview of this.previews().filter(p => p.task === task)) {
			rmSync(`${preview.dir}.json`, { force: true });
			rmSync(preview.dir, { recursive: true, force: true });
		}
	}
}

/** The record of the drama at `root` under the protocol storage `storage` (the extension's `<globalStorage>/protocol`). */
export function dramaRecordOf(storage: string, root: string): DramaRecord {
	return new DramaRecord(join(storage, 'dramas', sha256(projectIdentity(root)).slice(0, 32)), root);
}

/**
 * Writes into the folder at `root` the turns every record of this Studio profile holds for it and the folder lacks
 * (DramaRecord.publishKept): the protocol storage of each connection, and the one used before connections had their own.
 */
export async function publishKeptTurns(globalStorage: string, root: string): Promise<number> {
	const connections = join(globalStorage, 'connections');
	const storages = [join(globalStorage, 'protocol'), ...(existsSync(connections) ? readdirSync(connections).map(c => join(connections, c, 'protocol')) : [])];
	let written = 0;
	for (const storage of storages) { written += await dramaRecordOf(storage, root).publishKept(); }
	return written;
}

/**
 * What the views read of the drama's tasks (core/project.ts, TasksOf): every turn the folder holds, with the Chat that
 * sent it when this Studio did, and this Studio's requests not dealt with yet.
 */
export function tasksOf(record: DramaRecord | undefined, root: string): TasksOf {
	return {
		requests: () => {
			const turns = turnsOf(root);
			const mine = record?.requests() ?? [];
			return [
				...turns.map(t => ({ sent: t.sent, chat: mine.find(r => r.request.turn === t.task)?.chat ?? '', request: { turn: t.task, scope: t.scope as Request['scope'], ...t.request } })),
				...mine.filter(r => !turns.some(t => t.task === r.request.turn)),
			];
		},
		returns: () => turnsOf(root),
	};
}

/**
 * The snapshots of the returns installed in the drama at `root`, with the scope of the session that returned each, its
 * task, and when it was sent and installed, in install order (doc/protocol.md, 4.4). Each covers the objects it lists,
 * and a reader shows each object from the latest one that lists it (doc/protocol.md, 5.3).
 */
export function installedSnapshots(root: string): { readonly scope: 'project' | 'episodes'; readonly snapshot: Snapshot; readonly task: string; readonly sent: string; readonly installed: string }[] {
	return scopedSnapshots(turnsOf(root));
}

/** The snapshots of `returns`, in install order, each with its session's scope, its task and its times (installedSnapshots). */
export function scopedSnapshots(returns: readonly Pick<Turn, 'task' | 'scope' | 'sent' | 'installed' | 'snapshot'>[]): { readonly scope: 'project' | 'episodes'; readonly snapshot: Snapshot; readonly task: string; readonly sent: string; readonly installed: string }[] {
	return [...returns].sort((a, b) => a.installed.localeCompare(b.installed))
		.flatMap(r => r.snapshot ? [{ scope: r.scope === 'project' ? 'project' as const : 'episodes' as const, snapshot: r.snapshot, task: r.task, sent: r.sent, installed: r.installed }] : []);
}

/** The versions running tasks have announced and not returned yet, for the views to show beside the installed ones. */
export function previewVersions(storage: string, root: string): { readonly object: string; readonly version: string; readonly hash: string; readonly task: string; readonly dir: string }[] {
	return dramaRecordOf(storage, root).previews().filter(p => !existsSync(join(root, p.object, p.version)));
}

/** The folders of the client files (doc/protocol.md, 3.3): the person's pictures and their inputs. */
export const CLIENT_FOLDERS = ['imports', 'inputs'] as const;

/** Every client file of the drama at `root`: its project-relative path, and where it is. */
export function clientFileList(root: string): { readonly rel: string; readonly path: string }[] {
	return CLIENT_FOLDERS.flatMap(top => existsSync(join(root, top))
		? transportedFiles(join(root, top)).map(f => ({ rel: `${top}/${f.rel}`, path: f.path })) : []);
}

/** The client files, by path to their hash (4.2, `files`). */
export function clientFiles(root: string): Record<string, string> {
	return Object.fromEntries(clientFileList(root).map(f => [f.rel, sha256(readFileSync(f.path))]));
}

/** Every file of a folder, by its path relative to it, sorted, leaving out `reviews/` (a version's archive, 4.1). */
function archivedFiles(dir: string, prefix = ''): string[] {
	return readdirSync(join(dir, prefix)).sort().flatMap(name => {
		const rel = prefix ? `${prefix}/${name}` : name;
		if (!prefix && name === 'reviews') { return []; }
		return statSync(join(dir, rel)).isDirectory() ? archivedFiles(dir, rel) : [rel];
	});
}

/**
 * The version folders under `root`, by path: each folder holding a `version.json` (2.1), outside hidden ones and the client
 * files, and each `config/<version id>`, the Computer side's config, which has none (section 1).
 */
function versionFolders(root: string, prefix = ''): string[] {
	if (prefix === 'config') {
		return readdirSync(join(root, prefix), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => `config/${e.name}`);
	}
	return readdirSync(join(root, prefix), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !(!prefix && ['imports', 'inputs'].includes(e.name)))
		.flatMap(e => {
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			return existsSync(join(root, rel, 'version.json')) ? [rel] : versionFolders(root, rel);
		});
}

/**
 * The archive a request names for each version folder and review file still in the project (4.2, `versions` and
 * `reviews`): its return's, or the one this Studio archived from it later (adoptLoose), which takes its place.
 */
function heldArchives(root: string, record: DramaRecord): { versions: Record<string, string>; reviews: Record<string, string> } {
	const versions: Record<string, string> = {};
	const reviews: Record<string, string> = {};
	for (const done of record.returns()) {
		for (const [folder, hash] of Object.entries(done.versions)) { if (existsSync(join(root, folder))) { versions[folder] = hash; } }
		for (const [path, hash] of Object.entries(done.reviews)) { if (existsSync(join(root, path))) { reviews[path] = hash; } }
	}
	for (const { path, hash, kind } of record.adopted()) {
		if (existsSync(join(root, path))) { (kind === 'version' ? versions : reviews)[path] = hash; }
	}
	return { versions, reviews };
}

/**
 * Archives from the folder every version folder and review file a request would name with an archive this Studio does not
 * keep (4.1, "Archive hashes"), so that a request names only archives it can send: one made outside the client, one
 * installed by another Studio (its turn is in the folder, its archive is not here), a returned folder without a
 * version.json (2.1), or one whose kept archive is gone. A folder is archived with system tar, its names sorted and its
 * `reviews/` left out, and a review file is kept by its hash. Each is recorded, and from then on it is held like an
 * installed one.
 */
async function adoptLoose(root: string, record: DramaRecord, kept: string): Promise<void> {
	const held = heldArchives(root, record);
	const isKept = (hash: string | undefined, key: (hash: string) => string) => !!hash && existsSync(join(kept, key(hash)));
	for (const folder of new Set([...Object.keys(held.versions), ...existsSync(root) ? versionFolders(root) : []])) {
		if (!isKept(held.versions[folder], versionKey)) {
			const temp = join(kept, `.pine-adopt-${sha256(folder)}.tar`);
			await mkdir(dirname(temp), { recursive: true });
			execFileSync('tar', ['-cf', temp, '-C', join(root, folder), ...archivedFiles(join(root, folder))]);
			const bytes = readFileSync(temp);
			rmSync(temp);
			await mkdir(dirname(join(kept, versionKey(sha256(bytes)))), { recursive: true });
			await writeWhole(join(kept, versionKey(sha256(bytes))), bytes);
			await record.adopt(folder, sha256(bytes), 'version');
		}
		const reviews = join(root, folder, 'reviews');
		for (const name of existsSync(reviews) ? readdirSync(reviews).filter(n => n.endsWith('.json')) : []) {
			const path = `${folder}/reviews/${name}`;
			if (isKept(held.reviews[path], fileKey)) { continue; }
			const bytes = readFileSync(join(root, path));
			await mkdir(dirname(join(kept, fileKey(sha256(bytes)))), { recursive: true });
			await writeWhole(join(kept, fileKey(sha256(bytes))), bytes);
			await record.adopt(path, sha256(bytes), 'review');
		}
	}
}

/** Builds the request: every version folder and review file still in the folder, the client files, the session's private state. */
export async function requestOf(root: string, record: DramaRecord, kept: string, task: string, scope: Request['scope'], chat: string, choices: Choices | null, notes: readonly Note[]): Promise<Request> {
	await adoptLoose(root, record, kept);
	const { versions, reviews } = heldArchives(root, record);
	return { schema: 1, turn: task, scope, choices, versions, reviews, files: clientFiles(root), private_state: record.latest(chat)?.private_state ?? null, notes };
}

/** Every artifact key a request names: what must be in the Computer's store before the task is sent. */
export function requestKeys(request: Request): string[] {
	return [
		...Object.values(request.versions).map(versionKey),
		...[...Object.values(request.reviews), ...Object.values(request.files)].map(fileKey),
		...(request.private_state ? [stateKey(request.private_state)] : []),
	];
}

/** The message that starts a task: its first line names the task, the person's own words follow. */
export function taskMessage(task: string, words: string): string {
	return `pine-drama-turn ${task}\n${words}`;
}

