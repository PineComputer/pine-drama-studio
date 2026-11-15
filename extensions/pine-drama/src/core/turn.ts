// A turn on the Studio's side, with git on both sides. Before Pine's agent runs, the drama's folder on the Computer is
// made the project's: a snapshot commit of HEAD goes up as a bundle and is checked out there (putTurnFiles). At the
// turn's end, however it ended, what the agent changed is committed there, comes back as a bundle, and its changed paths
// land in the project as one commit (collectTurn). Everything goes through Pine's exec, write_file and read_file, so
// nothing assumes what the agent runs; the git on the Computer is the harness's, not the agent's. How the turn ended is
// Pine's own turn result. The Studio's record of a project's turns lives in its storage, never in the folder. No vscode
// import.

import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { landTurnFiles, type LeftOut } from './applyChange';
import { writeWhole } from './placement';
import type { PineConnection, PinePort, PineSession } from './pinePort';
import { projectIdentity } from './projectPlace';
import { bundleRef, commitEntriesToHistory, commitIndexPaths, commitSnapshotOfIndex, fetchBundle, readRef, recordFilesFoundOnDisk, runInProjectWriteQueue, treeChanges, type PineTurnIds } from './projectHistory';
import { DRAMA_FOLDER } from './protocol';
import { sha256 } from './sha256';

/** A turn as the Studio sent it: when (RFC 3339, so the strings order as the times do), from which Chat, to which session. */
export interface SentTurn {
	readonly turn: string;
	readonly sent: string;
	readonly chat: string;
	readonly session: string;
}

/** A turn settled at its Pine turn's end, with the files that landed from it. */
export interface SettledTurn {
	readonly files: readonly string[];
}

/**
 * The Studio's record of one project's turns, under its storage: each turn as sent (`sent/<turn>.json`) and each turn
 * settled (`settled/<turn>.json`), the one record that a turn's collection is done. That its result landed is git's
 * own record: the commit with its Pine-Turn-Id trailer.
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

	/** Records `turn` sent, to `session`, once its files are on the Computer. */
	send(turn: string, chat: string, session: string): Promise<void> {
		return this.write('sent', turn, { turn, sent: new Date().toISOString(), chat, session } satisfies SentTurn);
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
	settle(turn: string, settled: SettledTurn): Promise<void> { return this.write('settled', turn, settled); }
}

/** The turn record of the project at `root` under the Studio's protocol storage `storage`. */
export function turnRecordOf(storage: string, root: string): TurnRecord {
	return new TurnRecord(join(storage, 'projects', sha256(projectIdentity(root)).slice(0, 32)));
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
 * Runs `command` in a subshell, so no directory or variable of it stays in the session's shell (PineSandbox
 * components/execd/pkg/runtime/bash_session.go:384-390).
 */
const run = (at: ComputerSession, command: string): Promise<string> => at.port.exec(at.env, at.session, `( ${command} )`, at.signal);

/** The harness's repository on the Computer: beside the drama's folder in the session's working directory, never in it. */
const GIT_DIR = 'pine-drama.git';

/**
 * Git on the Computer, the same whatever the Computer's own setup: no global or system config, no hooks, no line-ending
 * conversion, and the drama's folder as its work tree (git, --git-dir and --work-tree).
 */
const GIT = `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git --git-dir=${GIT_DIR} --work-tree=${DRAMA_FOLDER} -c core.hooksPath=/dev/null -c core.autocrlf=false`;

/** The harness's repository made once per session; no file is converted on its way in or out (info/attributes, the project's own byte rule). */
const INIT = `mkdir -p ${DRAMA_FOLDER} && { [ -d ${GIT_DIR} ] || { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git init -q --bare ${GIT_DIR}`
	+ ` && printf '* -text -filter -ident -working-tree-encoding\\n' > ${GIT_DIR}/info/attributes; }; }`;

