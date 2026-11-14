import { REVIEW_APPROVAL_STATEMENT } from './reviewCardProtocol';
// Chats with Pine Computer agents that survive restarts and several windows.
// The rules this file keeps:
// 1. Credentials are saved, and read back, before a Computer is created; a Computer whose
//    credentials are missing is reported, never silently replaced.
// 2. Secrets are fenced like database writes: each save goes to a new vault entry, which only a
//    write of the current Pine session generation makes current (`secret_gen`); a pass of a replaced session publishes nothing.
// 3. Every send is saved (target, text, kind) before it is sent and recovered by its kind's
//    contract: run is resent with the same key; answer only while its question still waits, and
//    an answer that arrived is followed to its successor. While an earlier
//    send's outcome is unknown, no later message is sent. A message means what it meant when the person sent it: if
//    recovery moves the Chat on (a new question, a finished turn), it is not sent.
// 4. An event is applied once: its dedupe mark, its messages and the last applied event id move in one
//    transaction, and the last applied event id never moves back. A turn has one cost record: snapshots replace
//    it until the final cost settles it. An event without a turn id is never attributed to a turn.
// 5. One window drives a project's Chats (the project window lock). Writes and remote calls carry the Chat's Pine
//    session generation (core/pineSessionGeneration.ts): a pass of a session that was since replaced cannot write.
// 6. "Reconnected" means the remote session and its Task matched; a session found gone at any
//    point ends, keeps its history and waits for the person before a new session starts.
// 7. No cancellation in v1: nothing here cancels or steers a turn on Pine. A message that arrives while a turn runs
//    waits for it and then goes as the answer or a new run; a reply whose view goes away is still followed to its end,
//    and the history shows how it ended.
// 8. When a turn ends, its returned files are settled into the library (core/settle.ts) under the same generation;
//    a settle that fails is logged and shown, and is taken up again at the next send or follow.
// 9. Files the person attaches wait in the library and go up with the Chat's next run, once each; the Studio's
//    note about them is recorded as the Studio's text (core/uplink.ts).
// No vscode import.

import { CHANGED_TARGET_NOTE, standingParagraph, withStandingInstructions } from './instructions';
import { createHash, randomUUID } from 'node:crypto';
import { AccountError, ConnectionLostError, IDLE_WAITING_SECONDS, IDLE_WORKING_SECONDS, MissingError, NoPineError, OtherPineError, START_WAIT_SECONDS, StartNotConfirmedError, StartTimeoutError, UnconfirmedError, endpointHost, type ComputerSecrets, type IdlePolicy, type PineConnection, type PineEvent, type PinePort, type SecretVault, type PineSession, type TurnView } from './pinePort';
import { Library } from './library';
import { hashFile, projectIdentity, projectPlaceOf, projectRootOf } from './projectPlace';
import { entryFor, type Entry } from './binding';
import { givenBack, refusalLine } from './refusal';
import { Holders, keptBytes, putAll, requestKey, returnKey, sha256 } from './taskArtifacts';
import { dramaRecordOf, installedSnapshots, requestKeys, requestOf, taskMessage, type DramaRecord } from './taskRun';
import { installReturn, previewProgress, readReturn, type ReviewTarget } from './resultImporter';
import { UnsupportedMajor, type Return } from './protocol';
import { copyImport, readChoices, updateChoices, withObject, writeWhole } from './choices';
import { resolveReturned, type ResolveSources, type Resolved } from './resolve';
import { localProjectFile } from './chatLinks';
import { within, type ProjectPlace } from './placement';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { withoutRepeatedQuestion } from './askedOnce';
import { answerFor, asks, complete, decisionRun, itemComplete, reviewKindOf, itemHere, subjectOf, viewOf, type ReviewFile, type ReviewItem, type ReviewView, type Verdict } from './reviews';
import { snapshotState, versionTitle } from './project';
import { EXTRACTED, extractText, textName, type Extraction } from './extract';
import { PineSessionGenerations, PineSessionReplacedError } from './pineSessionGeneration';
import { type Chat, type Message, type SavedSend, type SavedSendKind, type Store } from './store';

export type Update =
	| { kind: 'progress'; text: string }
	/** One step of the agent's work; later updates with the same id are the same step (chat-progress.md, option B). */
	| { kind: 'activity'; id: string; text: string; state: string }
	| { kind: 'markdown'; text: string; question?: boolean }
	/** A message the Studio did not send, given back as typed (D72): drawn as it is, never through the agent's link rewriting. */
	| { kind: 'unsent'; text: string }
	/** An unsent Chat answer has an explicit local Review destination, not an inferred approval. */
	| { kind: 'reviewRequired'; text: string; reviewId: string }
	/** The cost line of a turn that ended; the cost itself is saved either way, only showing the line is optional. */
	| { kind: 'usage'; text: string }
	/** A stop that asks the person to decide: its items, with the folder their files are in. */
	| { kind: 'review'; review: ReviewView; folder: string | undefined; text: string }
	/** The session ended; the person decides whether a new one starts. */
	| { kind: 'sessionEnded'; text: string }
	/** A result that is not used: one native warning with its reason, its detail in Output (D43). */
	| { kind: 'unused'; text: string }
	/** The Computer did not start in time; `text` says what was observed. A send gives its message back (unsentLine). */
	| { kind: 'notStarted'; text: string }
	/** Pine could not be reached for the follow's whole limit: the line offers Reload Window, which attaches again. */
	| { kind: 'unreachable'; text: string };

/** A review's card in a stream, and its line in a log. */
/** What a follower brings to collect at a turn's end (streamPineTurnEvents): the turns it followed, and how the last one ended. */
interface TurnEnd {
	readonly session: PineSession;
	readonly turns: readonly TurnView[];
	readonly ending: readonly Update[];
	/** Whether each turn was settled before the follower waited in the line (importTurnResultsIntoProjectFolder's first check). */
	readonly followUpDoneBefore: ReadonlyMap<string, boolean>;
}

function reviewUpdate(opened: { review: ReviewView; folder: string | undefined }): Extract<Update, { kind: 'review' }> {
	return { kind: 'review', ...opened, text: `\n\n**To review (${opened.review.items.length}):** ${opened.review.items.map(item => item.label).join(', ')}` };
}

/** What became of a request to stop one session's Computer. */
/** A decision is recorded only for the exact bytes the review was prepared with. */
function filesChanged(paths: readonly string[], tail: string): string {
	return `Review files are missing, inaccessible or changed after this review was prepared: ${paths.join(', ')}. ${tail}`;
}

export class BusyElsewhereError extends Error {
	readonly name = 'BusyElsewhereError';
}

/** A message that arrives while a turn runs waits for it. */
const WAITING = '_Pine Computer is still running this turn; your message will be sent when it finishes._';

/** The pause between two polls of a running task's progress (doc/protocol.md, 4.6), as the live reads it replaces polled. */
const PREVIEW_POLL_MS = 2_000;

/** A picture the person adds goes to imports/ (placeFiles): the image types the Studio shows. */
const PICTURE = /\.(png|jpe?g|webp)$/i;

/** What the person is told when a task's turn ends with no return (doc/protocol.md, 4.5): only they decide on running it again. */
const NO_RETURN = 'This task brought nothing back: its run was cut off before it returned, and it may have spent money. Nothing is run again by itself; to make the work again, ask for it in a new message.';

export interface ChatServiceOptions {
	/** New admissions stop when saved credentials change; in-flight work keeps its connection snapshot. */
	connectionCurrent?: () => boolean;
	store: Store;
	port: PinePort;
	vault: SecretVault;
	/** The one Pine the file names; undefined when it names none (pineConfig.ts), and then nothing is sent. */
	pine: PineConnection | undefined;
	/**
	 * Whether this window holds the lock of the project at `root` (core/projectWindowLock.ts). A window drives, collects,
	 * imports and records Review only for a Chat of the project it holds; a Chat of another project is left to the window
	 * that holds that project, and a window that holds none drives no bound Chat.
	 */
	holdsProject(root: string): boolean;
	log?: (line: string) => void;
	onChange?: (key: string) => void;
	/**
	 * Where the files a turn returns are kept. Without it nothing is settled, as in the
	 * tests that are not about files; the extension always gives it.
	 */
	files?: {
		/** The library's bytes, by SHA-256 (the extension's global storage). */
		libraryRoot: string;
		/** Each Chat's project folder is made under it. */
		projectsRoot: string;
	};
	/** A part of a packed project, in bytes; 60 MiB (main's `split -b 60m`) unless a test makes it small. */
	/**
	 * The protocol client (doc/protocol.md): each run or answer is a task. `storage` holds the Studio's copies of archives
	 * and files (`kept/`) and each drama's record (`dramas/`, taskRun.ts), outside the drama's folder.
	 */
	protocol?: { readonly storage: string };
	/** The pause between two polls of a running task's progress (doc/protocol.md, 4.6); PREVIEW_POLL_MS unless a test makes it short. */
	previewPollMs?: number;
	/**
	 * How long the event stream stays open once a turn has ended, for the events Pine sends after the turn reads ended;
	 * TURN_END_GRACE_MS unless a test, whose fake Pine has sent them all by then, makes it 0.
	 */
	turnEndGraceMs?: number;
	/** The pauses before each new attempt to reach a followed turn (RECONNECT_WAITS_MS unless a test makes them short). */
	reconnectWaitsMs?: readonly number[];
	/** How long a follower keeps trying to reach Pine (RECONNECT_LIMIT_MS unless a test makes it short). */
	reconnectLimitMs?: number;
}

type SendResult = { kind: 'sent'; turn: TurnView } | { kind: 'unknown' } | { kind: 'failed' } | { kind: 'ended' };

const LABEL = 'pine-drama-studio';
/**
 * The `env` column of a new Chat. It held an environment's name until 2026-11-02; with one Pine it is a code name
 * only, shown nowhere: a session is matched by its stored endpoint.
 */
const PINE_ENV = 'pine';
/** How long one wait for a turn's end lasts before the generation is checked and the wait repeats. */
const TURN_WAIT_MS = 10_000;
/** The event stream's time to deliver what it has left once a turn has ended (since M0). */
const TURN_END_GRACE_MS = 500;
/**
 * A follower that lost Pine tries again after these pauses, the last one repeating: VS Code's own reconnection schedule
 * for a lost remote, in seconds [0, 5, 5, 10, 10, 10, 10, 10, 30] (src/vs/platform/remote/common/remoteAgentConnection.ts:660
 * at the pinned 235ceeb5).
 */
const RECONNECT_WAITS_MS = [0, 5, 5, 10, 10, 10, 10, 10, 30].map(seconds => seconds * 1000);
/** How long it keeps trying: VS Code's ReconnectionGraceTime, 3 hours (src/vs/base/parts/ipc/common/ipc.net.ts:304). */
const RECONNECT_LIMIT_MS = 3 * 60 * 60 * 1000;

/** A moment as a chat line states it: UTC to the second, "04:59:29Z", as the Output channel's times are. */
function utcTime(at: Date): string {
	return `${at.toISOString().slice(11, 19)}Z`;
}

/** A reference the person added in the chat input, as the glue reads it (pineSessions.ts). */
export type ChatFile = { kind: 'file'; path: string } | { kind: 'other'; name: string; why: string };

/** What Pine said of one Computer the developer Stop All asked it to stop; `gone`: Pine no longer knows it. */
/**
 * One Computer of Stop All: `pine`, the state Pine reported before any stop (null when Pine has no record of it or could
 * not be read); `ended`, Pine reported it shut down (shutDown), so it was not asked to stop; `gone`, Pine has no record.
 * Every other state is still up (running, starting, saving, stopping…) and is asked to stop.
 */
export interface StopAsked { key: string; computerId: string | null; pine: string | null; outcome: 'confirmed' | 'gone' | 'ended' | 'unconfirmed' | 'failed'; detail?: string }

/** What Stop All did, in one line from Pine's answers: "Pine still had 3 up and stopped 3; 15 recorded here had already ended." */
export function stopAllSummary(asked: readonly StopAsked[]): string {
	const up = asked.filter(a => a.pine !== null && a.outcome !== 'ended');
	const stopped = up.filter(a => a.outcome === 'confirmed' || a.outcome === 'gone').length;
	const ended = asked.filter(a => a.outcome === 'ended' || (a.outcome === 'gone' && a.pine === null)).length;
	const notConfirmed = up.length - stopped;
	const unread = asked.filter(a => a.pine === null && a.outcome === 'failed').length;
	return `Pine still had ${up.length} up and stopped ${stopped}${notConfirmed ? ` (${notConfirmed} not confirmed)` : ''}; ${ended} recorded here had already ended`
		+ `${unread ? `; ${unread} could not be read from Pine` : ''}.`;
}

/**
 * Whether a Computer state read (ChatService.computerState) confirms the Computer has shut down: `stopped`, which a
 * NotFound reads as, or `terminated`, the state a completed Stop leaves (SDK computer-ts-v0.3.5 sandboxHandle.stop
 * resolves true on NotFoundError or terminated/COMPUTE_RELEASED). `saving`, `stopping` and `pending` are on the way and
 * prove nothing: a task there could still save its result, so nothing is settled lost from them.
 */
function shutDown(state: string): boolean {
	return state === 'stopped' || state === 'terminated';
}

export class ChatService {
	private readonly executions = new Map<string, Promise<void>>();

	/** Serialize local explicit sends/restarts; one window drives a project's Chats. */
	private async queueExecution(key: string): Promise<() => void> {
		const previous = this.executions.get(key);
		let resolve!: () => void;
		const next = new Promise<void>(done => { resolve = done; });
		this.executions.set(key, next);
		await previous;
		return () => { if (this.executions.get(key) === next) { this.executions.delete(key); } resolve(); };
	}
	private readonly store: Store;
	private readonly port: PinePort;
	private readonly vault: SecretVault;
	private readonly log: (line: string) => void;
	private readonly generations = new PineSessionGenerations();
	private readonly library: Library | undefined;
	/** The publication pass this window runs now for each Chat, ended when it settles (collect). */
	private readonly settling = new Map<string, Promise<void>>();
	/** Chats whose remote session this process has verified. */
	private readonly verified = new Set<string>();
	/** The idle timeout last applied to each Chat's Computer by this window; a restart asks again. */
	private readonly idleApplied = new Map<string, number>();
	/** The idle-timeout policy of the Pine project, by endpoint, read once (open-pinedrama `limits`). */
	private readonly idlePolicies = new Map<string, Promise<IdlePolicy>>();
	private readonly localSubmissions = new Map<string, Promise<string>>();
	private readonly reviewContinuations = new Set<string>();
	/** By project: the local writer's line (inProjectWriter). */
	private readonly projectWriters = new Map<string, Promise<void>>();

