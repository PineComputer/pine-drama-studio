// A turn on the Studio's side, protocol major 2 (doc/protocol.md section 4): its request, from the folder as its history
// records it, and its changes, applied in order as they arrive, each through the one landing; at the Pine turn's end
// every change stored is in, and the turn is settled. How the turn ended is Pine's own turn result. The Studio's own
// record of a project's turns lives in its storage, never in the folder. No vscode import.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyChangeToProjectFolder } from './applyChange';
import { writeWhole } from './placement';
import { readPineComputerTurnRecord, type PineComputerTurnRecord } from './project';
import { projectIdentity } from './projectPlace';
import { blobBytes, commitFilesFoundOnDisk, listFilesOfHead, sha256OfBlob } from './projectHistory';
import { majorTwo, RefusedWithUpgradeInstructions, refuseWithUpgradeInstructions, STUDIO_RELEASES_URL, type Change, type Note, type Request } from './protocol';
import { sha256 } from './sha256';
import { changeKey, fileKey, Holders, MissingArtifact, putAll, type ArtifactStore } from './taskArtifacts';

/** A request as the Studio sent it: when (RFC 3339, so the strings order as the times do), to which Computer, from which Chat. */
export interface SentTurn {
	readonly sent: string;
	readonly computer: string;
	readonly chat: string;
	readonly request: Request;
}

/** A turn settled at its Pine turn's end, with the files its changes wrote. A settled turn is never read again. */
export interface SettledTurn {
	readonly settled: string;
	readonly files: readonly string[];
}

/**
 * The Studio's record of one project's turns, under its storage: each request as sent (`requests/<turn>.json`) and each
 * turn settled (`settled/<turn>.json`).
 */
export class TurnRecord {
	constructor(readonly dir: string) { }

	private path(kind: 'requests' | 'settled', name: string): string { return join(this.dir, kind, `${encodeURIComponent(name)}.json`); }

	private async write(kind: 'requests' | 'settled', name: string, value: unknown): Promise<void> {
		await mkdir(join(this.dir, kind), { recursive: true });
		await writeWhole(this.path(kind, name), JSON.stringify(value));
	}

	private read<T>(kind: 'requests' | 'settled', name: string): T | undefined {
		return existsSync(this.path(kind, name)) ? JSON.parse(readFileSync(this.path(kind, name), 'utf8')) as T : undefined;
	}

	sentRequest(request: Request, computer: string, chat: string, at = new Date()): Promise<void> {
		return this.write('requests', request.turn_id, { sent: at.toISOString(), computer, chat, request } satisfies SentTurn);
	}

	sentTurn(turn: string): SentTurn | undefined { return this.read<SentTurn>('requests', turn); }

	settled(turn: string): SettledTurn | undefined { return this.read<SettledTurn>('settled', turn); }

	/** Every request sent from this project, oldest first. */
	requests(): SentTurn[] {
		const dir = join(this.dir, 'requests');
		return (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : [])
			.map(n => this.sentTurn(decodeURIComponent(n.slice(0, -'.json'.length)))!).sort((a, b) => a.sent.localeCompare(b.sent));
	}

	/** A Chat's latest settled turn, or undefined. */
	latestSettled(chat: string): SentTurn | undefined { return this.requests().filter(t => t.chat === chat && this.settled(t.request.turn_id)).at(-1); }

	/** A Chat's sent turns not settled yet, oldest first: a session sends its next only after its last is settled (4.1). */
	unsettled(chat: string): SentTurn[] { return this.requests().filter(t => t.chat === chat && !this.settled(t.request.turn_id)); }

	/** Records `turn` settled. */
	async settle(turn: string, settled: Omit<SettledTurn, 'settled'>): Promise<void> {
		await this.write('settled', turn, { ...settled, settled: new Date().toISOString() } satisfies SettledTurn);
	}

}

/** The turn record of the project at `root` under the Studio's protocol storage `storage`. */
export function turnRecordOf(storage: string, root: string): TurnRecord {
	return new TurnRecord(join(storage, 'projects', sha256(projectIdentity(root)).slice(0, 32)));
}

/** How a turn ended, by the protocol's names (doc/protocol.md 4.6). */
export type TurnEnded = 'pine_computer_is_waiting_for_person_answer' | 'pine_computer_finished_the_work' | 'person_stopped_the_turn' | 'pine_computer_broke_off_the_turn';