/**
 * Every path of the drama's folder but those with a part starting with ".", which are not the drama's (section 1): the
 * agent's own .gitignore files decide nothing, so `add` and `clean` take this pathspec with --force (git, pathspec magic).
 */
const DRAMA_PATHS = `-- . ':(exclude,glob)**/.*' ':(exclude,glob)**/.*/**'`;

/** The names of the parts a put is written as: one file name each, as write_file takes (PineSandbox session-coordinator pkg/server/files.go:217-219). */
const PUT_PART = 'pine-drama-put-';
/** The most write_file takes in one file, 64 MiB (PineSandbox internal/sessionfs/attachments.go:15). */
const PART_BYTES = 64 * 1024 * 1024;
/** The bundles that go up and come back, in the session's working directory, outside the drama's folder, and gone once read. */
const PUT_BUNDLE = 'pine-drama-put.bundle';
const GET_BUNDLE = 'pine-drama-get.bundle';

/**
 * The project's refs for a session (one name per session, from its own): `acked`, the last commit both sides hold;
 * `put`, the snapshot going up; `result`, the last capture fetched back. Refs outside refs/heads, so no branch shows them.
 */
function sessionRefs(session: string): { readonly acked: string; readonly put: string; readonly result: string } {
	const key = sha256(session).slice(0, 16);
	return { acked: `refs/pine-drama/sessions/${key}`, put: `refs/pine-drama/put/${key}`, result: `refs/pine-drama/result/${key}` };
}

/**
 * Turn `turn`'s files on the Computer before its agent runs. In the project's write queue, the folder is recorded, and
 * the index's files, a running turn's staged results included (no hidden ones, no links), are made a snapshot commit and bundled: a child of the session's acknowledged
 * commit when the Computer still holds it (git cat-file -e), so only what it lacks goes up, else a commit with no
 * parent, so no history goes up. The bundle goes up in parts, and one exec fetches it, checks it out in the drama's
 * folder (git read-tree --reset -u) and removes every other file there (git clean), so the folder holds exactly the
 * snapshot, also where the harness's repository was made again; names starting with "." stay.
 */
