// A turn on the Studio's side, protocol major 2 (doc/protocol.md section 4): its request, from the folder as its history
// records it; its changes, applied in order as they arrive, each through the one landing; and its return, which resolves
// it. The Studio's own record of a project's turns lives in its storage, never in the folder. No vscode import.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyChangeToProjectFolder } from './applyChange';
import { writeWhole } from './placement';
import { projectIdentity } from './projectPlace';
import { blobBytes, commitFilesFoundOnDisk, listFilesOfHead, sha256OfBlob } from './projectHistory';
import { majorTwo, type Change, type Note, type PaidCallState, type Request, type Return } from './protocol';
import { sha256 } from './sha256';
import { changeKey, fetchKept, fileKey, Holders, keptBytes, MissingArtifact, paidCallsPrefix, privateStateKey, putAll, requestKey, returnKey, type ArtifactStore } from './taskArtifacts';

/** A request as the Studio sent it: when (RFC 3339, so the strings order as the times do), to which Computer, from which Chat. */
export interface SentTurn {
	readonly sent: string;
	readonly computer: string;
	readonly chat: string;
	readonly request: Request;
}

/**
 * A turn resolved (doc/protocol.md 4.6): its return's state, or null when the turn ended with none (4.7); the files its
 * changes wrote; and the objects it is still making, by a paid call not settled (4.5), until a later turn settles it.
 */
export interface ResolvedTurn {
	readonly state: Return['state'] | null;
	readonly resolved: string;
	readonly files: readonly string[];
	readonly making: readonly string[];
}

/**
 * The Studio's record of one project's turns, under its storage: each request as sent (`requests/<turn>.json`), each turn
 * resolved (`resolved/<turn>.json`), and each session's private state from its latest resolved return
 * (`sessions/<chat>.json`, doc/protocol.md 4.6, "Private state").
 */
export class TurnRecord {
	constructor(readonly dir: string) { }

	private path(kind: 'requests' | 'resolved' | 'sessions', name: string): string { return join(this.dir, kind, `${encodeURIComponent(name)}.json`); }

	private async write(kind: 'requests' | 'resolved' | 'sessions', name: string, value: unknown): Promise<void> {
		await mkdir(join(this.dir, kind), { recursive: true });
		await writeWhole(this.path(kind, name), JSON.stringify(value));
	}

	private read<T>(kind: 'requests' | 'resolved' | 'sessions', name: string): T | undefined {
		return existsSync(this.path(kind, name)) ? JSON.parse(readFileSync(this.path(kind, name), 'utf8')) as T : undefined;
	}

	sentRequest(request: Request, computer: string, chat: string, at = new Date()): Promise<void> {
		return this.write('requests', request.turn_id, { sent: at.toISOString(), computer, chat, request } satisfies SentTurn);
	}

	sentTurn(turn: string): SentTurn | undefined { return this.read<SentTurn>('requests', turn); }

	resolved(turn: string): ResolvedTurn | undefined { return this.read<ResolvedTurn>('resolved', turn); }

	/** Every request sent from this project, oldest first. */
	requests(): SentTurn[] {
		const dir = join(this.dir, 'requests');
		return (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : [])
			.map(n => this.sentTurn(decodeURIComponent(n.slice(0, -'.json'.length)))!).sort((a, b) => a.sent.localeCompare(b.sent));
	}

	/** A Chat's latest resolved turn, or undefined. */
	latestResolved(chat: string): SentTurn | undefined { return this.requests().filter(t => t.chat === chat && this.resolved(t.request.turn_id)).at(-1); }

	/** A Chat's sent turns not resolved yet, oldest first: a session sends its next only after its last is resolved (4.1). */
	unresolved(chat: string): SentTurn[] { return this.requests().filter(t => t.chat === chat && !this.resolved(t.request.turn_id)); }

	/** The private state a Chat's next request names: its latest resolved return's (4.6). */
	privateState(chat: string): string | null { return this.read<{ private_state: string | null }>('sessions', chat)?.private_state ?? null; }

	/** Records `turn` resolved; a return that names a private state makes it its session's (4.6). */
	async resolve(turn: string, resolved: Omit<ResolvedTurn, 'resolved'>, privateState?: string | null): Promise<void> {
		const chat = this.sentTurn(turn)!.chat;
		if (privateState !== undefined) { await this.write('sessions', chat, { private_state: privateState }); }
		await this.write('resolved', turn, { ...resolved, resolved: new Date().toISOString() } satisfies ResolvedTurn);
	}