/** Pine's turn state (its agent turns) as the protocol names how a turn ended (4.6), the one mapping; undefined while it runs. */
export function turnEndedAs(state: string): TurnEnded | undefined {
	switch (state) {
		case 'needs_input': return 'pine_computer_is_waiting_for_person_answer';
		case 'completed': return 'pine_computer_finished_the_work';
		case 'canceled': return 'person_stopped_the_turn';
		case 'failed': return 'pine_computer_broke_off_the_turn';
		default: return undefined;
	}
}

/** The message that starts a turn (doc/protocol.md 4.1): its first line names the turn, the person's own words follow. */
export function turnMessage(turn: string, words: string): string {
	return `pine-drama-turn ${turn}\n${words}`;
}

/** Where a turn is: its project, the Studio's record of it, the Computer and its store, and who holds which file. */
export interface TurnPlace {
	readonly root: string;
	readonly record: TurnRecord;
	readonly computer: string;
	readonly store: ArtifactStore;
	readonly holders: Holders;
}

/**
 * Puts turn `turn` of Chat `chat` on its Computer (doc/protocol.md 4.1, 4.2): the folder recorded first, as the seed must
 * be; every file of HEAD but a hidden one as `seed_files`, by its SHA-256 (projectHistory.ts sha256OfBlob); every file
 * the store lacks put there; then the request is recorded, for the send to put into the session right before the turn's
 * message (4.1, `pine-drama-request.json`; chats.ts dispatch). Returns the request.
 */
export async function sendTurnRequest(at: TurnPlace, turn: string, chat: string, notes: readonly Note[] = [], signal?: AbortSignal): Promise<{ request: Request; copied: number; uploaded: number }> {
	await commitFilesFoundOnDisk(at.root, `The project as found before turn ${turn}`);
	const files = (await listFilesOfHead(at.root)).filter(f => f.path.split('/').every(part => !part.startsWith('.')));
	// One blob at a time, each hashed once ever (sha256OfBlob): a first seed of many files never starts a process per file at once.
	const hashed: (typeof files[number] & { sha256: string })[] = [];
	for (const f of files) { hashed.push({ ...f, sha256: await sha256OfBlob(at.root, f.blob) }); }
	const request: Request = {
		schema: 2, turn_id: turn, seed_files: Object.fromEntries(hashed.map(f => [f.path, f.sha256])), notes_for_pine_computer: notes,
	};
	const byKey = new Map(hashed.map(f => [fileKey(f.sha256), f]));
	const put = await putAll(at.store, at.computer, at.holders, [...byKey.keys()], key => blobBytes(at.root, byKey.get(key)!.blob), key => byKey.get(key)!.size, signal);
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
		const change = computerDocument(changeKey(turn, next), JSON.parse(bytes.toString('utf8'))) as Change;
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

/**
 * A document the Pine Computer stored for a turn, read. One of another major is refused with what to use (doc/protocol.md
 * 7): major 1 is an older Pine Computer side's; a newer one, a newer side's.
 */
function computerDocument(path: string, raw: unknown): Record<string, any> {
	return majorTwo(path, raw, schema => schema === 1
		? refuseWithUpgradeInstructions('This session\'s Pine Computer runs an older Pine Computer side, which cannot run this Studio\'s turns. A new session starts on a current one.')
		: refuseWithUpgradeInstructions('This turn\'s results are from a newer Pine Computer side, which this Studio cannot read. Update Pine Drama Studio to its newest version.', { downloadUrl: STUDIO_RELEASES_URL }));
}

/** How settling a turn went: settled, with Pine Computer's record of it, or refused, a change of another major among its changes. */
export type Settled =
	| { readonly kind: 'settled'; readonly record: PineComputerTurnRecord | undefined }
	/** Recorded settled all the same, so it is said once and never read again. */
	| { readonly kind: 'refused with upgrade instructions'; readonly refusal: RefusedWithUpgradeInstructions };

/**
 * Settles turn `turn` at its Pine turn's end, however that ended: the changes stored then are complete (doc/protocol.md
 * 4.6), and every one up to the first gap is applied (4.4). Pine Computer's record of the turn (2.4) is read before the
 * turn is recorded settled, so nothing is read after it. A change of another major refuses it, with what to use (7).
 */
export async function settleTurn(at: TurnPlace, turn: string): Promise<Settled> {
	try {
		const { files } = await applyStoredChanges(at, turn);
		const record = await readPineComputerTurnRecord(at.root, turn);
		await at.record.settle(turn, { files });
		return { kind: 'settled', record };
	} catch (error) {
		if (!(error instanceof RefusedWithUpgradeInstructions)) { throw error; }
		await at.record.settle(turn, { files: [] });
		return { kind: 'refused with upgrade instructions', refusal: error };
	}
}