export async function putTurnFiles(at: ComputerSession, root: string, turn: string): Promise<{ readonly seed: string }> {
	const refs = sessionRefs(at.session.name);
	const acked = await readRef(root, refs.acked);
	const held = acked !== null && (await run(at, `[ -d ${GIT_DIR} ] && ${GIT} cat-file -e ${acked}^{commit} && echo held || true`)).trim() === 'held';
	const dir = await mkdtemp(join(tmpdir(), 'pine-drama-put-'));
	const bundle = join(dir, 'put.bundle');
	try {
		const seed = await runInProjectWriteQueue(root, async () => {
			await recordFilesFoundOnDisk(root, `The project as found before turn ${turn}`);
			const seed = await commitSnapshotOfIndex(root, refs.put, held ? acked : null, `The project as turn ${turn} starts`);
			await bundleRef(root, bundle, refs.put, held ? acked : null);
			return seed;
		});
		const parts: string[] = [];
		const file = await open(bundle);
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
		await run(at, [INIT, `cat ${parts.map(name => `attachments/${name}`).join(' ')} > ${PUT_BUNDLE}`, `rm -f attachments/${PUT_PART}*`,
			`${GIT} fetch -q --no-tags ${PUT_BUNDLE} +${refs.put}:refs/studio`, `${GIT} read-tree --reset -u refs/studio`, `${GIT} clean -ffdxq ${DRAMA_PATHS}`, `rm -f ${PUT_BUNDLE}`].join(' && '));
		await runInProjectWriteQueue(root, () => commitEntriesToHistory(root, 'person', [], '', {}, { [refs.acked]: seed, [refs.result]: seed }));
		return { seed };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** What collecting a turn landed, and the paths of its result left out of the project, each with why. */
export interface Collected {
	readonly files: readonly string[];
	readonly leftOut: ReadonlyMap<string, LeftOut>;
}

/**
 * Collects what Pine's turn `ids` agent has changed in the drama's folder on the Computer: while the turn runs (`last`
 * false), on a timer, and once at its Pine turn's end however it ended (`last` true), which is the last word.
 *
 * One exec stages the folder (git add -A --force, names starting with "." left out) and, when its tree differs from the
 * turn's last capture (`result`; the put's snapshot before any), commits it as that capture's child and bundles only
 * that commit; an unchanged tree makes no commit and no bundle. The bundle is read back and fetched as the new last
 * capture, and the folder takes what changed (applyChange.ts landTurnFiles): since the last capture while the turn
 * runs, staged with no commit; since the acknowledged commit at its end, in the turn's one commit, the acknowledged
 * commit moving with it. Collecting again is a no-op.
 */
export async function collectTurn(at: ComputerSession, root: string, ids: PineTurnIds, { last }: { readonly last: boolean }): Promise<Collected> {
	const refs = sessionRefs(at.session.name);
	const acked = await readRef(root, refs.acked);
	if (!acked) { throw new Error(`the Studio holds no commit of session ${at.session.name}, so its turn cannot be compared`); }
	const base = (await readRef(root, refs.result)) ?? acked;
	const said = await run(at, [`${GIT} add -A --force ${DRAMA_PATHS}`, `t=$(${GIT} write-tree)`,
		`if [ "$t" = "$(${GIT} rev-parse ${base}^{tree})" ]; then echo unchanged; else c=$(${GIT} -c user.name=pine-computer -c user.email=pine-computer@pine-drama.invalid commit-tree "$t" -p ${base} -m ${shellWord(`Turn ${ids.turn}`)})`
		+ ` && ${GIT} update-ref refs/heads/turn "$c" && ${GIT} bundle create ${GET_BUNDLE} refs/heads/turn ^${base} && echo captured; fi`].join(' && '));
	const to = said.trim().split('\n').at(-1) === 'unchanged' ? base : await fetchCapture(at, root, refs.result);
	if (!last && to === base) { return { files: [], leftOut: new Map() }; }
	// At the end, also what changed since the last capture, so a file the turn wrote and then removed or restored is
	// brought to the end too, though the turn changed it from the acknowledged commit in the end not at all.
	const since = await treeChanges(root, base, to);
	const turnPaths = last ? await treeChanges(root, acked, to) : [];
	const entries = [...turnPaths, ...since.filter(e => !turnPaths.some(t => t.path === e.path))];
	const { landed, leftOut } = await landTurnFiles(root, ids, entries, last, last ? { [refs.acked]: to } : {});
	return { files: landed, leftOut };
}

/** The capture the Computer bundled, read back by read_file and fetched into `into`; returns its commit. */
async function fetchCapture(at: ComputerSession, root: string, into: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'pine-drama-get-'));
	const bundle = join(dir, 'get.bundle');
	try {
		const stream = await at.port.openFile(at.env, at.session, GET_BUNDLE);
		await pipeline(Readable.fromWeb(stream as WebReadableStream<Uint8Array>), createWriteStream(bundle));
		await run(at, `rm -f ${GET_BUNDLE}`);
		return await runInProjectWriteQueue(root, () => fetchBundle(root, bundle, 'refs/heads/turn', into));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * A session Pine no longer has took its files with it, and its turn has no end to collect: what that turn staged in the
 * folder is committed as found on disk, so no running turn holds it any more.
 */
export async function forgetCaptures(root: string, session: string): Promise<void> {
	const refs = sessionRefs(session);
	const acked = await readRef(root, refs.acked);
	const captured = await readRef(root, refs.result);
	if (!acked || !captured || acked === captured) { return; }
	await runInProjectWriteQueue(root, async () => commitIndexPaths(root, 'client-found-changes-on-disk', (await treeChanges(root, acked, captured)).map(e => e.path),
		'What a turn wrote before its session ended', {}, { [refs.result]: acked }));
}