	/** The resolved turns still making something, by turn (4.5). */
	stillMaking(): Map<string, readonly string[]> {
		const dir = join(this.dir, 'resolved');
		return new Map((existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : []).map(n => decodeURIComponent(n.slice(0, -'.json'.length)))
			.map(turn => [turn, this.resolved(turn)!.making] as const).filter(([, making]) => making.length > 0));
	}

	/** Records what resolved turn `turn` is still making now that a later turn settled some of its calls. */
	async settled(turn: string, making: readonly string[]): Promise<void> {
		await this.write('resolved', turn, { ...this.resolved(turn)!, making });
	}
}

/** The turn record of the project at `root` under the Studio's protocol storage `storage`. */
export function turnRecordOf(storage: string, root: string): TurnRecord {
	return new TurnRecord(join(storage, 'projects', sha256(projectIdentity(root)).slice(0, 32)));
}

/** The message that starts a turn (doc/protocol.md 4.1): its first line names the turn, the person's own words follow. */
export function turnMessage(turn: string, words: string): string {
	return `pine-drama-turn ${turn}\n${words}`;
}

/** Where a turn's store and the Studio's own copies are: the Computer, its store, the copies kept, the holders. */
export interface TurnPlace {
	readonly root: string;
	readonly record: TurnRecord;
	readonly computer: string;
	readonly store: ArtifactStore;
	readonly kept: string;
	readonly holders: Holders;
}

/**
 * Puts turn `turn` of Chat `chat` on its Computer (doc/protocol.md 4.1, 4.2): the folder recorded first, as the seed must
 * be; every file of HEAD but a hidden one as `seed_files`, by its SHA-256 (projectHistory.ts sha256OfBlob); every file and
 * the private state the store lacks put there; then request.json, written once. Returns the request.
 */
export async function sendTurnRequest(at: TurnPlace, turn: string, chat: string, notes: readonly Note[] = [], signal?: AbortSignal): Promise<{ request: Request; copied: number; uploaded: number }> {
	await commitFilesFoundOnDisk(at.root, `The project as found before turn ${turn}`);
	const files = (await listFilesOfHead(at.root)).filter(f => f.path.split('/').every(part => !part.startsWith('.')));
	// One blob at a time, each hashed once ever (sha256OfBlob): a first seed of many files never starts a process per file at once.
	const hashed: (typeof files[number] & { sha256: string })[] = [];
	for (const f of files) { hashed.push({ ...f, sha256: await sha256OfBlob(at.root, f.blob) }); }
	const request: Request = {
		schema: 2, turn_id: turn, seed_files: Object.fromEntries(hashed.map(f => [f.path, f.sha256])),
		session_private_state: at.record.privateState(chat), notes_for_pine_computer: notes,
	};
	const byKey = new Map(hashed.map(f => [fileKey(f.sha256), f]));
	const state = request.session_private_state ? privateStateKey(request.session_private_state) : null;
	// The session's private state goes up from the Studio's copy, kept when its return named it (4.6).
	const kept = (key: string) => {
		const got = keptBytes(at.kept, key);
		if (!got) { throw new Error(`this Studio keeps no copy of the session's private state ${request.session_private_state}`); }
		return got;
	};
	const bytes = async (key: string) => key === state ? kept(key) : blobBytes(at.root, byKey.get(key)!.blob);
	const size = (key: string) => key === state ? keptBytes(at.kept, key)?.length ?? -1 : byKey.get(key)!.size;
	const put = await putAll(at.store, at.computer, at.holders, [...byKey.keys(), ...state ? [state] : []], bytes, size, signal);
	await at.store.upload(requestKey(turn), Buffer.from(JSON.stringify(request)), signal);
	// The last point the person's Stop keeps the turn from starting; after it the run goes, and a Stop cancels its turn.
	signal?.throwIfAborted();
	await at.record.sentRequest(request, at.computer, chat);
	return { request, ...put };
}

/** Where a turn's stored changes were read up to: the next number, and the hash of the bytes of the one before it. */
export interface ChangesRead {
	readonly next: number;
	readonly previous: string | null;
}

/**
 * Applies the turn's changes stored after `read`, in order, up to the first one not stored yet (doc/protocol.md 4.3,
 * 4.4): each checked to follow the one before it (`previous_change_sha256`), so a change replaced in the store is never
 * applied, then through the one landing, which skips one its history records already. Returns where it read up to and
 * the files the changes read here wrote.
 */
