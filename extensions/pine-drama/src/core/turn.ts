// A turn on the Studio's side. Before Pine's agent runs, the drama's folder on the Computer is made the project's
// (putTurnFiles); at the turn's end, however it ended, what the agent changed there lands in the project as one commit
// (collectTurn). Both go through Pine's exec, write_file and read_file only, so nothing assumes what the agent runs.
// How the turn ended is Pine's own turn result. The Studio's record of a project's turns lives in its storage, never
// in the folder. No vscode import.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createTar, Parser as TarParser, type ReadEntry } from 'tar';
import { applyChangeToProjectFolder, validPath } from './applyChange';
import { writeWhole } from './placement';
import type { PineConnection, PinePort, PineSession } from './pinePort';
import { projectIdentity } from './projectPlace';
import { commitPathsToHistory, listFilesOfHead, runInProjectWriteQueue, sha256OfBlob } from './projectHistory';
import { DRAMA_FOLDER } from './protocol';
import { sha256 } from './sha256';

/** Every file of the drama's folder on the Computer, by its path in the project, with the SHA-256 of its bytes. */
export type Listing = Readonly<Record<string, string>>;

/** A turn as the Studio sent it: when (RFC 3339, so the strings order as the times do), from which Chat, to which session, and the drama's folder as the agent found it. */
export interface SentTurn {
	readonly turn: string;
	readonly sent: string;
	readonly chat: string;
	readonly session: string;
	readonly before: Listing;
}

/** A turn settled at its Pine turn's end, with the files that landed from it. A settled turn is never read again. */
export interface SettledTurn {
	readonly settled: string;
	readonly files: readonly string[];
}

/**
 * The Studio's record of one project's turns, under its storage: each turn as sent (`sent/<turn>.json`) and each
 * turn settled (`settled/<turn>.json`).
 */
export class TurnRecord {
	constructor(readonly dir: string) { }

	private path(kind: 'sent' | 'settled', name: string): string { return join(this.dir, kind, `${encodeURIComponent(name)}.json`); }

	private async write(kind: 'sent' | 'settled', name: string, value: unknown): Promise<void> {
		await mkdir(join(this.dir, kind), { recursive: true });
		await writeWhole(this.path(kind, name), JSON.stringify(value));
	}

	private read<T>(kind: 'sent' | 'settled', name: string): T | undefined {
		return existsSync(this.path(kind, name)) ? JSON.parse(readFileSync(this.path(kind, name), 'utf8')) as T : undefined;
	}

	sentTurn(turn: string): SentTurn | undefined { return this.read<SentTurn>('sent', turn); }

	/** Records `turn` sent, the drama's folder on the Computer listed right before the agent runs. */
	send(turn: string, chat: string, session: string, before: Listing, at = new Date()): Promise<void> {
		return this.write('sent', turn, { turn, sent: at.toISOString(), chat, session, before } satisfies SentTurn);
	}

	settled(turn: string): SettledTurn | undefined { return this.read<SettledTurn>('settled', turn); }

	/** Every turn sent from this project, oldest first. */
	turns(): SentTurn[] {
		const dir = join(this.dir, 'sent');
		return (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : [])
			.map(n => this.sentTurn(decodeURIComponent(n.slice(0, -'.json'.length)))!).sort((a, b) => a.sent.localeCompare(b.sent));
	}

	/** A Chat's latest settled turn, or undefined. */
	latestSettled(chat: string): SentTurn | undefined { return this.turns().filter(t => t.chat === chat && this.settled(t.turn)).at(-1); }

	/** A Chat's sent turns not settled yet, oldest first: a session sends its next only after its last is settled. */
	unsettled(chat: string): SentTurn[] { return this.turns().filter(t => t.chat === chat && !this.settled(t.turn)); }

	/** Records `turn` settled. */
	async settle(turn: string, settled: Omit<SettledTurn, 'settled'>): Promise<void> {
		await this.write('settled', turn, { ...settled, settled: new Date().toISOString() } satisfies SettledTurn);
	}
}

/** The turn record of the project at `root` under the Studio's protocol storage `storage`. */
export function turnRecordOf(storage: string, root: string): TurnRecord {
	return new TurnRecord(join(storage, 'projects', sha256(projectIdentity(root)).slice(0, 32)));
}

/** How a turn ended, by the protocol's names. */
export type TurnEnded = 'pine_computer_is_waiting_for_person_answer' | 'pine_computer_finished_the_work' | 'person_stopped_the_turn' | 'pine_computer_broke_off_the_turn';

/** Pine's turn state (its agent turns) as the protocol names how a turn ended, the one mapping; undefined while it runs. */
export function turnEndedAs(state: string): TurnEnded | undefined {
	switch (state) {
		case 'needs_input': return 'pine_computer_is_waiting_for_person_answer';
		case 'completed': return 'pine_computer_finished_the_work';
		case 'canceled': return 'person_stopped_the_turn';
		case 'failed': return 'pine_computer_broke_off_the_turn';
		default: return undefined;
	}
}