	constructor(private readonly options: ChatServiceOptions) {
		this.store = options.store;
		this.port = options.port;
		this.vault = options.vault;
		this.log = options.log ?? (() => undefined);
		const files = options.files;
		this.library = files && new Library(this.store, files.libraryRoot);
	}

	/**
	 * `steps`' updates before the message reaches Pine. A session Pine reports ended there is not said: the
	 * send notes it in `ending` and starts the agent again itself (submitOnce, replacePineSessionAndSend). A start that timed out gives
	 * the message back in its line (unsentLine).
	 */
	private async *untilEnded<T>(steps: AsyncGenerator<Update, T>, text: string, files: readonly ChatFile[], ending: Ending): AsyncGenerator<Update, T> {
		for (; ;) {
			const next = await steps.next();
			if (next.done) {
				return next.value;
			}
			if (next.value.kind === 'notStarted') {
				yield unsentLine(text, files, next.value.text);
				continue;
			}
			if (next.value.kind === 'sessionEnded') {
				ending.said = true;
				continue;
			}
			yield next.value;
		}
	}

	/** The paths (`drama/…`) of the version folders the Chat's latest installed return brought (taskRun.ts, DramaRecord.latest). */
	latestTurnFiles(key: string): string[] {
		const root = this.projectRoot(key);
		const latest = this.options.protocol && root ? this.dramaRecord(root).latest(key) : undefined;
		return Object.keys(latest?.versions ?? {}).map(folder => `drama/${folder}`);
	}

	history(key: string): Message[] {
		return this.store.messages(key);
	}

	chat(key: string): Chat | undefined {
		return this.store.chat(key);
	}

	chats(): Chat[] {
		return this.store.chats();
	}

	/** Whether a message in session `key` may go from a window with this one folder (core/binding.ts). */
	entry(key: string, folder: string): Entry {
		const projectsRoot = this.options.files?.projectsRoot;
		const chats = this.store.chats();
		// The existing no-files core mode has no project binding; an explicit association always fences it.
		if (!projectsRoot && !chats.some(c => c.folder && (c.key === key || projectIdentity(c.folder) === projectIdentity(folder)))) {
			return { kind: 'go', bind: false };
		}
		return entryFor(chats, projectsRoot ?? '', key, folder);
	}

	/**
	 * Sends the person's message: a run, or the answer to a waiting question. `folder` is the window's one folder: the
	 * first message binds a new session to it. Nothing the person does stops
	 * its work: a reply whose view goes away is still followed to its end, and the history shows how it ended.
	 */
	submit(key: string, text: string, label: string, folder?: string): AsyncGenerator<Update> {
		return this.submitOnce(key, text, label, folder);
	}

	private async *submitOnce(key: string, text: string, label: string, folder: string | undefined, files: readonly ChatFile[] = []): AsyncGenerator<Update> {
		// Capture the question/turn before waiting in the local send queue; a preceding reply may ask a new question.
		const atSend = this.store.chat(key);
		const intendedAtSend = atSend ? intent(atSend) : { kind: 'run' as const, target: null };
		const recorded = this.store.submittedReviewForAnswer(key, text);
		if (recorded && (recorded.state !== 'open' || this.reviewContinuations.has(recorded.id))) {
			yield { kind: 'markdown', text: '_This review was already submitted for continuation. No additional task was started._' };
			return;
		}
		const release = await this.queueExecution(key);
		try {
			const currentReview = this.store.submittedReviewForAnswer(key, text);
			if (currentReview && currentReview.state !== 'open') {
				yield { kind: 'markdown', text: '_This review was already submitted for continuation. No additional task was started._' };
				return;
			}
			if (recorded) { this.reviewContinuations.add(recorded.id); }
			// A restart while this message waited (a preceding send's item g) ended every question and turn it could be
			// for, with their session. It goes as the restarting message does, against what the new session starts from
			// (replacePineSessionAndSend), and is held to it: a question the new session asks meanwhile is not what it answers.
			const restarted = (this.store.chat(key)?.pine_session_name ?? null) !== (atSend?.pine_session_name ?? null);
			const ending: Ending = { said: false };
			// A message is never lost on the way: one that was neither recorded as a send (ending.op) nor given back
			// already is given back when the send ends, whichever way it ends.
			const shown = { given: false };
			try {
				yield* givingBack(this.sendPersonMessageToPine(key, text, label, folder, restarted ? { kind: 'run', target: null } : intendedAtSend, files, ending), shown);
				if (ending.said) {
					// The session ended on Pine's evidence before the message reached it. Sending is the person's
					// explicit action, so the Studio starts the agent again and sends the same message there, in this send (the
					// person, 2026-11-05): no "not sent" line.
					yield* givingBack(this.replacePineSessionAndSend(key, text, label, folder, files, ending), shown);
				}
			} catch (error) {
				if (!ending.op && !shown.given) { yield unsentLine(text, files, (error as Error).message.replace(/[.\s]+$/, '')); }
				// A Pine account problem is said in that one line, which tells the person where to fix it; nothing is retried.
				if (error instanceof AccountError) { this.log(`${key}: ${error.problem}: ${error.message}`); return; }
				throw error;
			}
			if (!ending.op && !shown.given) { yield unsentLine(text, files, 'the line above says why'); }
		} finally {
			if (recorded) { this.reviewContinuations.delete(recorded.id); }
			release();
		}
	}