export async function applyStoredChanges(at: TurnPlace, turn: string, read: ChangesRead = { next: 1, previous: null }): Promise<ChangesRead & { readonly files: readonly string[] }> {
	let { next, previous } = read;
	const written = new Set<string>();
	for (let bytes = await at.store.read(changeKey(turn, next)); bytes; bytes = await at.store.read(changeKey(turn, next))) {
		const change = majorTwo(changeKey(turn, next), JSON.parse(bytes.toString('utf8'))) as Change;
		if (change.previous_change_sha256 !== previous) { throw new Error(`${changeKey(turn, next)} does not follow the change before it`); }
		const files = change.files_after_change;
		for (const path of Object.keys(files)) { written.add(path); }
		await applyChangeToProjectFolder(at.root, {
			filesAfterChange: files, author: 'pine-computer', commitMessage: `Turn ${turn}, change ${next}`, turnChange: { turnId: turn, changeNumber: next },
		}, async hash => {
			const got = await at.store.read(fileKey(hash));
			if (!got) { throw new MissingArtifact(fileKey(hash)); }
			return got;
		});
		// The Computer that stored them holds them: the next turn copies from it rather than uploading.
		await at.holders.set(Object.values(files).filter((h): h is string => h !== null), at.computer);
		previous = sha256(bytes);
		next++;
	}
	return { next, previous, files: [...written] };
}

/** How a turn was resolved, for the Chat to say (doc/protocol.md 4.6, 4.7). */
export type Resolution =
	| { readonly kind: 'returned'; readonly ret: Return; readonly applied: number }
	/** No return.json at the turn's end: what was stored is applied, and the run may have spent money (4.7). */
	| { readonly kind: 'no return'; readonly applied: number };

/**
 * Resolves turn `turn` at its end (doc/protocol.md 4.6, 4.7): its return read and its changes applied up to `last_change`,
 * its private state kept; with no return, every stored change up to the first gap, the private state as it was. A change
 * the return names that the store lacks leaves the turn unresolved, to be tried again.
 */
export async function resolveTurn(at: TurnPlace, turn: string): Promise<Resolution> {
	const bytes = await at.store.read(returnKey(turn));
	// What its calls are still making is read before the turn is recorded resolved, so nothing is read after it (4.5).
	const making = async () => [...await objectsBeingMade(at.store, turn)];
	if (!bytes) {
		const { next, files } = await applyStoredChanges(at, turn);
		await at.record.resolve(turn, { state: null, files, making: await making() });
		return { kind: 'no return', applied: next - 1 };
	}
	const ret = majorTwo(returnKey(turn), JSON.parse(bytes.toString('utf8'))) as Return;
	if (ret.state === 'pine_computer_refused_the_turn_before_running') {
		await at.record.resolve(turn, { state: ret.state, files: [], making: [] });
		return { kind: 'returned', ret, applied: 0 };
	}
	const last = ret.last_change?.change_number ?? 0;
	const { next, previous, files } = await applyStoredChanges(at, turn);
	if (next <= last) { throw new MissingArtifact(changeKey(turn, next)); }
	// The return names its last change by its bytes' hash (4.6): a later one stored, or another in its place, is not this turn's.
	if (next - 1 !== last || (last > 0 && previous !== ret.last_change!.sha256)) { throw new Error(`${returnKey(turn)} names change ${last}, which is not the last one stored`); }
	const privateState = ret.session_private_state ?? null;
	if (privateState) {
		await fetchKept(at.store, at.kept, privateStateKey(privateState), privateState);
		await at.holders.set([privateState], at.computer);
	}
	await at.record.resolve(turn, { state: ret.state, files, making: await making() }, privateState);
	return { kind: 'returned', ret, applied: last };
}

/**
 * The objects turn `turn` is making now (doc/protocol.md 4.5, "Making"): each with a paid call sent to its provider and no
 * terminal state yet. A call whose outcome cannot be learned is not settled, so it is still making.
 */
export async function objectsBeingMade(store: ArtifactStore, turn: string): Promise<Set<string>> {
	const byCall = new Map<string, PaidCallState[]>();
	for (const { path } of await store.list(paidCallsPrefix(turn))) {
		const bytes = await store.read(path);
		if (!bytes) { throw new MissingArtifact(path); }
		const state = majorTwo(path, JSON.parse(bytes.toString('utf8'))) as PaidCallState;
		byCall.set(state.paid_call_id, [...byCall.get(state.paid_call_id) ?? [], state]);
	}
	const terminal = new Set<PaidCallState['state']>(['provider_returned_output_to_pine_computer', 'provider_reported_failure_to_pine_computer', 'pine_computer_cancelled_call_after_person_pressed_stop']);
	return new Set([...byCall.values()].filter(states => states.some(s => s.state === 'pine_computer_sent_request_to_provider') && !states.some(s => terminal.has(s.state)))
		.map(states => states[0].object_id));
}