/** A session of Pine Computer the Studio's commands run in, and the person's Stop of the send they belong to. */
export interface ComputerSession {
	readonly port: PinePort;
	readonly env: PineConnection;
	readonly session: PineSession;
	readonly signal?: AbortSignal;
}

/** One word of a shell command, as it is written: in single quotes, which keep every character literal (POSIX Shell Command Language, 2.2.2). */
const shellWord = (text: string): string => `'${text.replaceAll('\'', '\'\\\'\'')}'`;

/**
 * Runs `command` in a subshell: each exec leaves its working directory and variables in the bash session the agent's
 * own commands run in (PineSandbox components/execd/pkg/runtime/bash_session.go:384-390), so none of the Studio's leaks.
 */
const run = (at: ComputerSession, command: string): Promise<string> => at.port.exec(at.env, at.session, `( ${command} )`, at.signal);

/** A path the drama does not hold: one with a part starting with ".", as for the project's own files (section 1). */
const hidden = (path: string): boolean => path.split('/').some(part => part.startsWith('.'));

/**
 * Every file of the drama's folder on the Computer, with its SHA-256, by one exec (find, sha256sum); hidden ones are
 * not the drama's. The folder is made first, so a new session's lists empty.
 */
export async function listComputerFiles(at: ComputerSession): Promise<Listing> {
	const out = await run(at, `mkdir -p ${DRAMA_FOLDER} && cd ${DRAMA_FOLDER} && find . -mindepth 1 -name '.*' -prune -o -type f -exec sha256sum -- {} +`);
	// "<hash>  ./<path>" per file; a name with a backslash or a line break is escaped, its line starting with "\" (GNU
	// coreutils sha256sum). Such a name is kept as printed: it is no path of the project, and collectTurn says so.
	return Object.fromEntries(out.split('\n').flatMap(line => {
		const found = /^\\?([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
		return found ? [[found[2], found[1]]] : [];
	}));
}

/** The names of the parts a put is written as: one file name each, as write_file takes (PineSandbox session-coordinator pkg/server/files.go:217-219). */
const PUT_PART = 'pine-drama-put-';
/** The most write_file takes in one file, 64 MiB (PineSandbox internal/sessionfs/attachments.go:15). */
const PART_BYTES = 64 * 1024 * 1024;

/**
 * Makes the drama's folder on the Computer hold what the tar `archive` holds, and not `remove`: the tar goes up in parts
 * under the session's attachments/, and one exec removes `remove` first, with the folders that leaves empty (as git does,
 * dir.c remove_path), so a file and a folder can change places on one path; then it extracts the parts there and
 * removes them, so the agent is never told of them.
 */
async function putFiles(at: ComputerSession, archive: string | undefined, remove: readonly string[]): Promise<void> {
	const steps: string[] = [`mkdir -p ${DRAMA_FOLDER}`];
	if (remove.length) {
		// Every folder above a removed file, deepest first, each removed only if it is left empty (GNU rmdir); one that is
		// not there (gone, or a name the listing printed escaped) is skipped, so it never stops the put.
		const folders = [...new Set(remove.flatMap(path => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))]
			.sort((a, b) => b.split('/').length - a.split('/').length);
		steps.push(`(cd ${DRAMA_FOLDER} && rm -f -- ${remove.map(shellWord).join(' ')}${folders.length ? ` && for d in ${folders.map(shellWord).join(' ')}; do if [ -d "$d" ]; then rmdir --ignore-fail-on-non-empty -- "$d"; fi; done` : ''})`);
	}
	if (archive) {
		const parts: string[] = [];
		const file = await open(archive);
		try {
			const { size } = await file.stat();
			for (let offset = 0; offset < size; offset += PART_BYTES) {
				at.signal?.throwIfAborted();
				const part = Buffer.alloc(Math.min(PART_BYTES, size - offset));
				await file.read(part, 0, part.length, offset);
				const name = `${PUT_PART}${String(parts.length + 1).padStart(4, '0')}`;
				await at.port.writeFile(at.env, at.session, name, part);
				parts.push(name);
			}
		} finally { await file.close(); }
		steps.push(`cat ${parts.map(name => `attachments/${name}`).join(' ')} | tar -xf - -C ${DRAMA_FOLDER}`, `rm -f attachments/${PUT_PART}*`);
	}
	await run(at, steps.join(' && '));
}

/** Where getFiles writes its tar: in the session's working directory, outside the drama's folder, and gone once read. */
const GET_TAR = 'pine-drama-get.tar';

/**
 * The bytes of `paths` in the drama's folder on the Computer: one exec tars them, read_file reads the tar, one more exec
 * removes it. Each file goes in whole, a hard link too, which GNU tar would otherwise store as a link to another member
 * (GNU tar manual, "--hard-dereference"); a path gone since it was listed is left out, not an error ("--ignore-failed-read").
 * The tar is the Computer's, so only the entries asked for are read: any other is returned by name in `unasked`, unread.
 */
async function getFiles(at: ComputerSession, paths: readonly string[]): Promise<{ readonly files: ReadonlyMap<string, Buffer>; readonly unasked: readonly string[] }> {
	await run(at, `cd ${DRAMA_FOLDER} && tar --hard-dereference --ignore-failed-read -cf ../${GET_TAR} -- ${paths.map(shellWord).join(' ')}`);
	const asked = new Set(paths);
	const files = new Map<string, Buffer>();
	const unasked: string[] = [];
	const parser = new TarParser({
		strict: true,
		onReadEntry: (entry: ReadEntry) => {
			if (!asked.has(entry.path) || entry.type !== 'File') {
				if (!asked.has(entry.path)) { unasked.push(entry.path); }
				entry.resume();
				return;
			}
			const chunks: Buffer[] = [];
			entry.on('data', (chunk: Buffer) => chunks.push(chunk));
			entry.on('end', () => files.set(entry.path, Buffer.concat(chunks)));
		},
	});
	const parsed = new Promise<void>((resolve, reject) => { parser.on('end', resolve); parser.on('error', reject); });
	// A web ReadableStream is async-iterable in Node 20 and later.
	for await (const chunk of await at.port.openFile(at.env, at.session, GET_TAR) as unknown as AsyncIterable<Uint8Array>) { parser.write(chunk); }
	parser.end();
	await parsed;
	await run(at, `rm -f ${GET_TAR}`);
	return { files, unasked };
}

/**
 * Turn `turn`'s files on the Computer before its agent runs: every file of the project but a hidden one put where the
 * Computer's differs, every file there the project lacks removed, and the folder listed again as the agent will find it.
 * Returns that listing.
 */
export async function putTurnFiles(at: ComputerSession, root: string, turn: string): Promise<{ readonly before: Listing; readonly put: number; readonly removed: number }> {
	const theirs = await listComputerFiles(at);
	const dir = await mkdtemp(join(tmpdir(), 'pine-drama-put-'));
	const archive = join(dir, 'put.tar');
	try {
		// One state of the project, in its write queue: the folder recorded, its files hashed and the ones to put archived
		// (node-tar, portable) before any other write lands, so a result of another session never mixes into what goes up.
		const { put, removed } = await runInProjectWriteQueue(root, async () => {
			await commitPathsToHistory(root, 'client-found-changes-on-disk', 'all', `The project as found before turn ${turn}`);
			const mine = new Map<string, string>();
			// One blob at a time, each hashed once ever (sha256OfBlob): a first send of many files never starts a process per file at once.
			for (const f of (await listFilesOfHead(root)).filter(f => !hidden(f.path))) { mine.set(f.path, await sha256OfBlob(root, f.blob)); }
			const put = [...mine].filter(([path, hash]) => theirs[path] !== hash).map(([path]) => path);
			// `./` first: node-tar reads a name that starts with @ as an archive to add (its README, tar.c).
			if (put.length) { await createTar({ cwd: root, portable: true, file: archive }, put.map(path => `./${path}`)); }
			return { put, removed: Object.keys(theirs).filter(path => !mine.has(path)) };
		});
		if (put.length || removed.length) { await putFiles(at, put.length ? archive : undefined, removed); }
		return { before: await listComputerFiles(at), put: put.length, removed: removed.length };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * What collecting a turn landed, the names on the Computer that are no paths of the project, left there, and the entries
 * of the Computer's tar that were not asked for, not read.
 */
export interface Collected {
	readonly files: readonly string[];
	readonly notPaths: readonly string[];
	readonly unasked: readonly string[];
}

/**
 * Lands what turn `turn`'s agent changed in the drama's folder on the Computer, at its Pine turn's end however it ended:
 * the folder listed now against `before`, the files that differ read and landed, with the paths gone deleted, as one
 * `pine-computer` commit with the turn's trailer. Landing it again is a no-op (applyChangeToProjectFolder).
 */
export async function collectTurn(at: ComputerSession, root: string, turn: string, before: Listing): Promise<Collected> {
	const after = await listComputerFiles(at);
	const changed = Object.keys(after).filter(path => before[path] !== after[path]);
	const gone = Object.keys(before).filter(path => !Object.hasOwn(after, path));
	const read = changed.filter(validPath);
	const { files: bytes, unasked } = read.length ? await getFiles(at, read) : { files: new Map<string, Buffer>(), unasked: [] };
	const byHash = new Map([...bytes.values()].map(b => [sha256(b), b]));
	// Each file as read, by the hash of its bytes: the listing only finds what changed.
	const filesAfterChange = Object.fromEntries([...[...bytes].map(([path, b]) => [path, sha256(b)] as const), ...gone.filter(validPath).map(path => [path, null] as const)]);
	const notPaths = changed.filter(path => !validPath(path));
	if (!Object.keys(filesAfterChange).length) { return { files: [], notPaths, unasked }; }
	await applyChangeToProjectFolder(root, { filesAfterChange, author: 'pine-computer', commitMessage: `Turn ${turn}`, turnId: turn }, async hash => byHash.get(hash)!);
	return { files: Object.keys(filesAfterChange), notPaths, unasked };
}