	/**
	 * `resends` is the operation of this same message that a session's end kept from reaching Pine (replacePineSessionAndSend): the
	 * person's words and decision recorded with it become this operation's, so the Chat shows one message, sent once.
	 * `changedBefore` says that what it was written for changed before that end, so its note goes with it here too.
	 */
	private async *sendPersonMessageToPine(key: string, text: string, label: string, folder: string | undefined, intendedAtSend: ReturnType<typeof intent>, files: readonly ChatFile[], ending: Ending, resends?: string, changedBefore = false): AsyncGenerator<Update> {
		if (this.options.connectionCurrent?.() === false) { throw new Error('The Pine connection changed. Reload the window before sending more work.'); }
		let conv = this.store.chat(key);
		const env = conv ? this.pineOf(conv) : this.thePine();
		const epoch = this.pineSessionGeneration(key);
		let intended = intendedAtSend;
		const now = conv ? intent(conv) : { kind: 'run' as const, target: null };
		// A queued input may follow the exact running turn it observed. When what it was written for changed meanwhile (a
		// preceding send moved the Chat on), it is still sent, as a new message to what the session is now, with a note
		// to the agent and a line to the person (audit item 12, approved 2026-11-11): never held back.
		// `ending.changed` carries it to the send a session's end starts again (replacePineSessionAndSend).
		let changed = changedBefore;
		if (!(intended.kind === 'busy' && conv?.current_turn_id === intended.target)
			&& (now.kind !== intended.kind || now.target !== intended.target)) {
			changed = true;
			intended = now;
		}
		ending.changed = changed;
		// Checked again here, as the window's check and this send are not one step (another window may have bound the folder).
		const project = folder ?? conv?.folder ?? undefined;
		const entry = project ? this.entry(key, project) : undefined;
		if (entry && entry.kind !== 'go' && entry.kind !== 'adopt') {
			// One line, and the message given back under it.
			yield { kind: 'unsent', text: `_${refusalLine(entry.kind === 'moved' ? { kind: 'rootChanged' } : entry)} Your message is below, to send again._\n\n${givenBack(text, attachedNames(files))}` };
			return;
		}
		if (!conv) {
			this.store.tx(() => this.store.insertChat({ key, env: PINE_ENV, endpoint: env.endpoint, label, secret_ref: secretRef(key) }));
		}
		if (entry?.kind === 'adopt') {
			try {
				this.store.admitExistingProject(key, entry.folder);
				this.changed(key);
			} catch (error) {
				if (error instanceof PineSessionReplacedError) { throw error; }
				const detail = (error as Error).message;
				this.log(`${key}: project ${entry.folder}: continuation refused: ${detail}`);
				yield unsentLine(text, files, 'the existing project could not be admitted');
				yield { kind: 'markdown', text: `**Project continuation was not started:** ${detail}` };
				return;
			}
		}
		if (folder && entry?.kind === 'go' && entry.bind) {
			if (!this.store.bindFolder(key, folder)) {
				yield unsentLine(text, files, 'the session it was for has ended');
				yield { kind: 'markdown', text: '_Not sent: this folder changed or was bound in another window; reopen the project and retry._' };
				return;
			}
			this.log(`${key}: bound to ${folder}`);
			this.changed(key);
			if (entry.note) {
				yield { kind: 'markdown', text: `_${entry.note}_\n\n` };
			}
		} else if (!conv) {
			// Notify only after any first-send project admission; scoped UI refresh is synchronous.
			this.changed(key);
		}
		const placedAttachments = yield* this.stageMessageFiles(key, files);
		// Until the message reaches Pine, a session found ended is noted in `ending`; the send then starts the agent again
		// and sends the message there (submitOnce). A message queued behind the reply that found the loss comes here too.
		const unsent = <T>(steps: AsyncGenerator<Update, T>) => this.untilEnded(steps, text, files, ending);
		const session = yield* unsent(this.ensureLivePineSession(key, env, epoch));
		if (!session) {
			return;
		}
		yield* this.collectResultsFromPine(key, env, epoch);
		if (!(yield* unsent(this.checkUnconfirmedSendsWithPine(key, env, epoch, session)))) {
			yield unsentLine(text, files, 'an earlier message is still unconfirmed by Pine, and this one would overtake it');
			return;
		}

		conv = this.store.chat(key)!;
		if (conv.pine_session_state !== 'open') {
			ending.said = true;
			return;
		}
		if (intended.kind === 'busy' && intent(conv).kind === 'busy' && conv.current_turn_id === intended.target) {
			// Nothing cancels or steers a running turn: the message waits for it, followed as any turn is, and then goes
			// as what it is at that moment, the answer to the question it ended on or a new run. A turn whose Computer Pine says
			// is gone is not waited for: the follow below ends the session, and the message goes to the agent started again
			// (`ending`), never queued behind a turn that cannot end.
			let gone = false;
			try {
				await this.held(key, epoch, () => this.port.turn(env, session, intended.target!, 0));
			} catch (error) {
				if (!(error instanceof MissingError || error instanceof ConnectionLostError)) {
					throw error;
				}
				gone = error instanceof MissingError;
			}
			if (!gone) {
				yield { kind: 'markdown', text: WAITING };
			}
			yield* unsent(this.streamPineTurnEvents(key, env, epoch, session));
			conv = this.store.chat(key)!;
			if (conv.pine_session_state !== 'open') {
				return;
			}
		}
		// The queued send may begin after its observed turn has already completed, so resolution belongs here
		// too, not only inside streamPineTurnEvents. Never resolve it against an intervening turn.
		if (!changed && intended.kind === 'busy' && conv.current_turn_id === intended.target && intent(conv).kind !== 'busy') {
			intended = intent(conv);
		}
		const at = intent(conv);
		if (at.kind === 'busy') {
			// A turn still runs: the one waited for, when its follow gave up (the connection was lost), or one another window
			// started meanwhile. Nothing is sent over it, and the wait has ended, so the message is kept.
			yield unsentLine(text, files, 'a turn is still running');
			return;
		}
		const { kind, target } = at;
		if (kind !== intended.kind || target !== intended.target) {
			changed = true;
			ending.changed = true;
		}
		// The standing instructions ride with the session's first run only, as open-pinedrama gives them in a session's
		// first goal and in no answer. A run that failed did not deliver them, so the next run carries them.
		const carried = this.store.savedSend(conv.standing_saved_send_id ?? '');
		const standing = kind === 'run' && (!carried || carried.state === 'failed');
		// A session that is not the Project Chat is told so with them (EPISODE_SESSION); the skill says what it means.
		const episodesOnly = this.store.sessionScoped(key);
		// A stop that asked the person to decide: their message is the decision, or the answer to a question in words.
		const decided = this.decisionFor(key, kind, target, text);
		if (decided.kind === 'incomplete') {
			// The message is given back under the line, as every message the Studio does not send is.
			yield { kind: 'reviewRequired', text: `${decided.text} Your message is below, to send again.\n\n${givenBack(text, attachedNames(files))}`, reviewId: decided.reviewId };
			return;
		}
		const reviewId = decided.kind === 'none' ? null : decided.review.id;
		// Files the person added are in the drama's folder already (placeFiles): the request carries them, the note names them.
		const note = placedAttachments.length ? `Pine Drama Studio: the person added to the drama's folder: ${placedAttachments.join(', ')}.` : undefined;
		const body = decided.kind === 'decision' ? decided.sent : text;
		const noted = [body, changed ? CHANGED_TARGET_NOTE : undefined, note].filter((part): part is string => !!part).join('\n\n');
		// A run or an answer is a task (doc/protocol.md, 4.1): its request and every archive and file it names are on the
		// Computer before the message that starts it is sent, and the task id is the message's Idempotency-Key.
		const opId = randomUUID();
		let task: boolean;
		try {
			task = await this.sendTask(key, env, epoch, opId);
		} catch (error) {
			this.log(`${key}: task ${opId} could not be prepared: ${(error as Error).stack ?? error}`);
			yield unsentLine(text, files, `the project could not be sent to the Computer (${(error as Error).message.replace(/[.\s]+$/, '')})`);
			return;
		}
		const said = standing ? withStandingInstructions(noted, episodesOnly) : noted;
		const op: SavedSend = { id: opId, chat_key: key, kind, text: task ? taskMessage(opId, said) : said, target_turn_id: target, state: 'pending', turn_id: null, error: null, cancel_requested: 0, after_event: conv.last_applied_event_id, review_id: reviewId, created_at: '' };
		this.write(key, epoch, () => {
			this.store.insertSavedSend(op);
			// The person's message is recorded as typed; the instructions are the Studio's, in a message of their own.
			const moved = resends ? this.store.moveMessages(resends, op.id, ['prompt', 'decision']) : [];
			if (!moved.includes('prompt')) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'prompt', text, cost: null, currency: null });
			}
			if (decided.kind === 'decision' && !moved.includes('decision')) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'decision', text: decided.answer, cost: null, currency: null });
			}
			if (reviewId) {
				this.store.setReviewAnswer(reviewId, decided.kind === 'decision' ? decided.answer : text);
			}
			if (note) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'instructions', text: note, cost: null, currency: null });
			}
			if (changed) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'instructions', text: CHANGED_TARGET_NOTE, cost: null, currency: null });
			}
			if (standing) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'instructions', text: standingParagraph(episodesOnly), cost: null, currency: null });
				this.store.updateChat(key, { standing_saved_send_id: op.id });
			}
		});
		ending.op = op.id;
		if (changed) {
			yield { kind: 'markdown', text: '\n\n_What your message was written for changed while it waited (shown above), so it goes as a new message, with a note telling the agent so._\n\n' };
		}
		const result = yield* unsent(this.send(key, env, epoch, session, op));
		if (result.kind === 'sent') {
			yield* this.streamPineTurnEvents(key, env, epoch, session);
		}
	}


	/**
	 * Streams the turn that is running, e.g. when a restarted Studio opens the Chat, into the Chat whose history
	 * showed the reviews `shown`. It ends with the card of the review that waits, when that history did not show it: a
	 * publication pass that has no Chat (the resume at start, which only logs) may open it while this Chat is already
	 * provided, and this Chat's follow waits for that pass and then finds nothing left to publish (collect). A
	 * contributed Chat's history is not provided again while its model lives (Code-OSS ChatSessionsService
	 * .getOrCreateChatSession, chatSessions.contribution.ts:1327-1331), so its live response is the one place the card
	 * can reach it; without it the review gates the input with no card to answer it (the person's run).
	 */
	async *attachChatToPineTurn(key: string, shown: ReadonlySet<string> = new Set()): AsyncGenerator<Update> {
		const seen = new Set(shown);
		for await (const update of this.attachChatToRunningPineTurn(key)) {
			if (update.kind === 'review') { seen.add(update.review.id); }
			yield update;
		}
		const waiting = this.openReview(key);
		// One already submitted waits only for its continuation, which its own card or the next message sends: it asks
		// the person nothing.
		if (waiting && waiting.review.items.length > 0 && !waiting.review.submitted && !seen.has(waiting.review.id)) {
			yield reviewUpdate(waiting);
		}
	}

	private async *attachChatToRunningPineTurn(key: string): AsyncGenerator<Update> {
		const conv = this.store.chat(key);
		// A Chat that is not running can still owe the folder the result of a task that ended before a restart.
		if (!conv || (conv.state !== 'running' && !this.hasUnfinishedTurnFollowUp(key))) {
			return;
		}
		const env = this.pineOf(conv);
		const epoch = this.pineSessionGeneration(key);
		// Owed results first, from the artifacts, with no session: a stopped Computer or an ended session still has them.
		yield* this.collectResultsFromPine(key, env, epoch);
		if (conv.pine_session_state !== 'open' || conv.state !== 'running') {
			return;
		}
		const session = yield* this.ensureLivePineSession(key, env, epoch);
		if (!session) {
			return;
		}
		if (conv.state === 'running' && (yield* this.checkUnconfirmedSendsWithPine(key, env, epoch, session))) {
			yield* this.streamPineTurnEvents(key, env, epoch, session);
		}
	}

	/** Whether a task of the Chat ended without its result being published (local first, 6.2). */
	hasUnfinishedTurnFollowUp(key: string): boolean {
		const root = this.projectRoot(key);
		return this.store.unfinishedTurnFollowUps(key).length > 0 || (!!this.options.protocol && !!root && this.dramaRecord(root).unhandled(key).length > 0);
	}

	/**
	 * At start: settles every ended turn that is not settled, in each Chat whose session is open, as main's
	 * `unsettledTurns()` does (follow.ts:190). No message is sent. A Chat another window holds is left to it.
	 */
	async resumeUnfinishedTurnFollowUps(): Promise<void> {
		// Not a Chat of another project: that one is its own window's (holdsElsewhere).
		for (const conv of this.store.chats().filter(c => !this.holdsElsewhere(c.key))) {
			// An ended session's owed results are published too: they need the Computer's artifacts, not its session.
			if (!this.hasUnfinishedTurnFollowUp(conv.key)) {
				continue;
			}
			try {
				// Not a reply the person sees: what it says is logged.
				for await (const update of this.attachChatToRunningPineTurn(conv.key)) {
					if (update.kind !== 'progress') {
						this.log(`${conv.key}: ${update.text.trim()}`);
					}
				}
			} catch (error) {
				this.log(`${conv.key}: resuming its unsettled turns failed: ${(error as Error).stack ?? error}`);
			}
		}
	}

	/**
	 * Starts the agent again for a message the ended session could not take, then sends it there. Everything a restart
	 * guarantees holds (replaceEndedPineSession: confirmed stop of the old binding, saved results published). A restart
	 * that does not happen gives the message back, in one line with why (unsentLine).
	 */
	private async *replacePineSessionAndSend(key: string, text: string, label: string, folder: string | undefined, files: readonly ChatFile[], ending: Ending): AsyncGenerator<Update> {
		// The first attempt's operation, if it recorded one, and whether what the message was written for changed before it.
		const resends = ending.op;
		const changed = ending.changed ?? false;
		const said: Update[] = [];
		let failure: string | undefined;
		try {
			for await (const update of this.replaceEndedPineSession(key)) {
				if (update.kind === 'progress') { yield update; } else { said.push(update); }
			}
		} catch (error) {
			if (error instanceof PineSessionReplacedError) { throw error; }
			this.log(`${key}: the agent could not be started again for a message: ${(error as Error).stack ?? error}`);
			failure = (error as Error).message;
		}
		const conv = this.store.chat(key);
		if (!failure && conv?.pine_session_state === 'open' && conv.computer_state === 'running') {
			yield* said;
			// The same Ending as the first attempt's, so the send this one records is the message's (submitOnce).
			ending.said = false;
			yield* this.sendPersonMessageToPine(key, text, label, folder, intent(conv), files, ending, resends, changed);
			if (ending.said) { yield unsentLine(text, files, 'the new session ended before it took the message'); }
			return;
		}
		const why = failure ?? (said.map(update => update.text.replace(/\*\*The agent was not started again:\*\*\s*/, '').trim()).filter(Boolean).join(' ') || 'it did not start');
		const review = said.find((update): update is Extract<Update, { kind: 'reviewRequired' }> => update.kind === 'reviewRequired');
		const line = unsentLine(text, files, `the agent could not be started again: ${why.replace(/[.\s]+$/, '')}`);
		yield review ? { ...review, text: line.text.trim() } : line;
	}

	/** A new session on the same Computer, started again if stopped: the restart a send performs (replacePineSessionAndSend). */
	async *startNewSession(key: string): AsyncGenerator<Update> {
		const release = await this.queueExecution(key);
		try { yield* this.replaceEndedPineSession(key); }
		finally { release(); }
	}

	private async *replaceEndedPineSession(key: string): AsyncGenerator<Update> {
		if (this.options.connectionCurrent?.() === false) { throw new Error('The Pine connection changed. Reload the window before sending more work.'); }
		// The fence below retires what follows the ended runtime. A publication pass this window runs (the resume at start,
		// the chat opening) is not that: it reads the Computer's artifacts, which outlive the session, and fencing it fails
		// it as a takeover, leaving its result owed and this restart refused for it. It ends first.
		await this.waitUntilNoCollectionRuns(key);
		const conv = this.store.chat(key);
		if (!conv) {
			return;
		}
		if (conv.pine_session_state === 'open' && conv.computer_state === 'running') {
			yield { kind: 'markdown', text: 'This agent still has a live session. Continue in this Chat; no replacement was started.' };
			return;
		}
		if (conv.folder) {
			const entry = this.entry(key, conv.folder);
			if (entry.kind !== 'go') {
				yield { kind: 'markdown', text: 'The agent was not started again: this conversation is not admitted to execute this project.' };
				return;
			}
		}
		const env = this.pineOf(conv);
		// A follower may still await a response from the ended runtime. Fence it before replacing that runtime,
		// including followers in this same window (they captured the earlier Pine session generation).
		this.pineSessionGeneration(key);
		const epoch = this.generations.advance(key);
		const secrets = await this.secrets(conv);
		if (!secrets) {
			yield* this.missingCredentials(key, epoch, conv);
			return;
		}
		// Admission treats creating as unfinished work. Reserve the whole lifecycle before its first
		// remote effect; retain it through final Session persistence, including unknown outcomes.
		this.write(key, epoch, () => this.store.updateChat(key, { computer_state: 'creating' }));
		let stoppedConfirmed = conv.computer_state === 'stopped';
		// A prior restart may have reached Pine without returning its binding or Session. Resolve the
		// same Computer first, then stop that binding; an old binding cannot reconcile an unknown start.
		const retryingStart = conv.computer_state === 'creating' && conv.pine_session_state === 'ended';
		if (retryingStart) {
			let binding: string;
			try { ({ binding } = await this.startComputer(key, epoch, env, secrets.credentials)); }
			catch (error) { yield this.restartNotStarted(key, conv, error); return; }
			secrets.binding = binding;
			await this.publish(key, epoch, secrets, { computer_state: 'creating' });
		}
		// A missing session is not proof that its Computer finished stopping (SDK Stop can resolve false).
		// Reconcile shutdown before replacing that session, or a still-stopping binding could receive a new worker.
		if (conv.pine_session_state === 'ended' && conv.computer_state !== 'stopped' && secrets.binding) {
			const stopped = await this.stopHeld(this.store.chat(key)!, env, epoch);
			if (stopped !== 'stopped') {
				yield { kind: 'markdown', text: '**The agent was not started again:** Computer shutdown is not confirmed. Retry after it has stopped; no replacement session was created.' };
				return;
			}
			stoppedConfirmed = true;
		}
		// Only a confirmed stop can release the lifecycle reservation when no replacement is attempted.
		const notStarted = () => { if (stoppedConfirmed) { this.write(key, epoch, () => this.store.updateChat(key, { computer_state: 'stopped' })); } };
		// What the earlier session's results could not be collected for. Since results that can never be installed close by
		// themselves, only a read that may still succeed keeps one open: retrying can help, and nothing is to resolve.
		const notCollected = (why: string): Update => ({ kind: 'markdown', text: `**The agent was not started again:** the earlier session's saved results could not be collected yet (${why}). Nothing was started. Try again in a moment.` });
		try {
			yield* this.collectResultsFromPine(key, env, epoch);
		} catch (error) {
			if (error instanceof PineSessionReplacedError) {
				throw error;
			}
			notStarted();
			// Deferred, not guessed: a new session started now would be asked for work it cannot have, and a
			// failure is shown, never hidden.
			this.log(`${key}: the earlier session's tasks could not be looked up, so no new session was started: ${(error as Error).stack ?? error}`);
			yield notCollected((error as Error).message);
			return;
		}
		// A publication that failed inside collect is saved on its stop (save_error), not thrown: the same case.
		const unsettled = this.store.unfinishedTurnFollowUps(key);
		const root = this.projectRoot(key);
		const open = this.options.protocol && root ? this.dramaRecord(root).unhandled(key).filter(t => this.store.savedSend(t.request.turn)?.turn_id).map(t => t.request.turn) : [];
		if (unsettled.length || open.length) {
			notStarted();
			this.log(`${key}: earlier results are not collected yet (stops ${unsettled.map(row => row.turn_id).join(', ') || 'none'}; tasks ${open.join(', ') || 'none'}), so no new session was started`);
			yield notCollected(unsettled.map(row => row.save_error).find(Boolean) ?? 'they are still being collected');
			return;
		}
		// A local fact, not a read: the person's decision is what the earlier work waits for.
		const waiting = this.store.reviews(key).find(r => r.state === 'open' && !r.answer && viewOf(r).items.length > 0);
		if (waiting) {
			notStarted();
			yield { kind: 'reviewRequired', reviewId: waiting.id, text: '**The agent was not started again:** a Review is waiting in this Chat. Submit it first; the agent starts with your decisions.' };
			return;
		}
		const needsStart = stoppedConfirmed || !secrets.binding;
		if (needsStart) {
			yield { kind: 'progress', text: `Starting Computer ${conv.computer_id} again…` };
			let binding: string;
			try { ({ binding } = await this.startComputer(key, epoch, env, secrets.credentials)); }
			catch (error) { yield this.restartNotStarted(key, conv, error); return; }
			secrets.binding = binding;
			await this.publish(key, epoch, secrets, { computer_state: 'creating' });
		}
		const created = await this.held(key, epoch, () => this.port.createSession(env, secrets.credentials, secrets.binding!, LABEL));
		secrets.sessionToken = created.token;
		// The next message's task brings the drama's files in (doc/protocol.md, 4.2).
		const notice = `The agent starts again on Computer ${conv.computer_id}. It does not remember earlier turns of this session, and its working folder is empty: your next message brings the project in from your folder.`;
		await this.publish(key, epoch, secrets, { computer_state: 'running', pine_session_name: created.name, pine_session_state: 'open', task_id: null, last_applied_event_id: null, state: 'idle', current_turn_id: null, question_turn_id: null, standing_saved_send_id: null }, () => {
			for (const op of this.store.unconfirmedSavedSends(key)) {
				this.store.updateSavedSend(op.id, { state: 'failed', error: 'the session it was sent to ended' });
			}
			this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: null, kind: 'notice', text: notice, cost: null, currency: null });
		});
		this.verified.add(key);
		yield { kind: 'markdown', text: `_${notice}_` };
	}




	/**
	 * The one developer command: simulates Pine's idle stop (IDLE_WORKING_SECONDS / IDLE_WAITING_SECONDS), so the
	 * path where the Studio finds a Computer stopped can be tested without waiting hours. It asks Pine each Computer this
	 * connection recorded as running for its state, and asks Pine to stop those Pine has not shut down (the local
	 * record keeps a Computer Pine already ended as running, since this command writes nothing back), each through its own
	 * attached handle (the stored Binding, never stop-by-id), and
	 * writes nothing locally: no Computer state, no session end, no notice. The Studio learns of the stop as it learns of
	 * an idle stop, the next time it asks Pine (ready, computerState, MissingError), on Pine's evidence only. Another Pine
	 * environment's Computers are left alone.
	 */
	async stopAll(): Promise<StopAsked[]> {
		const env = this.options.pine;
		const asked: StopAsked[] = [];
		for (const conv of this.store.chats()) {
			if (conv.computer_state !== 'running' || !env || conv.endpoint !== env.endpoint) {
				continue;
			}
			const secrets = await this.secrets(conv);
			if (!secrets?.binding) {
				continue;
			}
			const one = { key: conv.key, computerId: conv.computer_id };
			let pine: string;
			try {
				pine = (await this.port.computerState(env, secrets.credentials, secrets.binding)).toLowerCase();
			} catch (error) {
				// MissingError: Pine has no record of it (sdkPort.computerState is mapped).
				asked.push({ ...one, pine: null, outcome: error instanceof MissingError ? 'gone' : 'failed', detail: (error as Error).message });
				continue;
			}
			// Shut down at Pine: nothing to stop. Any other state still holds or may take compute (running, pending, saving,
			// stopping…), and Stop waits for its release (SDK computer-ts-v0.3.5 Computer.stop).
			if (shutDown(pine)) {
				asked.push({ ...one, pine, outcome: 'ended' });
				continue;
			}
			try {
				await this.port.stopComputer(env, secrets.credentials, secrets.binding);
				asked.push({ ...one, pine, outcome: 'confirmed' });
			} catch (error) {
				const outcome = error instanceof MissingError ? 'gone' : error instanceof UnconfirmedError ? 'unconfirmed' : 'failed';
				asked.push({ ...one, pine, outcome, detail: (error as Error).message });
			}
		}
		return asked;
	}


	/**
	 * Restart's confirmed stop under its generation: `stopped` only on Pine's confirmation, and a Computer Pine no
	 * longer knows counts as stopped. It records nothing itself; restart keeps its creating reservation until the
	 * replacement is fully recorded or safely refused.
	 */
	private async stopHeld(conv: Chat, env: PineConnection, epoch: number): Promise<'stopped' | 'failed' | 'notRunning'> {
		const secrets = await this.secrets(conv);
		if (!secrets?.binding) {
			return 'notRunning';
		}
		try {
			await this.held(conv.key, epoch, () => this.port.stopComputer(env, secrets.credentials, secrets.binding!));
		} catch (error) {
			if (!(error instanceof MissingError)) {
				this.log(`${conv.key}: could not stop Computer ${conv.computer_id}: ${(error as Error).message}`);
				return 'failed';
			}
		}
		return 'stopped';
	}

	// ---- readiness: Computer and session ----

	private async *ensureLivePineSession(key: string, env: PineConnection, epoch: number): AsyncGenerator<Update, PineSession | undefined> {
		let conv = this.store.chat(key)!;
		if (conv.computer_state === 'creating' && conv.pine_session_state === 'ended') {
			// Only explicit restart can reconcile an uncertain replacement; ordinary Send gives its message back.
			yield this.ended(conv);
			return undefined;
		}
		if (conv.computer_state === 'missing_credentials') {
			yield* this.missingCredentials(key, epoch, conv);
			return undefined;
		}
		if (conv.computer_state === 'none') {
			const credentials = await this.port.newCredentials();
			try {
				await this.publish(key, epoch, { credentials: credentials.serialized }, { computer_state: 'creating', computer_id: credentials.id });
			} catch (error) {
				if (error instanceof PineSessionReplacedError) {
					throw error;
				}
				yield { kind: 'markdown', text: `**Could not save the Computer's credentials to the keychain; no Computer was created.** ${(error as Error).message}` };
				return undefined;
			}
			conv = this.store.chat(key)!;
		}
		const secrets = await this.secrets(conv);
		if (!secrets) {
			yield* this.missingCredentials(key, epoch, conv);
			return undefined;
		}
		if (conv.computer_state === 'creating') {
			// How long it may wait.
			yield { kind: 'progress', text: `Starting a Pine Computer… Pine waits up to ${START_WAIT_SECONDS / 60} minutes for one.` };
			let binding: string;
			try {
				({ binding } = await this.startComputer(key, epoch, env, secrets.credentials));
			} catch (error) {
				if (error instanceof StartNotConfirmedError) {
					// Not retried here (the SDK's model): the message is given back (unsentLine) and the session stays "creating", so
					// sending it again is the person's explicit start, which reconciles this Computer.
					this.log(`${key}: Computer ${conv.computer_id}: ${error.message}`);
					yield { kind: 'notStarted', text: 'Pine did not confirm the start of the Pine Computer' };
					return undefined;
				}
				if (!(error instanceof StartTimeoutError)) {
					throw error;
				}
				// Only what was observed: the SDK gives the last state, not why. The message is given
				// back (untilEnded), and the session stays "creating", so sending it again starts the Computer again.
				this.log(`${key}: Computer ${conv.computer_id} did not start within ${START_WAIT_SECONDS}s (sandbox ${error.sandboxId}, last state ${error.lastState})`);
				yield { kind: 'notStarted', text: 'Pine had no Computer ready in time. Try again in a minute' };
				return undefined;
			}
			secrets.binding = binding;
			await this.publish(key, epoch, secrets, { computer_state: 'running' });
			this.log(`Computer ${conv.computer_id} running on ${endpointHost(env.endpoint)}`);
			conv = this.store.chat(key)!;
		}
		if (conv.computer_state === 'stopped' || conv.pine_session_state === 'ended') {
			yield this.ended(conv);
			return undefined;
		}
		if (!secrets.binding) {
			yield* this.missingCredentials(key, epoch, conv);
			return undefined;
		}
		if (!this.verified.has(key) || conv.pine_session_state === 'none') {
			const state = await this.computerState(key, epoch, env, secrets.credentials, secrets.binding);
			if (state !== 'running') {
				yield await this.recordPineSessionEnded(key, epoch, `the Computer is ${state}; Pine does not keep a session across a stop`, shutDown(state));
				return undefined;
			}
		}
		if (conv.pine_session_state === 'none') {
			const created = await this.held(key, epoch, () => this.port.createSession(env, secrets.credentials, secrets.binding!, LABEL));
			secrets.sessionToken = created.token;
			await this.publish(key, epoch, secrets, { pine_session_name: created.name, pine_session_state: 'open' });
			this.verified.add(key);
			conv = this.store.chat(key)!;
		}
		if (!secrets.sessionToken || !conv.pine_session_name) {
			yield* this.missingCredentials(key, epoch, conv);
			return undefined;
		}
		const session: PineSession = { credentials: secrets.credentials, binding: secrets.binding, name: conv.pine_session_name, token: secrets.sessionToken };
		if (!this.verified.has(key)) {
			let taskId: string | undefined;
			try {
				taskId = await this.held(key, epoch, () => this.port.sessionTask(env, session));
			} catch (error) {
				if (!(error instanceof MissingError)) {
					throw error;
				}
				yield await this.endAndStop(key, epoch, env, session, 'Pine no longer has this session');
				return undefined;
			}
			if (conv.task_id && taskId !== conv.task_id) {
				yield await this.endAndStop(key, epoch, env, session, `the session's Task is ${taskId ?? 'gone'}, not ${conv.task_id}`);
				return undefined;
			}
			this.verified.add(key);
			if (conv.task_id) {
				// An internal id is for the Output channel, not the person's Chat.
				this.log(`${key}: reconnected to the original session (Task ${conv.task_id})`);
			}
		}
		return session;
	}

	private async computerState(key: string, epoch: number, env: PineConnection, credentials: string, binding: string): Promise<string> {
		try {
			return (await this.held(key, epoch, () => this.port.computerState(env, credentials, binding))).toLowerCase();
		} catch (error) {
			if (error instanceof MissingError) {
				return 'stopped';
			}
			throw error;
		}
	}


	/** Pine answered that a resource is gone during a send or a turn: the session ends, for the person to decide. */
	private async sessionLost(key: string, epoch: number, env: PineConnection, session: PineSession): Promise<Update> {
		const state = await this.computerState(key, epoch, env, session.credentials, session.binding).catch(() => 'unknown');
		return state === 'running'
			? this.endAndStop(key, epoch, env, session, 'Pine no longer has this session')
			: this.recordPineSessionEnded(key, epoch, `the Computer is ${state}; Pine does not keep a session across a stop`, shutDown(state));
	}

	/**
	 * Ends a session whose Computer still runs, and stops the Computer: no session of the Studio uses it until **Start the
	 * agent again**, which starts it again from its saved state. A stop
	 * that fails is logged and said; the session ends anyway, and the Computer stops after its idle timeout.
	 */
	private async endAndStop(key: string, epoch: number, env: PineConnection, session: Pick<PineSession, 'credentials' | 'binding'>, why: string): Promise<Update> {
		try {
			await this.held(key, epoch, () => this.port.stopComputer(env, session.credentials, session.binding));
		} catch (error) {
			if (error instanceof PineSessionReplacedError) {
				throw error;
			}
			if (!(error instanceof MissingError)) {
				const reason = (error as Error).message;
				this.log(`${key}: could not stop Computer ${this.store.chat(key)?.computer_id}: ${reason}`);
				return this.recordPineSessionEnded(key, epoch, `${why}; its Computer could not be stopped (${reason}), so it stops after its idle timeout`, false);
			}
		}
		return this.recordPineSessionEnded(key, epoch, `${why}; the Studio stopped its Computer`, true);
	}

	/**
	 * A session ends once: when it already has (the stop and the follower of its turn both see the Computer stopped), nothing
	 * more is written or said, except that a stopped Computer is recorded as stopped.
	 */
	private async recordPineSessionEnded(key: string, epoch: number, why: string, computerStopped: boolean): Promise<Update> {
		const already = this.store.chat(key);
		if (already?.pine_session_state === 'ended') {
			if (computerStopped && already.computer_state !== 'stopped') {
				this.write(key, epoch, () => this.store.updateChat(key, { computer_state: 'stopped' }));
			}
			return this.ended(this.store.chat(key)!);
		}
		this.write(key, epoch, () => {
			this.store.updateChat(key, { pine_session_state: 'ended', state: 'idle', current_turn_id: null, question_turn_id: null, ...(computerStopped ? { computer_state: 'stopped' as const } : {}) });
			for (const op of this.store.unconfirmedSavedSends(key)) {
				this.store.updateSavedSend(op.id, { state: 'failed', error: 'the session ended' });
			}
			this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: null, kind: 'notice', text: `The original session ended: ${why}.`, cost: null, currency: null });
		});
		this.verified.delete(key);
		this.idleApplied.delete(key);
		this.log(`${key}: session ended: ${why}`);
		return this.ended(this.store.chat(key)!);
	}


	private ended(conv: Chat): Update {
		return { kind: 'sessionEnded', text: `**The agent's run on Computer ${conv.computer_id} has ended.** The history above is kept. Started again there, the agent would have an empty working folder and no memory of earlier turns; your next message brings the project in from your folder.` };
	}

	private async *missingCredentials(key: string, epoch: number, conv: Chat): AsyncGenerator<Update> {
		// Losing access to a pending start's credentials does not prove that Pine never started it.
		if (conv.computer_state !== 'creating') {
			this.write(key, epoch, () => this.store.updateChat(key, { computer_state: 'missing_credentials' }));
		}
		yield { kind: 'markdown', text: `**The keychain no longer has the credentials of Computer ${conv.computer_id ?? '(not created)'}.** The Studio will not create a replacement on its own; start a new session.` };
	}

	// ---- sending ----

	private async *send(key: string, env: PineConnection, epoch: number, session: PineSession, op: SavedSend): AsyncGenerator<Update, SendResult> {
		try {
			const turn = await this.held(key, epoch, () => this.dispatch(env, session, op));
			this.sent(key, epoch, op, turn);
			yield* this.tendIdle(key, env, epoch, session);
			return { kind: 'sent', turn };
		} catch (error) {
			if (error instanceof UnconfirmedError) {
				this.write(key, epoch, () => this.store.updateSavedSend(op.id, { state: 'unknown', error: error.message }));
				yield { kind: 'markdown', text: `_Pine did not confirm the ${op.kind}; it is resent safely before the next message._` };
				return { kind: 'unknown' };
			}
			if (error instanceof PineSessionReplacedError) {
				throw error;
			}
			if (error instanceof MissingError) {
				yield await this.sessionLost(key, epoch, env, session);
				return { kind: 'ended' };
			}
			this.write(key, epoch, () => {
				this.store.updateSavedSend(op.id, { state: 'failed', error: (error as Error).message });
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: null, kind: 'notice', text: `The ${op.kind} failed: ${(error as Error).message}`, cost: null, currency: null });
			});
			yield { kind: 'markdown', text: `**The ${op.kind} failed:** ${(error as Error).message}` };
			return { kind: 'failed' };
		}
	}


	// ---- reviews: a stop asks the person to decide ----

	/**
	 * Where a session's project is on this desktop: its bound folder's project root, or its folder under the extension's
	 * storage for a session made before binding (`projectRootOf`). Undefined without a
	 * project store (tests that keep no files).
	 */
	projectRoot(key: string): string | undefined {
		const files = this.options.files;
		return files && projectRootOf(files.projectsRoot, this.store.chat(key) ?? { key, folder: null });
	}

	/** The review that waits for the person, with the folder its files are in. */
	openReview(key: string): { review: ReviewView; folder: string | undefined } | undefined {
		const row = this.store.openReview(key);
		const review = row && this.arrival(key, viewOf(row), false);
		if (!review) { return undefined; }
		// Submitted once its choices are written and its answer saved (recordReviewDecisions).
		return { review: { ...review, submitted: !!row.answer, items: review.items.map(item => ({ ...item, recorded: !!row.answer && !!item.targets?.length })) }, folder: this.projectRoot(key) };
	}

	/** All recorded review batches for one durable Chat, newest first. */
	reviews(key: string): ReviewView[] {
		return this.store.reviews(key).map(row => this.review(key, row.id)!).filter(review => review.items.length > 0);
	}

	/** Version-bound history; a renderer cannot read a different Chat's review. */
	review(key: string, id: string): ReviewView | undefined {
		const row = this.store.review(id);
		if (!row || row.chat_key !== key) { return undefined; }
		return { ...this.arrival(key, viewOf(row), false), submitted: !!this.store.review(id)?.answer };
	}

	/**
	 * Which of a review's files are here, from the stop's own records, by the
	 * same resolver that opens them. Existing input files need not appear in a returned delta or have a library row; a row
	 * alone is not proof that its bytes still exist. Older records without a hash retain their original availability.
	 * `verify`: showing needs only that the file is recorded and present; a decision needs its exact bytes, so
	 * the decision boundaries pass true and the read paths false, which hash nothing (fix plan, item 4). A file that cannot
	 * be read is not here, and the reason goes to Output; the other files still show.
	 */
	private arrival(key: string, view: ReviewView, verify: boolean): ReviewView {
		const here = (file: ReviewFile) => {
			const sha = this.reviewFileSha(file);
			if (!sha) { return true; }
			try {
				return this.resolveReturned(key, file.relPath, sha, verify)?.state === 'arrived';
			} catch (error) {
				this.log(`${key}: review file ${file.relPath} in project ${this.projectRoot(key) ?? 'unknown'} could not be read: ${(error as Error).stack ?? error}`);
				return false;
			}
		};
		return {
			...view,
			settling: this.store.turnFollowUp(view.turnId)?.done === 0,
			items: view.items.map(item => ({ ...item, files: item.files.map(file => ({ ...file, here: here(file) })) })),
		};
	}

	/**
	 * Refuses a decision on files that show as here but are not the exact bytes the review was prepared with: changed,
	 * replaced or unreadable since. Files still arriving are left to the caller's own message.
	 */
	private refuseChanged(key: string, row: Parameters<typeof viewOf>[0], verified: ReviewView, itemKeys: readonly string[], tail: string): void {
		const shown = this.arrival(key, viewOf(row), false);
		const changed = shown.items.filter(item => itemKeys.includes(item.key)).flatMap(item => item.files
			.filter((file, index) => file.here && verified.items.find(v => v.key === item.key)?.files[index]?.here === false)
			.map(file => file.relPath));
		if (changed.length) {
			throw new Error(filesChanged(changed, tail));
		}
	}




	/** A live-read picture as a file a webview can show: the content store names bytes by hash, with no extension. */
	/**
	 * What a remote path the session returned is on this computer (core/resolve.ts): the one mapping Review and Chat use.
	 * `verify` hashes the mirror's file before trusting it: for opening a version under review. Undefined without files.
	 */
	resolveReturned(key: string, remotePath: string, sha?: string, verify = false): Resolved | undefined {
		const src = this.resolveSources(key);
		return src && resolveReturned(src, remotePath, sha, verify);
	}

	/** A file the agent names as `drama/x` in the reply of `turnId`, linked only when that stop's own file has arrived (core/chatLinks.ts). */
	projectFile(key: string, turnId: string | undefined, relPath: string): string | undefined {
		const src = this.resolveSources(key);
		return src && localProjectFile(src, turnId, relPath);
	}

	/** The session's project root and the folder nothing may leave; undefined without a project store. */
	projectPlace(key: string): ProjectPlace | undefined {
		const files = this.options.files;
		return files && projectPlaceOf(files.projectsRoot, this.store.chat(key) ?? { key, folder: null });
	}

	private resolveSources(key: string): ResolveSources | undefined {
		const place = this.projectPlace(key);
		const library = this.library;
		return place && library && { store: this.store, has: s => library.has(s), root: place.root, boundary: place.boundary, key };
	}

	/** The SHA-256 a review file shows: as its stop returned it, or from its library row. */
	reviewFileSha(file: Pick<ReviewFile, 'id' | 'sha'>): string | undefined {
		return file.sha ?? (file.id ? this.store.libraryFileById(file.id)?.sha : undefined);
	}

	preview(sha: string, relPath: string, folder: string): string | undefined {
		if (!/^[a-f0-9]{64}$/.test(sha)) { throw new Error('Invalid preview SHA-256'); }
		if (!this.library?.has(sha)) {
			return undefined;
		}
		if (hashFile(this.library.blobPath(sha)) !== sha) {
			throw new Error(`Live Preview: cached bytes do not match ${sha}; this preview cannot be opened.`);
		}
		const target = join(folder, `${sha}${extname(relPath).toLowerCase()}`);
		// Named by its SHA-256, but the name proves nothing: its bytes are checked on every read, as git checks an object
		// against its name (git-fsck, "hash mismatch"), and made again from the library when they differ.
		if (!existsSync(target) || hashFile(target) !== sha) {
			mkdirSync(folder, { recursive: true });
			const temp = `${target}.pine-incoming-${randomUUID()}`;
			copyFileSync(this.library.blobPath(sha), temp);
			renameSync(temp, target);
		}
		return target;
	}


	/**
	 * The person's verdict on one item of a review: kept as a draft, changeable until the decision is sent. Nothing goes to
	 * the agent here; the decision is sent by the person's next message, when every item has a verdict.
	 */
	decideItem(key: string, reviewId: string, itemKey: string, verdict: Verdict, reason?: string): { decided: number; total: number } {
		const epoch = this.pineSessionGeneration(key);
		const row = this.store.review(reviewId);
		if (!row || row.chat_key !== key || row.state !== 'open') {
			throw new Error('this review is no longer waiting for a decision');
		}
		if (row.answer) {
			throw new Error('This review is submitted; its decisions no longer change.');
		}
		const view = this.arrival(key, viewOf(row), true);
		const item = view.items.find(i => i.key === itemKey);
		if (!item) {
			throw new Error(`the review has no item ${itemKey}`);
		}
		if (!itemComplete(item)) {
			this.refuseChanged(key, row, view, [itemKey], 'No decision was recorded.');
			const { here, of } = itemHere(item);
			throw new Error(`${item.label} has ${here} of its ${of} files here: give its verdict once they all are, so it covers what you saw`);
		}
		const verdicts = { ...view.verdicts, [itemKey]: { verdict, reason: verdict === 'revise' && reason !== undefined ? reason : view.verdicts[itemKey]?.reason ?? '' } };
		this.write(key, epoch, () => this.store.setVerdicts(reviewId, JSON.stringify(verdicts)));
		this.changed(key);
		return { decided: view.items.filter(item => verdicts[item.key] !== undefined).length, total: view.items.length };
	}

	/** Select the batch as an editable draft. One write; no acceptance or continuation. */
	approveAll(key: string, reviewId: string): { decided: number; total: number } {
		const epoch = this.pineSessionGeneration(key);
		const row = this.store.review(reviewId);
		if (!row || row.chat_key !== key || row.state !== 'open') {
			throw new Error('this review is no longer waiting for a decision in this conversation');
		}
		if (row.answer) {
			throw new Error('This review is submitted; its decisions no longer change.');
		}
		const view = this.arrival(key, viewOf(row), true);
		if (!view.settling && !view.items.every(itemComplete)) {
			this.refuseChanged(key, row, view, view.items.map(item => item.key), 'No decision was recorded.');
		}
		if (view.settling || !view.items.every(itemComplete)) {
			throw new Error('Wait until all review files have arrived before deciding.');
		}
		const verdicts = Object.fromEntries(view.items.map(item => [item.key,
			{ verdict: 'approve' as const, reason: view.verdicts[item.key]?.reason ?? '' }]));
		this.write(key, epoch, () => this.store.setVerdicts(reviewId, JSON.stringify(verdicts)));
		this.changed(key);
		return { decided: view.items.length, total: view.items.length };
	}


	/**
	 * The person explicitly selects the visible approval statement by submitting the card. `own`: the card's Anything else
	 * field, sent to the agent as their own words and never recorded as the approval (Decisions in Chat).
	 */
	recordReviewDecisionsLocally(key: string, reviewId: string, own = ''): Promise<string> {
		return this.recordReviewDecisionsLocallyOnce(key, reviewId, REVIEW_APPROVAL_STATEMENT, 'ui', own);
	}

	private recordReviewDecisionsLocallyOnce(key: string, reviewId: string, words: string, source: 'typed' | 'ui', own = ''): Promise<string> {
		const running = this.localSubmissions.get(reviewId);
		if (running) { return running; }
		const work = this.recordReviewDecisions(key, reviewId, words, source, own);
		this.localSubmissions.set(reviewId, work);
		void work.finally(() => this.localSubmissions.delete(reviewId)).catch(() => undefined);
		return work;
	}

	/**
	 * Submit: each approved version becomes the person's choice, with their words, in the choices file (doc/protocol.md,
	 * 3.1, `chosen`). The answer is sent as the Chat's next task, which carries the choices to the Computer.
	 */
	private async recordReviewDecisions(key: string, reviewId: string, words: string, source: 'typed' | 'ui', own: string): Promise<string> {
		const epoch = this.pineSessionGeneration(key);
		const row = this.store.review(reviewId);
		const place = this.projectPlace(key);
		if (!row || row.chat_key !== key || row.state !== 'open' || !place || !this.options.protocol) {
			throw new Error('This review is no longer waiting in this project.');
		}
		const view = this.arrival(key, viewOf(row), true);
		const unavailable = view.items.flatMap(item => item.files.filter(file => file.here === false).map(file => file.relPath));
		if (unavailable.length) {
			throw new Error(filesChanged(unavailable, 'Nothing was chosen.'));
		}
		if (!complete(view)) { throw new Error('Give every item a verdict after its files have arrived.'); }
		const approved = view.items.filter(item => view.verdicts[item.key]?.verdict === 'approve').flatMap(item => item.targets ?? []);
		const answer = source === 'ui' ? answerFor(view, own) + (approved.length ? `\nApproval selected in Studio: ${REVIEW_APPROVAL_STATEMENT}` : '') : answerFor(view, words);
		await this.inProjectWriter(place.root, async () => {
			this.generations.assert(key, epoch);
			await updateChoices(place.root, choices => approved.reduce((next, target) => withObject(next, target.object, entry => ({ ...entry, chosen: { version: target.version, words } })), choices));
		});
		this.write(key, epoch, () => this.store.setReviewAnswer(reviewId, answer));
		return answer;
	}

	/** The submitted review's answer (recordReviewDecisions), or undefined while it waits for the person. */
	savedReviewWords(reviewId: string): string | undefined {
		return this.store.review(reviewId)?.answer ?? undefined;
	}

	/**
	 * Pure questions take ordinary Chat answers. Item reviews take only the exact feedback of a locally recorded
	 * submission; Chat never becomes a second human-approval writer.
	 */
	private decisionFor(key: string, kind: SavedSendKind, target: string | null, text: string):
		| { kind: 'none' }
		| { kind: 'question'; review: { id: string } }
		| { kind: 'incomplete'; text: string; reviewId: string }
		| { kind: 'decision'; review: { id: string }; answer: string; sent: string } {
		const row = target ? this.store.reviewOfTurn(key, target) : this.store.openReview(key);
		if (!row || row.state !== 'open') {
			return { kind: 'none' };
		}
		const asked = this.arrival(key, viewOf(row), true);
		if (!asked) {
			return { kind: 'none' };
		}
		const view = asked;
		if (view.items.length === 0) {
			return target ? { kind: 'question', review: row } : { kind: 'none' };
		}
		if (row.answer) {
			// The review is submitted and recorded locally; only its continuation is not sent yet. The person's next
			// message carries it: the recorded answer first, their words after, in one turn. Chat records no approval here: it
			// sends the decision Review already recorded (the live run of 2026-11-05 refused this message as if undecided).
			const both = row.answer === text ? text : `${row.answer}\n\n${text}`;
			return { kind: 'decision', review: row, answer: row.answer, sent: kind === 'run' ? decisionRun(both) : both };
		}
		return { kind: 'incomplete', reviewId: row.id, text: '**Not sent:** decide and submit this review in Review. Chat does not record approval.' };
	}

	/** Opens the review a stop asks for, once per turn: the versions its return asks the person to choose, or a question in words. */
	private createReviewForTurn(key: string, epoch: number, turn: { turnId: string; state: string; asked: string }, targets: readonly ReviewTarget[] = []): { review: ReviewView; folder: string | undefined } | undefined {
		const existing = this.store.reviewOfTurn(key, turn.turnId);
		if (existing) {
			return existing.state === 'open' ? this.openReview(key) : undefined;
		}
		if (!targets.length && turn.state !== 'needs_input' && !asks(turn.asked)) { return undefined; }
		const root = this.projectRoot(key);
		// What the installed snapshots say of each object (core/project.ts, snapshotState): its type sets the review's
		// kind, and its name the item's title, as the canvas names it. No version history is read for that.
		const state = root ? snapshotState(installedSnapshots(root)) : undefined;
		const named = { objects: new Map([...state?.listed ?? []].map(([id, { object }]) => [id, object])), edges: state?.edges ?? [] };
		// Each version shows the file its version.json names (doc/protocol.md, 2.1).
		const items: ReviewItem[] = root ? targets.map(target => {
			const folder = `${target.object}/${target.version}`;
			const shown = (JSON.parse(readFileSync(join(root, folder, 'version.json'), 'utf8')) as { file: string | null }).file;
			const files: ReviewFile[] = shown ? [{ id: 0, relPath: `drama/${folder}/${shown}`, sha: hashFile(join(root, folder, shown)), type: '', here: true }] : [];
			return { key: folder, label: versionTitle(named, target.object, target.version), files, targets: [target] };
		}) : [];
		const kind = reviewKindOf(targets.flatMap(t => { const type = named.objects.get(t.object)?.type; return type ? [type] : []; }));
		this.write(key, epoch, () => this.store.insertReview({ id: randomUUID(), chat_key: key, turn_id: turn.turnId, kind, subject: subjectOf(kind), question: turn.asked, items: JSON.stringify(items) }));
		return this.openReview(key);
	}



	// ---- the uplink: files the person gives the Chat ----


	/**
	 * Keeps local files to send with the next run. A file over Pine's limit is skipped and named, as main's `attach`
	 * does (runs.ts, `skipped`); the others are kept whatever the number.
	 */
	/**
	 * A message with the files the person added in the chat input (Add Context; `ChatRequest.references`, which the glue
	 * maps to `ChatFile`s): each local file goes up by the uplink path `attachFiles` takes, with the same 64 MB limit, the
	 * same note and once only, and then the message goes as `submit` sends it, a run or an answer, a new session's first
	 * message included. What is not sent is said, by name and why: a file over the limit, a folder (Send
	 * Project packs one), anything that is not a file on this computer. Issue: a .docx added this way never left the
	 * desktop, and the agent found its attachments empty.
	 */
	submitWithFiles(key: string, text: string, label: string, files: readonly ChatFile[], folder?: string): AsyncGenerator<Update> {
		return this.submitOnce(key, text, label, folder, files);
	}

	/**
	 * The files the person added in the chat input, placed in the drama's folder before the message goes (doc/protocol.md,
	 * 3.3): the next request carries them in `files`. Returns the folder paths placed, for the message's note. What is not
	 * placed is said, by name and why: a folder, or anything that is not a file on this computer.
	 */
	private async *stageMessageFiles(key: string, files: readonly ChatFile[]): AsyncGenerator<Update, string[]> {
		const notPlaced: string[] = [];
		const paths: string[] = [];
		for (const file of files) {
			if (file.kind !== 'file') {
				notPlaced.push(`${file.name} (${file.why})`);
			} else if (!existsSync(file.path)) {
				notPlaced.push(`${basename(file.path)} (not found on this computer)`);
			} else if (statSync(file.path).isDirectory()) {
				notPlaced.push(`${basename(file.path)} (a folder)`);
			} else if (!paths.includes(file.path)) {
				paths.push(file.path);
			}
		}
		let placed: string[] = [];
		if (paths.length) {
			const result = await this.placeFiles(key, paths);
			placed = result.placed;
			notPlaced.push(...result.unread.map(u => `the text of ${u.name}, which went as it is (${u.why})`));
		}
		if (notPlaced.length) {
			this.log(`${key}: from the chat input, not placed: ${notPlaced.join('; ')}`);
			yield { kind: 'markdown', text: `_Not sent to the agent: ${notPlaced.join('; ')}._\n\n` };
		}
		return placed;
	}

	/** Places files in the Chat's drama folder (placeFiles); the next message carries them. */
	async attachFiles(key: string, paths: readonly string[]): Promise<{ added: string[]; unread: { name: string; why: string }[] }> {
		const { placed, unread } = await this.placeFiles(key, paths);
		this.changed(key);
		return { added: placed, unread };
	}

	/**
	 * Places the person's files in the drama's folder (doc/protocol.md, 3.3). A picture goes to `imports/<client id>.<ext>`
	 * (choices.ts, copyImport), for the agent to look at: it is no import of an object and chooses nothing. Any other file
	 * goes to `inputs/<name>`, a name not taken there (`2-<name>`, …); a Word or PDF file also gets its text beside it as
	 * `inputs/<stem>.txt`, since drama-cli reads a screenplay as UTF-8 text only (core/extract.ts).
	 */
	private async placeFiles(key: string, paths: readonly string[]): Promise<{ placed: string[]; unread: { name: string; why: string }[] }> {
		const root = this.projectRoot(key);
		if (!root) { throw new Error('this session has no drama folder to place the files in'); }
		const placed: string[] = [];
		const unread: { name: string; why: string }[] = [];
		const free = (name: string) => {
			let candidate = name;
			for (let n = 2; existsSync(join(root, 'inputs', candidate)) || placed.includes(`inputs/${candidate}`); n++) { candidate = `${n}-${name}`; }
			return candidate;
		};
		for (const path of paths) {
			if (PICTURE.test(path)) {
				placed.push(await copyImport(root, path, randomUUID()));
				continue;
			}
			const name = free(basename(path));
			mkdirSync(join(root, 'inputs'), { recursive: true });
			const bytes = readFileSync(path);
			await writeWhole(join(root, 'inputs', name), bytes);
			placed.push(`inputs/${name}`);
			if (EXTRACTED.test(name)) {
				let read: Extraction;
				try {
					read = await extractText(name, bytes);
				} catch (error) {
					read = { complete: false, why: `it could not be read: ${(error as Error).message}` };
				}
				if (read.complete) {
					const text = free(textName(name));
					await writeWhole(join(root, 'inputs', text), read.text);
					placed.push(`inputs/${text}`);
				} else {
					unread.push({ name, why: read.why });
				}
			}
		}
		this.log(`${key}: placed ${placed.join(', ') || 'nothing'}${unread.length ? `; text not read: ${unread.map(u => `${u.name} (${u.why})`).join('; ')}` : ''}`);
		return { placed, unread };
	}






	private dispatch(env: PineConnection, session: PineSession, op: Pick<SavedSend, 'kind' | 'id' | 'text' | 'target_turn_id'>): Promise<TurnView> {
		switch (op.kind) {
			case 'run': return this.port.run(env, session, op.text, op.id);
		}
	}

	private sent(key: string, epoch: number, op: Pick<SavedSend, 'id' | 'kind'>, turn: TurnView): void {
		this.write(key, epoch, () => {
			this.store.noteTurn(key, turn.turnId);
			this.store.updateSavedSend(op.id, { state: 'sent', turn_id: turn.turnId, error: null });
			const reviewId = this.store.savedSend(op.id)?.review_id;
			if (reviewId) {
				this.store.answerReview(reviewId);
			}
			// The Chat moved on: a review the person did not decide is no longer asked.
			this.store.closeOpenReviews(key);
			this.store.updateChat(key, { state: 'running', current_turn_id: turn.turnId, question_turn_id: null });
		});
		this.log(`${key}: ${op.kind} ${op.id} -> turn ${turn.turnId} ${turn.state}`);
	}

	/**
	 * Settles sends whose outcome was not known, oldest first, each by its kind's contract, and
	 * follows each to the end of its turn. False while one is still unconfirmed: nothing later may
	 * overtake it.
	 */
	private async *checkUnconfirmedSendsWithPine(key: string, env: PineConnection, epoch: number, session: PineSession): AsyncGenerator<Update, boolean> {
		for (const op of this.store.unconfirmedSavedSends(key)) {
			yield { kind: 'progress', text: `Resending the ${op.kind} Pine did not confirm…` };
			const result = yield* this.send(key, env, epoch, session, op);
			if (result.kind === 'unknown') {
				return false;
			}
			if (result.kind === 'ended') {
				return true;
			}
			if (result.kind === 'sent') {
				yield* this.streamPineTurnEvents(key, env, epoch, session);
			}
		}
		return true;
	}

	// ---- following a turn ----

	/**
	 * Follows the Chat's turn to its end. A lost connection does not end the follow (F4, 2026-11-10: a 35-minute outage left
	 * the turn "running" with nobody following it): the follower says so once, waits as VS Code waits for a lost remote
	 * (RECONNECT_WAITS_MS), and attaches again to the same turn, reading it and its events from the last one applied; it
	 * never starts a turn. Back in contact, it says so, and that the results are fetched when the turn ended meanwhile. A
	 * Computer found gone ends the session as every follower's does (sessionLost). After RECONNECT_LIMIT_MS the wait ends
	 * with a line that offers Reload Window, as VS Code's "Cannot reconnect. Please reload the window." does
	 * (src/vs/workbench/contrib/remote/browser/remote.ts:1011); a reload attaches to the turn again (attachChatToPineTurn).
	 */
	private async *streamPineTurnEvents(key: string, env: PineConnection, epoch: number, session: PineSession): AsyncGenerator<Update> {
		const waits = this.options.reconnectWaitsMs ?? RECONNECT_WAITS_MS;
		const limit = this.options.reconnectLimitMs ?? RECONNECT_LIMIT_MS;
		let since: Date | undefined;
		let attempt = 0;
		const contact = (turn: TurnView): Update | undefined => {
			if (!since) {
				return undefined;
			}
			const at = new Date();
			this.log(`${key}: in contact with Pine again at ${at.toISOString()}, after losing it at ${since.toISOString()}`);
			since = undefined;
			attempt = 0;
			const ended = turn.state !== 'running' && turn.state !== 'canceling';
			return { kind: 'markdown', text: `\n\n_Reconnected to Pine at ${utcTime(at)}${ended ? '. The turn ended while the connection was lost; its results are fetched now.' : '; following the turn again.'}_\n\n` };
		};
		for (; ;) {
			const lost = yield* this.followTurnOnce(key, env, epoch, session, contact);
			if (!lost) {
				return;
			}
			const now = new Date();
			if (!since) {
				since = now;
				this.log(`${key}: connection to Pine lost at ${since.toISOString()}; retrying: ${lost.message}`);
				yield { kind: 'markdown', text: `\n\n_Connection to Pine lost at ${utcTime(since)}; retrying…_\n\n` };
			}
			if (now.getTime() - since.getTime() >= limit) {
				this.log(`${key}: Pine not reached since ${since.toISOString()}; the follow ends: ${lost.message}`);
				yield { kind: 'unreachable', text: `**Pine could not be reached since ${utcTime(since)}.** The turn may still be running on its Computer; reload the window to follow it again.` };
				return;
			}
			const pause = Math.min(waits[Math.min(attempt, waits.length - 1)] ?? 0, Math.max(0, since.getTime() + limit - now.getTime()));
			attempt++;
			await new Promise(resolve => setTimeout(resolve, pause));
		}
	}

	/** One attachment to the Chat's turn; returns the lost connection that ended it, if that is what ended it. */
	private async *followTurnOnce(key: string, env: PineConnection, epoch: number, session: PineSession, contact: (turn: TurnView) => Update | undefined): AsyncGenerator<Update, ConnectionLostError | undefined> {
		const conv = this.store.chat(key)!;
		let turnId = conv.current_turn_id;
		if (!turnId) {
			return;
		}
		// The event stream's own end: aborted once the turn has ended.
		const stream = new AbortController();

		const queue: Update[] = [];
		let wake: (() => void) | undefined;
		let finished = false;
		let failure: unknown;
		// The failure that decides: a gone resource over any other, a lost connection under any other (F4: a stream's unmapped
		// error was kept first and hid the turn read's MissingError).
		const failed = (error: unknown) => {
			const rank = (e: unknown) => e instanceof MissingError ? 2 : e instanceof ConnectionLostError ? 0 : 1;
			if (failure === undefined || rank(error) > rank(failure)) {
				failure = error;
			}
		};
		const push = (u: Update) => { queue.push(u); wake?.(); };
		// Contact is the turn's own read, which says whether it ended meanwhile; an event alone does not say that.
		const touched = (turn: TurnView) => { const line = contact(turn); if (line) { push(line); } };

		const pump = (async () => {
			const start = this.store.chat(key)!;
			try {
				for await (const event of this.port.events(env, session, start.last_applied_event_id ?? undefined, start.task_id ?? undefined, stream.signal)) {
					for (const update of this.apply(key, epoch, event)) {
						push(update);
					}
				}
			} catch (error) {
				if (!stream.signal.aborted) {
					failed(error);
				}
			}
		})();

		// The versions the turn's tasks announce while it runs (doc/protocol.md, 4.6): downloaded once and shown as previews.
		const previews = this.pollPreviews(key, epoch, env, () => turnId!);

		/** Turns that ended answered by someone else on the way: their files are settled too. */
		const answered: TurnView[] = [];
		const ended = (async () => {
			for (; ;) {
				let turn = await this.held(key, epoch, () => this.port.turn(env, session, turnId!, TURN_WAIT_MS));
				touched(turn);
				while (turn.state === 'answered' && turn.nextTurnId) {
					answered.push(turn);
					turnId = turn.nextTurnId;
					this.write(key, epoch, () => this.store.updateChat(key, { current_turn_id: turnId }));
					turn = await this.held(key, epoch, () => this.port.turn(env, session, turnId!, 0));
				}
				if (turn.state !== 'running' && turn.state !== 'canceling') {
					return turn;
				}
			}
		})();
		/** The turn's own read found it ended: what the event stream did no longer decides anything. */
		let turnEnded = false;
		ended.then(async () => {
			turnEnded = true;
			void previews.stop(); // the turn is over: nothing more is read while it runs
			await new Promise(resolve => setTimeout(resolve, this.options.turnEndGraceMs ?? TURN_END_GRACE_MS));
			stream.abort();
			await pump;
			finished = true;
			wake?.();
		}, async (error) => {
			void previews.stop();
			failed(error);
			stream.abort();
			await pump;
			finished = true;
			wake?.();
		});

		try {
			while (!finished || queue.length > 0) {
				if (queue.length === 0) {
					await new Promise<void>(resolve => { wake = resolve; });
					wake = undefined;
					continue;
				}
				yield queue.shift()!;
			}
			if (failure instanceof MissingError) {
				yield await this.sessionLost(key, epoch, env, session);
				return undefined;
			}
			if (failure instanceof ConnectionLostError) {
				// A turn whose own read found it ended is collected, whatever its event stream did: the events carry only
				// progress, and the result and its files come from the turn and the Computer's artifacts. Retried instead,
				// a stream that never recovers would keep a completed turn's results from ever being published.
				if (!turnEnded) {
					return failure;
				}
				this.log(`${key}: turn ${turnId} ended; its event stream was lost, which changes nothing: ${failure.message}`);
				failure = undefined;
			}
			if (failure) {
				throw failure;
			}
			const last = await ended;
			await previews.stop(); // before the settle, which reads what it read
			const ending = this.composeTurnEnding(key, epoch, last);
			// Collected as every other publication pass: a second follower of the same turn in this window (the resume at
			// start and Chat's follow) waits in the line, then finds it published (importTurnResultsIntoProjectFolder's first check).
			// Whether each turn was settled before this follower waits: one settled while it waited was published by the
			// pass ahead of it. A turn settled earlier is published again as before (a held task's later pass).
			const turns = [...answered, last];
			const settledBefore = new Map(turns.map(turn => [turn.turnId, !!this.store.turnFollowUp(turn.turnId)?.done]));
			yield* this.collectResultsFromPine(key, env, epoch, { session, turns, ending, followUpDoneBefore: settledBefore });
			yield* this.tendIdle(key, env, epoch, session);
			return undefined;
		} finally {
			stream.abort();
			void previews.stop();
		}
	}

	/** Applies one event in one transaction; a replayed event changes nothing. */
	private apply(key: string, epoch: number, event: PineEvent): Update[] {
		return this.write(key, epoch, () => {
			const conv = this.store.chat(key)!;
			if (conv.task_id && event.taskId !== conv.task_id) {
				return [];
			}
			if (!this.store.markEvent(key, event.taskId, event.eventId)) {
				return [];
			}
			// An event without a turn id is not attributed to any turn: a backlog event of an earlier
			// turn would otherwise take the current turn's slot. The turn's own result and cost come
			// from agent.wait, which names the turn. Only the followed turn's events are shown.
			const turnId = event.turnId || null;
			if (turnId) {
				this.store.noteTurn(key, turnId);
			}
			const shown = turnId === conv.current_turn_id;
			const updates: Update[] = [];
			const message = (kind: Message['kind'], text: string) =>
				this.store.addMessage({ chat_key: key, turn_id: turnId, saved_send_id: null, kind, text, cost: null, currency: null });
			switch (event.kind) {
				case 'progress':
					message('progress', event.text);
					if (shown) {
						// A plain progress row between two activity rows ends the group Code-OSS draws them in (chatListRenderer.ts:4613-4627,
						// shouldPinPart :4597), so what the agent says is a step that has ended, in the same chain.
						updates.push({ kind: 'activity', id: `event-${event.eventId}`, text: event.text, state: 'completed' });
					}
					break;
				case 'activity':
					message('activity', event.text);
					if (shown) {
						// The SDK gives every activity an id and a state, and drops an event without them.
						updates.push({ kind: 'activity', id: event.activityId ?? `event-${event.eventId}`, text: event.text, state: event.state ?? 'running' });
					}
					break;
				case 'result':
					// Kept, and said when the turn ends, as the reply's final answer (settle): said now, the progress after it
					// would fold it into "Completed N steps" (Code-OSS chatListRenderer.ts:281-309, :4088-4093).
					if (event.text && turnId) {
						message('result', event.text);
					}
					break;
				case 'usage':
					// A cumulative snapshot: it replaces the turn's cost until the final cost settles it.
					// Saved, and said once when the turn ends (the usage update): a running "Cost so far" row would sit between activity
					// rows and break their group (chatListRenderer.ts:4613-4627).
					if (turnId && event.cost !== undefined) {
						this.store.setTurnCost(key, turnId, event.cost ?? null, event.currency ?? '', false);
					}
					break;
			}
			this.store.updateChat(key, { task_id: event.taskId, last_applied_event_id: Math.max(conv.last_applied_event_id ?? 0, event.eventId) });
			return updates;
		});
	}

	/** Records how the turn ended; each final message is written once per turn. */
	/**
	 * Records how the turn ended, each final message once per turn, and returns what the reply says of it: the turn's
	 * result and question as the history shows them (askedOnce.ts), whichever reply recorded them. It is said last in the
	 * reply, after the publication's progress (importTurnResultsIntoProjectFolder): Code-OSS keeps in view only a completed response's last run
	 * of markdown and folds what comes before into "Completed N steps" (chatListRenderer.ts:281-309, `getFinalResponseStartIndex`,
	 * and :4088-4093, at 235ceeb5), so a question said before the "Fetching the stop's files" lines disappeared from
	 * Chat (master's run 1, turn _419; run 2, turns _564 and _674).
	 */
	private composeTurnEnding(key: string, epoch: number, turn: TurnView): Update[] {
		const out = this.write(key, epoch, () => {
			const final = (kind: Message['kind'], text: string) =>
				this.store.addMessage({ chat_key: key, turn_id: turn.turnId, saved_send_id: null, kind, text, cost: null, currency: null });
			if (turn.state === 'needs_input') {
				final('question', turn.question || turn.summary);
				this.store.updateChat(key, { state: 'needs_input', question_turn_id: turn.turnId });
			} else if (turn.state === 'completed') {
				if (turn.summary) {
					final('result', turn.summary);
				}
				this.store.updateChat(key, { state: 'idle', question_turn_id: null });
			} else {
				final('failed', `The turn ${turn.state}${turn.terminalReason ? `: ${turn.terminalReason}` : ''}. ${turn.summary}`.trim());
				this.store.updateChat(key, { state: 'failed', question_turn_id: null });
			}
			const ending: Update[] = withoutRepeatedQuestion(this.store.messages(key).filter(m => m.turn_id === turn.turnId && ['result', 'question', 'failed'].includes(m.kind)))
				.map(m => ({ kind: 'markdown' as const, question: m.kind === 'question', text: m.kind === 'question' ? `\n\n**The agent asks:** ${m.text}` : m.kind === 'failed' ? `\n\n**${m.text}**` : `\n\n${m.text}` }));
			if (turn.cost && this.store.setTurnCost(key, turn.turnId, turn.cost.total, turn.cost.currency, true)) {
				ending.push({ kind: 'usage', text: usageText(turn.cost.total, turn.cost.currency) });
			}
			return ending;
		});
		this.log(`${key}: turn ${turn.turnId} ended ${turn.state}; cost ${turn.cost?.total ?? 'unknown'} ${turn.cost?.currency ?? ''}`);
		return out;
	}

	// ---- idle timeout ----

	/**
	 * Keeps the Computer running while the agent waits for the person (as open-pinedrama does, docs/PROPOSAL.md section 5.3):
	 * the longer window while a question or a review waits, the working one otherwise. Called when a turn ends and
	 * when a message is sent. A failure is logged and shown, and asked again at the next call.
	 */
	private idlePolicy(env: PineConnection): Promise<IdlePolicy> {
		let policy = this.idlePolicies.get(env.endpoint);
		if (!policy) {
			policy = this.port.idlePolicy(env);
			this.idlePolicies.set(env.endpoint, policy);
			policy.catch(() => this.idlePolicies.delete(env.endpoint));
		}
		return policy;
	}

	/** No longer than the project's maximum, and at least Pine's minute (open-pinedrama `allowedIdle`). */
	private allowedIdle(policy: IdlePolicy, seconds: number): number {
		return policy.maxIdleSeconds ? Math.max(60, Math.min(seconds, policy.maxIdleSeconds)) : seconds;
	}

	/**
	 * The idle timeout a start asks for. Where the project has no lifetime policy it cannot change once started, so the
	 * waiting one from the start (open-pinedrama docs/IMPLEMENTATION_PLAN.md, "Idle timeout"); otherwise the working
	 * one, which `tendIdle` raises while the agent waits. 
	 */
	/**
	 * A restart whose start Pine did not confirm (timed out, or another start won or committed without completing): the
	 * Computer stays reserved as "creating", whose outcome only the person's next send reconciles (replaceEndedPineSession,
	 * retryingStart); the send that asked gives its message back (replacePineSessionAndSend). Nothing is retried here
	 * (StartNotConfirmedError). Any other error is the caller's.
	 */
	private restartNotStarted(key: string, conv: Chat, error: unknown): Update {
		if (!(error instanceof StartNotConfirmedError || error instanceof StartTimeoutError || error instanceof AccountError)) { throw error; }
		this.log(`${key}: Computer ${conv.computer_id} was not started again: ${error.message}`);
		return { kind: 'markdown', text: `**The agent was not started again:** ${error.message}` };
	}

	private async startComputer(key: string, epoch: number, env: PineConnection, credentials: string): Promise<{ binding: string }> {
		const idle = await this.held(key, epoch, () => this.startIdle(env));
		const started = await this.held(key, epoch, () => this.port.ensureComputer(env, credentials, LABEL, idle));
		this.idleApplied.set(key, idle);
		return started;
	}

	private async startIdle(env: PineConnection): Promise<number> {
		const policy = await this.idlePolicy(env);
		return this.allowedIdle(policy, policy.adjustable ? IDLE_WORKING_SECONDS : IDLE_WAITING_SECONDS);
	}

	private async *tendIdle(key: string, env: PineConnection, epoch: number, session: PineSession): AsyncGenerator<Update> {
		const conv = this.store.chat(key)!;
		if (conv.pine_session_state !== 'open') {
			return;
		}
		const waiting = conv.state === 'needs_input' || this.openReview(key) !== undefined;
		let wanted = waiting ? IDLE_WAITING_SECONDS : IDLE_WORKING_SECONDS;
		try {
			const policy = await this.held(key, epoch, () => this.idlePolicy(env));
			if (!policy.adjustable) {
				return; // fixed at start, which already asked for the waiting timeout
			}
			wanted = this.allowedIdle(policy, wanted);
			if (this.idleApplied.get(key) === wanted) {
				return;
			}
			const applied = await this.held(key, epoch, () => this.port.setIdleTimeout(env, session, wanted));
			this.idleApplied.set(key, applied);
			if (applied !== wanted) {
				this.log(`${key}: asked Pine for an idle timeout of ${wanted}s; it applied ${applied}s`);
				yield { kind: 'markdown', text: `\n\n_Pine applied an idle timeout of ${applied / 60} minutes, not the ${wanted / 60} asked for._` };
			}
		} catch (error) {
			if (error instanceof PineSessionReplacedError) {
				throw error;
			}
			const why = error instanceof Error ? error.message : String(error);
			this.log(`${key}: could not set the Computer's idle timeout to ${wanted}s: ${why}`);
			// Chat keeps only what costs the person time: a timeout that could not be raised while they decide. One that could
			// not be set back only leaves the Computer running longer than wished, which Output says.
			if (waiting) {
				yield { kind: 'markdown', text: `\n\n**The Computer's idle timeout could not be raised while you decide (${why}).** If you take longer than ${IDLE_WORKING_SECONDS / 60} minutes, Pine stops the Computer and the session ends.` };
			}
		}
	}

	// ---- local first: a run or answer is a task ----


	/**
	 * Puts a task on the Chat's Computer before its message is sent (doc/protocol.md, 4.1 and 4.2): the request is built from
	 * the folder and the returns installed in it; every archive and file it names that the Computer's store lacks is
	 * uploaded; then the request itself is written. False when the
	 * Chat has no folder or Computer: its message then goes as it is.
	 */
	private async sendTask(key: string, env: PineConnection, epoch: number, task: string): Promise<boolean> {
		const proto = this.options.protocol;
		const root = this.projectRoot(key);
		const conv = this.store.chat(key);
		if (!proto || !root || !conv?.computer_id) {
			return false;
		}
		const place = this.projectPlace(key)!;
		if (!within(place.boundary, root)) { throw new Error('The project leads outside its bound folder.'); }
		const scope = this.chatScope(conv);
		mkdirSync(root, { recursive: true });
		const record = this.dramaRecord(root);
		// One task at a time per session: the next is sent only once the last one's return is installed, so it starts from
		// that return's private state and folders.
		// Only a task whose send went through (it has a turn and did not fail) can return; one Pine refused or never admitted,
		// such as a send to a session that had ended, ran nothing and is not waited for.
		const waiting = record.unhandled(key).filter(t => { const op = this.store.savedSend(t.request.turn); return !!op?.turn_id && op.state !== 'failed'; });
		if (waiting.length) { throw new Error(`the result of the previous task (${waiting.map(t => t.request.turn).join(', ')}) is not installed yet`); }
		const request = await requestOf(root, record, join(proto.storage, 'kept'), task, scope, key, await readChoices(root), []);
		const target = await this.held(key, epoch, () => this.port.artifacts(env, conv.computer_id!));
		const kept = join(proto.storage, 'kept');
		const clientFile = new Map(Object.entries(request.files).map(([path, hash]) => [`files/${hash}`, join(root, path)]));
		const bytes = (artifact: string): Buffer => {
			const here = keptBytes(kept, artifact) ?? (clientFile.has(artifact) ? readFileSync(clientFile.get(artifact)!) : undefined);
			if (!here || !artifact.includes(sha256(here))) { throw new Error(`the Studio has no copy of ${artifact} any more`); }
			return here;
		};
		const size = (artifact: string): number => { const path = existsSync(join(kept, artifact)) ? join(kept, artifact) : clientFile.get(artifact); return path && existsSync(path) ? statSync(path).size : -1; };
		const put = await this.held(key, epoch, () => putAll(target, conv.computer_id!, this.holders(), requestKeys(request), bytes, size));
		await this.held(key, epoch, () => target.upload(requestKey(task), Buffer.from(JSON.stringify(request))));
		this.generations.assert(key, epoch);
		await record.sentRequest(request, conv.computer_id, key);
		this.log(`${key}: task ${task} (${scope}): ${Object.keys(request.versions).length} version(s), ${put.copied} copied, ${put.uploaded} uploaded`);
		return true;
	}

	/**
	 * A Chat's scope: the Project Chat's is `project`, as is a Chat's own folder under the extension's storage, which no
	 * other Chat shares; every other session of a project is `episodes` (resultImporter.ts, inScope).
	 */
	private chatScope(conv: Chat): 'project' | 'episodes' {
		return conv.project_role === 'main' || !conv.folder ? 'project' : 'episodes';
	}

	/** Polls the progress of a running turn's tasks (doc/protocol.md, 4.6) until stopped (resultImporter.ts, previewProgress). */
	private pollPreviews(key: string, epoch: number, env: PineConnection, turnId: () => string): { stop(): Promise<void> } {
		const proto = this.options.protocol;
		const root = this.projectRoot(key);
		let stopped = false;
		let wake: (() => void) | undefined;
		const running = (async () => {
			// A pause first: a turn that has just started has announced nothing, and one that ends at once is never polled.
			const pause = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, this.options.previewPollMs ?? PREVIEW_POLL_MS); wake = () => { clearTimeout(timer); resolve(); }; });
			for (await pause(); !stopped && proto && root; await pause()) {
				const record = this.dramaRecord(root);
				for (const op of this.store.savedSendsOfTurn(key, turnId())) {
					const sent = record.sentTask(op.id);
					if (!sent || record.handled(op.id)) { continue; }
					try {
						const store = await this.held(key, epoch, () => this.port.artifacts(env, sent.computer));
						if (await previewProgress({ record, kept: join(proto.storage, 'kept'), store, task: op.id })) { this.changed(key); }
					} catch (error) {
						if (error instanceof PineSessionReplacedError) { return; }
						this.log(`${key}: the previews of task ${op.id} could not be read: ${(error as Error).message}`);
					}
				}
			}
		})();
		return { stop: async () => { stopped = true; wake?.(); await running; } };
	}

	/** One Computer remembered per hash, under the protocol storage (taskArtifacts.ts, Holders). */
	private holders(): Holders {
		return new Holders(join(this.options.protocol!.storage, 'holders'));
	}

	/** The Studio's record of the drama at `root`, under the extension's storage (taskRun.ts, DramaRecord). */
	private dramaRecord(root: string): DramaRecord {
		return dramaRecordOf(this.options.protocol!.storage, root);
	}


	private async inProjectWriter<T>(root: string, work: () => Promise<T>): Promise<T> {
		const project = projectIdentity(root);
		const before = this.projectWriters.get(project);
		let ended!: () => void;
		const mine = new Promise<void>(resolve => { ended = resolve; });
		const line = before ? before.then(() => mine) : mine;
		this.projectWriters.set(project, line);
		try {
			await before;
			return await work();
		} finally {
			if (this.projectWriters.get(project) === line) { this.projectWriters.delete(project); }
			ended();
		}
	}




	/**
	 * At a turn's end: each task the turn carried has its return read from the Computer that ran it and installed into the
	 * folder (doc/protocol.md, 4.4), and the review the stop asks for opens from the return's `review`.
	 */
	private async *importTurnResultsIntoProjectFolder(key: string, env: PineConnection, epoch: number, turn: { turnId: string; state: string; asked: string }, ending: readonly Update[] = [], settledBefore?: boolean): AsyncGenerator<Update> {
		const finalWords = (): Update[] => {
			const review = this.store.reviewOfTurn(key, turn.turnId);
			const needsReview = !!review && viewOf(review).items.length > 0;
			return ending.map(update => update.kind === 'markdown' && update.question
				? { kind: 'markdown', text: update.text + (needsReview ? '' : '\n\n_Your next message answers it._') } : update);
		};
		// A turn's end is its words, what this pass said, then its review while that review waits for the person, whichever
		// pass opened it.
		const ended = function* (this: ChatService, said: readonly Update[]): Generator<Update> {
			yield* finalWords();
			yield* said;
			const open = this.openReview(key);
			if (open && open.review.turnId === turn.turnId && open.review.items.length > 0 && !open.review.submitted) {
				yield reviewUpdate(open);
			}
		}.bind(this);
		if (settledBefore === false && this.store.turnFollowUp(turn.turnId)?.done) {
			yield* ended([]);
			return;
		}
		const proto = this.options.protocol;
		const root = this.projectRoot(key);
		const record = proto && root ? this.dramaRecord(root) : undefined;
		const tasks = record ? this.store.savedSendsOfTurn(key, turn.turnId).map(op => op.id).filter(id => record.sentTask(id) && !record.handled(id)) : [];
		if (!proto || !root || !record || tasks.length === 0) {
			yield* finalWords();
			return;
		}
		this.write(key, epoch, () => this.store.startTurnFollowUp(key, turn.turnId, turn.state, turn.asked));
		// A large return takes minutes to install after the agent's reply (B5): the Chat says so until the install ends,
		// as a progress part (ChatResponseStream.progress), which the turn's last words then follow. The words hold whatever
		// the return turns out to be: none, refused or unreadable is collected and said too, and the rest installs.
		yield { kind: 'progress', text: 'Collecting the turn\'s result into your project…' };
		const shown: Update[] = [];
		const tell = (line: string, unused = false) => {
			this.store.addMessage({ chat_key: key, turn_id: turn.turnId, saved_send_id: null, kind: unused ? 'unused' : 'notice', text: line, cost: null, currency: null });
			shown.push(unused ? { kind: 'unused', text: line } : { kind: 'markdown', text: `\n\n_${line}_` });
			this.changed(key);
		};
		const review: ReviewTarget[] = [];
		const returned: string[] = [];
		try {
			await this.inProjectWriter(root, async () => {
				for (const task of tasks) {
					this.generations.assert(key, epoch);
					// The folder is still the bound one: a root moved away or replaced by a link receives nothing.
					if (!within(this.projectPlace(key)!.boundary, root)) { throw new Error('the project leads outside its bound folder'); }
					const sent = record.sentTask(task)!;
					const store = await this.held(key, epoch, () => this.port.artifacts(env, sent.computer));
					const bytes = await this.held(key, epoch, () => store.read(returnKey(task)));
					// 4.5: no return. Only the person decides whether to run the work again.
					if (!bytes) { await record.handle(task); tell(NO_RETURN, true); continue; }
					let back: Return;
					try { back = readReturn(bytes, task); } catch (error) {
						if (!(error instanceof UnsupportedMajor || error instanceof SyntaxError)) { throw error; }
						await record.handle(task);
						tell(`This turn's result couldn't be read: ${(error as Error).message.replace(/[.\s]+$/, '')}. Nothing was installed; ask it to continue.`, true);
						continue;
					}
					if (back.state === 'refused') {
						await record.handle(task, back.problems);
						tell(`The Computer refused this task: ${back.error?.message ?? 'it gave no reason'}${back.error?.action ? ` ${back.error.action}` : ''}`, true);
						continue;
					}
					const { done, leftOut } = await this.held(key, epoch, () => installReturn({ root, record, kept: join(proto.storage, 'kept'), store, request: sent.request, ret: back }));
					const installed = Object.keys(done.versions).length;
					returned.push(...Object.keys(done.versions));
					// The Computer that returned them holds them: the next task copies from it rather than uploading.
					await this.holders().set([...Object.values(done.versions), ...Object.values(done.reviews), ...(done.private_state ? [done.private_state] : [])], sent.computer);
					// What could not be used is left out, never the whole result: said in one line (doc/protocol.md, 4.4).
					if (leftOut.length) {
						tell(`Installed ${installed} of ${installed + leftOut.filter(l => l.kind === 'version').length} returned versions. Left out: ${leftOut.map(l => `${l.path} (${l.why})`).join('; ')}.`, true);
					}
					// A run that broke off returns what it finished, installed above, and why it broke off (doc/protocol.md, 4.3).
					// It may have finished no version: then saying its work is in the project sends the person looking for none.
					if (back.state === 'failed') {
						tell(`The task broke off: ${back.error?.message ?? 'no reason was given'}${back.error?.action ? ` ${back.error.action}` : ''} ${installed
							? 'What it finished is in your project.' : 'No new version was added to your project. To go on, ask it to continue in a new message.'}`, true);
					}
					for (const problem of back.problems ?? []) { tell(`${problem.ref}: ${problem.error?.message}`); }
					review.push(...(back.review ?? []));
				}
			});
		} catch (error) {
			if (error instanceof PineSessionReplacedError) { throw error; }
			// The task stays unhandled: its return is read again at the next message or restart (collectResultsStillOwed).
			const why = (error as Error).message;
			this.log(`${key}: turn ${turn.turnId}'s result could not be installed: ${(error as Error).stack ?? error}`);
			this.write(key, epoch, () => this.store.updateTurnFollowUp(turn.turnId, { save_error: why }));
			this.changed(key);
			yield* finalWords();
			yield* shown;
			yield { kind: 'markdown', text: `\n\n**The result of turn ${turn.turnId} could not be installed:** ${why}. It is tried again at your next message.` };
			return;
		}
		this.write(key, epoch, () => this.store.updateTurnFollowUp(turn.turnId, { returned: JSON.stringify(returned) }));
		try {
			this.createReviewForTurn(key, epoch, turn, review);
		} catch (error) {
			const notice = `The files were installed, but Review could not be opened: ${(error as Error).message}`;
			this.write(key, epoch, () => {
				this.store.updateTurnFollowUp(turn.turnId, { done: 1, save_error: null });
				this.store.addMessage({ chat_key: key, turn_id: turn.turnId, saved_send_id: null, kind: 'notice', text: notice, cost: null, currency: null });
			});
			yield* finalWords();
			yield* shown;
			yield { kind: 'markdown', text: `\n\n**${notice}**` };
			return;
		}
		this.write(key, epoch, () => this.store.updateTurnFollowUp(turn.turnId, { done: 1, save_error: null }));
		this.changed(key);
		yield* ended(shown);
	}






	// ---- resuming tasks whose results were not published ----

	/**
	 * Publishes every result the Chat is owed that the Computer's artifacts already hold: a turn whose publication
	 * did not finish, and a task whose turn ended with its manifest saved. It needs no session: artifacts outlive a stop,
	 * so a stopped Computer or an ended session does not keep a result from the project, and
	 * nothing is started or sent again. A task whose turn ended without its return step stays owed (owedReturns).
	 */
	/**
	 * Every collection pass of a Chat goes through here (serial core; section 2), one at
	 * a time in its line (runOneCollectionPerChat). Without `turnEnd` it is the owed pass (collectResultsStillOwed): the chat opening (attachChatToRunningPineTurn),
	 * the resume at start, a restart and a send's pre-send pass. With it, the import of the turns a follower followed
	 * to their end (streamPineTurnEvents). A later caller waits for the passes before it and then makes its own over what is left,
	 * as Code-OSS's SequencerByKey runs one task per key at a time (src/vs/base/common/async.ts:338-354). It does not
	 * return at once: its caller goes on to read what the pass has not settled yet (replaceEndedPineSession), and would refuse on
	 * it. Its place in line is taken in the same tick it asks, before any await, or two callers that enter
	 * together both find no pass running and publish the same task.
	 */
	private async *collectResultsFromPine(key: string, env: PineConnection, epoch: number, turnEnd?: TurnEnd): AsyncGenerator<Update> {
		yield* this.runOneCollectionPerChat(key, () => turnEnd ? this.collectAtTurnEnd(key, env, epoch, turnEnd) : this.collectResultsStillOwed(key, env, epoch));
	}

	/** collect's pass at a turn's end: each turn followed to its end, the last with the ending composeTurnEnding() formatted. */
	private async *collectAtTurnEnd(key: string, env: PineConnection, epoch: number, end: TurnEnd): AsyncGenerator<Update> {
		const last = end.turns[end.turns.length - 1];
		for (const turn of end.turns) {
			yield* this.importTurnResultsIntoProjectFolder(key, env, epoch, { turnId: turn.turnId, state: turn.state, asked: turn.question || turn.summary }, turn === last ? end.ending : [], end.followUpDoneBefore.get(turn.turnId));
		}
	}

	/**
	 * Runs one publication pass for the Chat in its line: it waits for the passes before it, as Code-OSS's
	 * SequencerByKey runs one task per key (src/vs/base/common/async.ts:338-354), and takes its place in the same tick it
	 * is called, before any await, so two passes that ask together never both find the line empty.
	 */
	private async *runOneCollectionPerChat(key: string, pass: () => AsyncGenerator<Update>): AsyncGenerator<Update> {
		const before = this.settling.get(key);
		let ended!: () => void;
		const mine = new Promise<void>(resolve => { ended = resolve; });
		const line = before ? before.then(() => mine) : mine;
		this.settling.set(key, line);
		try {
			await before;
			yield* pass();
		} finally {
			// Only the last in line clears it; a pass queued behind this one keeps its place.
			if (this.settling.get(key) === line) {
				this.settling.delete(key);
			}
			ended();
		}
	}

	/** collect's owed pass: every ended turn not settled yet, and every sent task of the Chat whose turn ended with its return unread. */
	private async *collectResultsStillOwed(key: string, env: PineConnection, epoch: number): AsyncGenerator<Update> {
		const conv = this.store.chat(key);
		const pending = new Map<string, { turnId: string; state: string; asked: string }>();
		for (const row of this.store.unfinishedTurnFollowUps(key)) {
			pending.set(row.turn_id, { turnId: row.turn_id, state: row.state, asked: row.asked });
		}
		const root = this.projectRoot(key);
		for (const sent of this.options.protocol && root ? this.dramaRecord(root).unhandled(key) : []) {
			const turnId = this.store.savedSend(sent.request.turn)?.turn_id;
			if (!turnId || pending.has(turnId) || (conv && conv.pine_session_state !== 'ended' && conv.state === 'running' && conv.current_turn_id === turnId)) {
				continue;
			}
			const said = this.store.messages(key).filter(m => m.turn_id === turnId && (m.kind === 'question' || m.kind === 'result')).at(-1);
			pending.set(turnId, { turnId, state: conv?.question_turn_id === turnId ? 'needs_input' : 'completed', asked: said?.text ?? '' });
		}
		for (const turn of pending.values()) {
			yield* this.importTurnResultsIntoProjectFolder(key, env, epoch, turn, []);
		}
	}

	/** Resolves when no publication pass of this window runs for the Chat. */
	private async waitUntilNoCollectionRuns(key: string): Promise<void> {
		for (let pass = this.settling.get(key); pass; pass = this.settling.get(key)) {
			await pass;
		}
	}

	// ---- plumbing ----

	/** The Pine the Studio connects to, for a new session. */
	private thePine(): PineConnection {
		if (!this.options.pine) {
			throw new NoPineError();
		}
		return this.options.pine;
	}

	/** The Pine a session runs on: the one the Studio connects to, if the session began there (matched by endpoint). */
	private pineOf(conv: Chat): PineConnection {
		const pine = this.thePine();
		if (conv.endpoint !== pine.endpoint) {
			throw new OtherPineError(conv.endpoint, pine.endpoint);
		}
		return pine;
	}

	/**
	 * Whether `key` is bound to a project this window does not hold. Such a Chat is driven, collected and reviewed
	 * only by the window that holds its project. An unbound Chat has no project of the person's yet: a send binds it to
	 * this window's folder before anything remote (entryFor).
	 */
	private holdsElsewhere(key: string): boolean {
		const folder = this.store.chat(key)?.folder;
		return !!folder && !this.options.holdsProject(folder);
	}

	private assertProjectHeld(key: string): void {
		if (this.holdsElsewhere(key)) {
			throw new BusyElsewhereError('This Chat\'s project is not open in this window, so nothing was done here. Open its project to continue: that window collects its results and sends its messages.');
		}
	}

	/**
	 * The Pine session generation a pass of `key` works under (core/pineSessionGeneration.ts), once this window is known
	 * to hold the Chat's project. It replaces the lease: one window drives a project, so no other window can take a
	 * Chat over, and nothing is held or renewed.
	 */
	private pineSessionGeneration(key: string): number {
		this.assertProjectHeld(key);
		return this.generations.of(key);
	}

	/**
	 * Runs a remote call of a pass of `generation`. If the Chat's Pine session was replaced while the call was out, its
	 * outcome is not used: PineSessionReplacedError. Checked after a rejected call too, so a stale MissingError from the
	 * earlier session never ends or stops its replacement. A pass reaches its next remote call only through an earlier
	 * one or a write, both checked, so no check is needed before the call.
	 */
	private async held<T>(key: string, generation: number, call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} finally {
			this.generations.assert(key, generation);
		}
	}

	/** A write of a pass of `generation`: nothing is written once the Chat's Pine session was replaced. */
	private write<T>(key: string, generation: number, work: () => T): T {
		const result = this.store.tx(() => {
			this.generations.assert(key, generation);
			return work();
		});
		this.changed(key);
		return result;
	}

	private changed(key: string): void {
		this.options.onChange?.(key);
	}

	private async secrets(conv: Chat): Promise<ComputerSecrets | undefined> {
		if (!conv.secret_gen) {
			return undefined;
		}
		const raw = await this.vault.get(`${conv.secret_ref}.${conv.secret_gen}`);
		return raw ? JSON.parse(raw) as ComputerSecrets : undefined;
	}

	/**
	 * Publishes secrets under the generation: they go to a new vault entry, read back, and become current
	 * only through a database write that checks the generation (with `patch` and `also` in the same
	 * transaction). A pass of a replaced session leaves the current entry untouched.
	 */
	private async publish(key: string, epoch: number, secrets: ComputerSecrets, patch: Parameters<Store['updateChat']>[1], also?: () => void): Promise<void> {
		const conv = this.store.chat(key)!;
		const gen = randomUUID();
		const name = `${conv.secret_ref}.${gen}`;
		const value = JSON.stringify(secrets);
		await this.vault.store(name, value);
		if (await this.vault.get(name) !== value) {
			throw new Error('the keychain did not keep the value');
		}
		try {
			this.write(key, epoch, () => {
				this.store.updateChat(key, { ...patch, secret_gen: gen });
				also?.();
			});
		} catch (error) {
			await this.vault.delete(name).catch(() => undefined);
			throw error;
		}
		if (conv.secret_gen) {
			await this.vault.delete(`${conv.secret_ref}.${conv.secret_gen}`).catch(() => undefined);
		}
	}
}

/**
 * What a message sent now would be: a run, or the answer to the waiting question. While a turn runs it is neither yet:
 * v1 neither cancels nor steers a running turn, so the message waits for the turn to end (sendPersonMessageToPine).
 */
/** What a send learns from its own attempt: the session ended before the message reached Pine, and the operation it recorded. */
type Ending = { said: boolean; op?: string; changed?: boolean };

function intent(conv: Chat): { kind: SavedSendKind; target: string | null } | { kind: 'busy'; target: string } {
	// The answer to a stop is a new task (doc/protocol.md, 4.3: "the person's answer is a new task"): a run, never Pine's
	// answer to the waiting turn. It keeps that turn as its target, so a question that changed meanwhile is still noted.
	if (conv.state === 'needs_input' && conv.question_turn_id) {
		return { kind: 'run', target: conv.question_turn_id };
	}
	if (conv.state === 'running' && conv.current_turn_id) {
		return { kind: 'busy', target: conv.current_turn_id };
	}
	return { kind: 'run', target: null };
}

function secretRef(key: string): string {
	return `pine.conversation.${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/** `steps` as they are, noting in `shown` when one of them gave the message back (an `unsent` line, or a Review's refusal). */
async function* givingBack(steps: AsyncGenerator<Update>, shown: { given: boolean }): AsyncGenerator<Update> {
	for await (const update of steps) {
		if (update.kind === 'unsent' || update.kind === 'reviewRequired') { shown.given = true; }
		yield update;
	}
}

/** The names of a message's attached files, as a refusal names them to add again. */
function attachedNames(files: readonly ChatFile[]): string[] {
	return files.map(file => (file.kind === 'file' ? basename(file.path) : file.name));
}

/** A message the Studio did not send, given back in its line so the person can send it again (core/refusal.ts; givenBack). */
function unsentLine(text: string, files: readonly ChatFile[], reason: string): Update {
	return { kind: 'unsent', text: `\n\n_Your message was not sent: ${reason}. Here it is, to send again:_\n\n${givenBack(text, attachedNames(files))}` };
}

function usageText(cost: number | null, currency: string): string {
	return `\n\n_cost of this turn: ${cost === null ? 'not priced' : `${cost} ${currency}`}_`;
}

