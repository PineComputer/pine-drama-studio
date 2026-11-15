import { sha256 } from './sha256';
// Chats with Pine Computer agents that survive restarts and several windows.
// The rules this file keeps:
// 1. Credentials are saved, and read back, before a Computer is created; a Computer whose
//    credentials are missing is reported, never silently replaced.
// 2. Secrets are fenced like database writes: each save goes to a new vault entry, which only a
//    write of the current Pine session generation makes current (`secret_gen`); a pass of a replaced session publishes nothing.
// 3. Every send is saved (its text) before it is sent, and one whose outcome is unknown is run again with the same key.
//    While an earlier send's outcome is unknown, no later message is sent. A message written for a question or turn
//    that changed meanwhile still goes, with a note saying so (CHANGED_TARGET_NOTE).
// 4. An event is applied once: its dedupe mark, its messages and the last applied event id move in one
//    transaction, and the last applied event id never moves back. A turn has one cost record: snapshots replace
//    it until the final cost settles it. An event without a turn id is never attributed to a turn.
// 5. One window drives a project's Chats (the project window lock). Writes and remote calls carry the Chat's Pine
//    session generation (core/pineSessionGeneration.ts): a pass of a session that was since replaced cannot write.
// 6. "Reconnected" means the remote session and its Task matched; a session found gone at any
//    point ends, keeps its history and waits for the person before a new session starts.
// 7. The person's Stop (Code-OSS's own, the request's cancellation) is the one cancel: a send not yet admitted stops
//    before it puts or starts anything (its AbortSignal), and a turn Pine runs is cancelled (cancelTurn); what it
//    changed then lands as any turn's does. Nothing steers a turn: a message that arrives while one runs waits for it
//    and then goes as the answer or a new run.
// 8. At a Pine turn's end, however it ended, what its agent changed in the drama's folder on the Computer lands in the
//    project folder as one commit, and the turn is settled, under the same generation; how it ended is Pine's turn
//    result. A collection that fails is logged and shown, and is taken up again at the next send or follow.
// 9. Files the person attaches go into the project folder and up with the Chat's next run; the Studio's note about them
//    is recorded as the Studio's text.
// No vscode import.

import { CHANGED_TARGET_NOTE } from './instructions';
import { randomUUID } from 'node:crypto';
import { AccountError, ConnectionLostError, PINE_ACCOUNT_URL, IDLE_WAITING_SECONDS, IDLE_WORKING_SECONDS, MissingError, NoPineError, OtherPineError, START_WAIT_SECONDS, StartNotConfirmedError, StartTimeoutError, UnconfirmedError, endpointHost, type ComputerSecrets, type IdlePolicy, type PineConnection, type PineEvent, type PinePort, type SecretVault, type PineSession, type TurnView } from './pinePort';
import { projectIdentity, projectPlaceOf, projectRootOf } from './projectPlace';
import { entryFor, type Entry } from './binding';
import { givenBack, refusalLine } from './refusal';
import { collectTurn, forgetCaptures, putTurnFiles, turnRecordOf, type ComputerSession, type SentTurn, type TurnRecord } from './turn';
import { applyPersonChange } from './applyChange';
import { DRAMA_FOLDER, PERSON_ATTACHMENTS_FOLDER } from './protocol';
import { type ProjectPlace, unusedName, within } from './placement';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { withoutRepeatedQuestion } from './askedOnce';
import { EXTRACTED, extractText, textName, type Extraction } from './extract';
import { PineSessionGenerations, PineSessionReplacedError } from './pineSessionGeneration';
import { type Chat, type Message, type SavedSend, type Store } from './store';

export type Update =
	| { kind: 'progress'; text: string }
	/** One step of the agent's work; later updates with the same id are the same step (chat-progress.md, option B). */
	| { kind: 'activity'; id: string; text: string; state: string }
	| { kind: 'markdown'; text: string; question?: boolean }
	/** A message the Studio did not send, given back as typed (D72): drawn as it is, never through the agent's link rewriting. */
	| { kind: 'unsent'; text: string }
	/** The cost line of a turn that ended; the cost itself is saved either way, only showing the line is optional. */
	| { kind: 'usage'; text: string }
	/** The session ended; the person decides whether a new one starts. */
	| { kind: 'sessionEnded'; text: string }
	/** A result that is not used: one native warning with its reason, its detail in Output (D43). */
	/** The Computer did not start in time; `text` says what was observed. A send gives its message back (unsentLine). */
	| { kind: 'notStarted'; text: string }
	/** Pine could not be reached for the follow's whole limit: the line offers Reload Window, which attaches again. */
	| { kind: 'unreachable'; text: string };

/** What became of a request to stop one session's Computer. */
export class BusyElsewhereError extends Error {
	readonly name = 'BusyElsewhereError';
}

/** A message that arrives while a turn runs waits for it. */
const WAITING = '_Pine Computer is still running this turn; your message will be sent when it finishes._';

/** A picture the person adds goes to person-attachments/ (placeFiles): the image types the Studio shows. */
const PICTURE = /\.(png|jpe?g|webp)$/i;

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
	 * and imports only for a Chat of the project it holds; a Chat of another project is left to the window
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
		/** Each Chat's project folder is made under it. */
		projectsRoot: string;
	};
	/**
	 * The protocol client (doc/protocol.md): each run or answer is a turn. `storage` holds each project's record of its
	 * turns (`projects/`, turn.ts), outside the project's folder.
	 */
	protocol?: { readonly storage: string };
	/**
	 * How long the event stream stays open once a turn has ended, for the events Pine sends after the turn reads ended;
	 * TURN_END_GRACE_MS unless a test, whose fake Pine has sent them all by then, makes it 0.
	 */
	turnEndGraceMs?: number;
	/** The pause between two collections of a running turn (COLLECT_EVERY_MS unless a test makes it short). */
	collectEveryMs?: number;
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
 * How often a running turn's files are collected into the project folder (turn.ts collectTurn): each collection is one
 * exec, which Pine runs beside the agent's own commands and counts as the Computer's activity (PineSandbox
 * session-coordinator pkg/server/exec.go:85).
 */
const COLLECT_EVERY_MS = 15_000;
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
	/** The publication pass this window runs now for each Chat, ended when it settles (collect). */
	private readonly settling = new Map<string, Promise<void>>();
	/** Chats whose remote session this process has verified. */
	private readonly verified = new Set<string>();
	/** The idle timeout last applied to each Chat's Computer by this window; a restart asks again. */
	private readonly idleApplied = new Map<string, number>();
	/** The idle-timeout policy of the Pine project, by endpoint, read once (open-pinedrama `limits`). */
	private readonly idlePolicies = new Map<string, Promise<IdlePolicy>>();

	constructor(private readonly options: ChatServiceOptions) {
		this.store = options.store;
		this.port = options.port;
		this.vault = options.vault;
		this.log = options.log ?? (() => undefined);
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

	/** The paths (`drama/…`) of the files the Chat's latest settled turn changed (turn.ts, TurnRecord). */
	latestTurnFiles(key: string): string[] {
		const root = this.projectRoot(key);
		const record = this.options.protocol && root ? this.turnRecord(root) : undefined;
		const latest = record?.latestSettled(key);
		return latest ? record!.settled(latest.turn)!.files.map(path => `${DRAMA_FOLDER}/${path}`) : [];
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
	 * first message binds a new session to it. Only the person's Stop (`signal`) stops its work: a send not yet admitted
	 * starts no turn, and a turn that runs is cancelled; the history shows how it ended.
	 */
	submit(key: string, text: string, label: string, folder?: string, signal?: AbortSignal): AsyncGenerator<Update> {
		return this.submitOnce(key, text, label, folder, [], signal);
	}

	/** `signal`: the person's Stop of this send; once aborted, nothing more goes up and no turn is started (sendTask). */
	private async *submitOnce(key: string, text: string, label: string, folder: string | undefined, files: readonly ChatFile[] = [], signal?: AbortSignal): AsyncGenerator<Update> {
		// Capture the question/turn before waiting in the local send queue; a preceding reply may ask a new question.
		const atSend = this.store.chat(key);
		const intendedAtSend = atSend ? intent(atSend) : { kind: 'run' as const, target: null };
		const release = await this.queueExecution(key);
		try {
			// A restart while this message waited (a preceding send's item g) ended every question and turn it could be
			// for, with their session. It goes as the restarting message does, against what the new session starts from
			// (replacePineSessionAndSend), and is held to it: a question the new session asks meanwhile is not what it answers.
			const restarted = (this.store.chat(key)?.pine_session_name ?? null) !== (atSend?.pine_session_name ?? null);
			const ending: Ending = { said: false };
			// A message is never lost on the way: one that was neither recorded as a send (ending.op) nor given back
			// already is given back when the send ends, whichever way it ends.
			const shown = { given: false };
			try {
				yield* givingBack(this.sendPersonMessageToPine(key, text, label, folder, restarted ? { kind: 'run', target: null } : intendedAtSend, files, ending, undefined, false, signal), shown);
				if (ending.said) {
					// The session ended on Pine's evidence before the message reached it. Sending is the person's
					// explicit action, so the Studio starts the agent again and sends the same message there, in this send (the
					// person, 2026-11-05): no "not sent" line.
					yield* givingBack(this.replacePineSessionAndSend(key, text, label, folder, files, ending, signal), shown);
				}
			} catch (error) {
				if (!ending.op && !shown.given) { yield unsentLine(text, files, (error as Error).message.replace(/[.\s]+$/, '')); }
				// A Pine account problem is said in that one line, which tells the person where to fix it; nothing is retried.
				if (error instanceof AccountError) { this.log(`${key}: ${error.problem}: ${error.message}`); return; }
				throw error;
			}
			if (!ending.op && !shown.given) { yield unsentLine(text, files, 'the line above says why'); }
		} finally {
			release();
		}
	}

	/**
	 * `resends` is the operation of this same message that a session's end kept from reaching Pine (replacePineSessionAndSend): the
	 * person's words and decision recorded with it become this operation's, so the Chat shows one message, sent once.
	 * `changedBefore` says that what it was written for changed before that end, so its note goes with it here too.
	 */
	private async *sendPersonMessageToPine(key: string, text: string, label: string, folder: string | undefined, intendedAtSend: ReturnType<typeof intent>, files: readonly ChatFile[], ending: Ending, resends?: string, changedBefore = false, signal?: AbortSignal): AsyncGenerator<Update> {
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
		if (entry && entry.kind !== 'go') {
			// One line, and the message given back under it.
			yield { kind: 'unsent', text: `_${refusalLine(entry.kind === 'moved' ? { kind: 'rootChanged' } : entry)} Your message is below, to send again._\n\n${givenBack(text, attachedNames(files))}` };
			return;
		}
		if (!conv) {
			this.store.tx(() => this.store.insertChat({ key, env: PINE_ENV, endpoint: env.endpoint, label, secret_ref: secretRef(key) }));
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
		if (!(yield* unsent(this.checkUnconfirmedSendsWithPine(key, env, epoch, session, signal)))) {
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
			yield* unsent(this.streamPineTurnEvents(key, env, epoch, session, signal));
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
		if (at.kind !== intended.kind || at.target !== intended.target) {
			changed = true;
			ending.changed = true;
		}
		// Files the person added are in the drama's folder already (placeFiles): the request carries them, the note names them.
		const note = placedAttachments.length ? `Pine Drama Studio: the person added to the drama's folder: ${placedAttachments.join(', ')}.` : undefined;
		const noted = [text, changed ? CHANGED_TARGET_NOTE : undefined, note].filter((part): part is string => !!part).join('\n\n');
		// Said before anything is recorded: from the record to the run nothing yields, so a Stop leaves no send to resend.
		if (changed) {
			yield { kind: 'markdown', text: '\n\n_What your message was written for changed while it waited (shown above), so it goes as a new message, with a note telling the agent so._\n\n' };
		}
		// A run or an answer is a turn: the drama's folder on the Computer holds the project before the message that starts
		// it is sent, and the turn id is the message's Idempotency-Key.
		const opId = randomUUID();
		try {
			await this.sendTask(key, env, epoch, session, opId, signal);
		} catch (error) {
			// The session is gone, as a run finds it (send): its end is said, and the message goes to the agent started again.
			if (error instanceof MissingError) {
				await this.sessionLost(key, epoch, env, session);
				ending.said = true;
				return;
			}
			this.log(`${key}: task ${opId} could not be prepared: ${(error as Error).stack ?? error}`);
			yield unsentLine(text, files, `the project could not be sent to the Computer (${(error as Error).message.replace(/[.\s]+$/, '')})`);
			return;
		}
		const op: SavedSend = { id: opId, chat_key: key, text: noted, state: 'pending', turn_id: null, error: null, created_at: '' };
		this.write(key, epoch, () => {
			this.store.insertSavedSend(op);
			// The person's message is recorded as typed; the Studio's notes, in messages of their own.
			const moved = resends ? this.store.moveMessages(resends, op.id, ['prompt']) : [];
			if (!moved.includes('prompt')) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'prompt', text, cost: null, currency: null });
			}
			if (note) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'instructions', text: note, cost: null, currency: null });
			}
			if (changed) {
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: op.id, kind: 'instructions', text: CHANGED_TARGET_NOTE, cost: null, currency: null });
			}
		});
		ending.op = op.id;
		// A Stop that reached the run after its last check (sendTask) cancels the turn the run started: here when the reply
		// ends before its follow begins, by the follow itself once it has begun (streamPineTurnEvents).
		let following = false;
		try {
			const result = yield* unsent(this.send(key, env, epoch, session, op));
			if (result.kind === 'sent') {
				following = true;
				yield* this.streamPineTurnEvents(key, env, epoch, session, signal);
			}
		} finally {
			if (signal?.aborted && !following) { await this.stopTurn(key); }
		}
	}


	/** Streams the turn that is running into the Chat, e.g. when a restarted Studio opens it. */
	async *attachChatToPineTurn(key: string, signal?: AbortSignal): AsyncGenerator<Update> {
		const conv = this.store.chat(key);
		// A Chat that is not running can still owe the folder the result of a task that ended before a restart.
		if (!conv || (conv.state !== 'running' && !this.hasUnfinishedTurnFollowUp(key))) {
			return;
		}
		const env = this.pineOf(conv);
		const epoch = this.pineSessionGeneration(key);
		// Owed results first, before anything starts: from the session they ran in, while Pine still has it.
		yield* this.collectResultsFromPine(key, env, epoch);
		if (conv.pine_session_state !== 'open' || conv.state !== 'running') {
			return;
		}
		const session = yield* this.ensureLivePineSession(key, env, epoch);
		if (!session) {
			return;
		}
		if (conv.state === 'running' && (yield* this.checkUnconfirmedSendsWithPine(key, env, epoch, session, signal))) {
			yield* this.streamPineTurnEvents(key, env, epoch, session, signal);
		}
	}

	/** Whether a task of the Chat ended without its result being published (local first, 6.2). */
	hasUnfinishedTurnFollowUp(key: string): boolean {
		return this.owedTurns(key).length > 0;
	}

	/**
	 * At start: settles every ended turn that is not settled, in each Chat whose session is open, as main's
	 * `unsettledTurns()` does (follow.ts:190). No message is sent. A Chat another window holds is left to it.
	 */
	async resumeUnfinishedTurnFollowUps(): Promise<void> {
		// Not a Chat of another project: that one is its own window's (holdsElsewhere).
		for (const conv of this.store.chats().filter(c => !this.holdsElsewhere(c.key))) {
			// An ended session's owed turns are taken up too: each is collected or found lost, so none holds up the next.
			if (!this.hasUnfinishedTurnFollowUp(conv.key)) {
				continue;
			}
			try {
				// Not a reply the person sees: what it says is logged.
				for await (const update of this.attachChatToPineTurn(conv.key)) {
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
	private async *replacePineSessionAndSend(key: string, text: string, label: string, folder: string | undefined, files: readonly ChatFile[], ending: Ending, signal?: AbortSignal): AsyncGenerator<Update> {
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
			yield* this.sendPersonMessageToPine(key, text, label, folder, intent(conv), files, ending, resends, changed, signal);
			if (ending.said) { yield unsentLine(text, files, 'the new session ended before it took the message'); }
			return;
		}
		const why = failure ?? (said.map(update => update.text.replace(/\*\*The agent was not started again:\*\*\s*/, '').trim()).filter(Boolean).join(' ') || 'it did not start');
		yield unsentLine(text, files, `the agent could not be started again: ${why.replace(/[.\s]+$/, '')}`);
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
		// the chat opening) is not that: it collects or settles the ended session's turns, and fencing it fails it as a
		// takeover, leaving its result owed and this restart refused for it. It ends first.
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
		// A collection that failed inside collect is said there and stays owed, not thrown: the same case.
		const owed = this.owedTurns(key).map(t => t.pineTurn);
		if (owed.length) {
			notStarted();
			this.log(`${key}: earlier results are not collected yet (turns ${owed.join(', ')}), so no new session was started`);
			yield notCollected(`turn ${owed.join(', ')}`);
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
		secrets.workdir = created.workdir;
		// The next message brings the drama's files in (putTurnFiles).
		const notice = `The agent starts again on Computer ${conv.computer_id}. It does not remember earlier turns of this session, and its working folder is empty: your next message brings the project in from your folder.`;
		await this.publish(key, epoch, secrets, { computer_state: 'running', pine_session_name: created.name, pine_session_state: 'open', task_id: null, last_applied_event_id: null, state: 'idle', current_turn_id: null, question_turn_id: null }, () => {
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
			secrets.workdir = created.workdir;
			await this.publish(key, epoch, secrets, { pine_session_name: created.name, pine_session_state: 'open' });
			this.verified.add(key);
			conv = this.store.chat(key)!;
		}
		if (!secrets.sessionToken || !conv.pine_session_name) {
			yield* this.missingCredentials(key, epoch, conv);
			return undefined;
		}
		const session: PineSession = { credentials: secrets.credentials, binding: secrets.binding, name: conv.pine_session_name, token: secrets.sessionToken, ...secrets.workdir ? { workdir: secrets.workdir } : {} };
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
			const turn = await this.held(key, epoch, () => this.port.run(env, session, op.text, op.id));
			this.sent(key, epoch, op, turn);
			yield* this.tendIdle(key, env, epoch, session);
			return { kind: 'sent', turn };
		} catch (error) {
			if (error instanceof UnconfirmedError) {
				this.write(key, epoch, () => this.store.updateSavedSend(op.id, { state: 'unknown', error: error.message }));
				yield { kind: 'markdown', text: `_Pine did not confirm the run; it is resent safely before the next message._` };
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
				this.store.addMessage({ chat_key: key, turn_id: null, saved_send_id: null, kind: 'notice', text: `The run failed: ${(error as Error).message}`, cost: null, currency: null });
			});
			yield { kind: 'markdown', text: `**The run failed:** ${(error as Error).message}` };
			return { kind: 'failed' };
		}
	}


	// ---- the project's place ----

	/**
	 * Where a session's project is on this desktop: its bound folder's project root, or its folder under the extension's
	 * storage for a session made before binding (`projectRootOf`). Undefined without a
	 * project store (tests that keep no files).
	 */
	projectRoot(key: string): string | undefined {
		const files = this.options.files;
		return files && projectRootOf(files.projectsRoot, this.store.chat(key) ?? { key, folder: null });
	}

	/** The session's project root and the folder nothing may leave; undefined without a project store. */
	projectPlace(key: string): ProjectPlace | undefined {
		const files = this.options.files;
		return files && projectPlaceOf(files.projectsRoot, this.store.chat(key) ?? { key, folder: null });
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
	submitWithFiles(key: string, text: string, label: string, files: readonly ChatFile[], folder?: string, signal?: AbortSignal): AsyncGenerator<Update> {
		return this.submitOnce(key, text, label, folder, files, signal);
	}

	/**
	 * The person's Stop, and the one owner of what follows it: Pine cancels the Chat's turn (cancelTurn), then the turn is
	 * followed to its end and collected here, whatever became of the reply the Stop closed (Code-OSS stops reading a
	 * cancelled request's reply, pineSessions.ts reply), so what it changed reaches the project while the Computer still
	 * has it. That pass waits in the Chat's line behind the reply it closed, so one follower at a time follows the turn,
	 * and it runs whether or not Pine confirmed the cancel: a cancel whose answer was lost may still have ended the turn.
	 */
	private async stopTurn(key: string): Promise<void> {
		try {
			await this.cancelTurn(key);
		} finally {
			this.followStoppedTurn(key);
		}
	}

	/** stopTurn's pass: the Chat's turn followed to its end and collected, in the Chat's line, logged. */
	private followStoppedTurn(key: string): void {
		void (async () => {
			const release = await this.queueExecution(key);
			try {
				// Not a reply the person sees: what it says is in the Chat's history, and logged.
				for await (const update of this.attachChatToPineTurn(key)) {
					if (update.kind !== 'progress') { this.log(`${key}: after Stop: ${update.text.trim()}`); }
				}
			} finally {
				release();
			}
		})().catch(error => this.log(`${key}: after Stop, the turn could not be followed to its end: ${(error as Error).stack ?? error}`));
	}

	/**
	 * Pine cancels the Chat's turn, the one it runs or that waits on a question (PinePort.cancel). A Chat with no turn of
	 * its own running has nothing to cancel.
	 */
	private async cancelTurn(key: string): Promise<void> {
		const conv = this.store.chat(key);
		if (!conv?.current_turn_id || !conv.pine_session_name || (conv.state !== 'running' && conv.state !== 'needs_input')) {
			return;
		}
		const secrets = await this.secrets(conv);
		if (!secrets?.binding || !secrets.sessionToken) {
			return;
		}
		this.log(`${key}: Stop: cancelling turn ${conv.current_turn_id}`);
		await this.port.cancel(this.pineOf(conv), { credentials: secrets.credentials, binding: secrets.binding, name: conv.pine_session_name, token: secrets.sessionToken }, conv.current_turn_id);
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
	 * Places the person's files in the project's folder (doc/protocol.md section 3), as one person change through the one
	 * landing (applyChange.ts applyPersonChange). A picture goes to `person-attachments/<id>.<ext>`, for the agent to look
	 * at: it is no object's file. Any other file goes to `inputs/<name>`, a name not taken there (`2-<name>`, …); a Word
	 * or PDF file also gets its text beside it as `inputs/<stem>.txt`, since drama-cli reads a screenplay as UTF-8 text
	 * only (core/extract.ts).
	 */
	private async placeFiles(key: string, paths: readonly string[]): Promise<{ placed: string[]; unread: { name: string; why: string }[] }> {
		const root = this.projectRoot(key);
		if (!root) { throw new Error('this session has no drama folder to place the files in'); }
		const files = new Map<string, Buffer | string>();
		const unread: { name: string; why: string }[] = [];
		const free = (name: string) => unusedName(join(root, 'inputs'), name, n => `${n}-${name}`, [...files.keys()].filter(path => path.startsWith('inputs/')).map(path => basename(path)));
		// Named inside the write queue, as the folder is when the files land.
		await applyPersonChange(root, 'Your files for the chat', async () => {
			for (const path of paths) {
				if (PICTURE.test(path)) {
					files.set(`${PERSON_ATTACHMENTS_FOLDER}/${randomUUID()}${extname(path).toLowerCase()}`, readFileSync(path));
					continue;
				}
				const name = free(basename(path));
				const bytes = readFileSync(path);
				files.set(`inputs/${name}`, bytes);
				if (EXTRACTED.test(name)) {
					let read: Extraction;
					try {
						read = await extractText(name, bytes);
					} catch (error) {
						read = { complete: false, why: `it could not be read: ${(error as Error).message}` };
					}
					if (read.complete) {
						files.set(`inputs/${free(textName(name))}`, read.text);
					} else {
						unread.push({ name, why: read.why });
					}
				}
			}
			return files;
		});
		const placed = [...files.keys()];
		this.log(`${key}: placed ${placed.join(', ') || 'nothing'}${unread.length ? `; text not read: ${unread.map(u => `${u.name} (${u.why})`).join('; ')}` : ''}`);
		return { placed, unread };
	}






	private sent(key: string, epoch: number, op: Pick<SavedSend, 'id'>, turn: TurnView): void {
		this.write(key, epoch, () => {
			this.store.noteTurn(key, turn.turnId);
			this.store.updateSavedSend(op.id, { state: 'sent', turn_id: turn.turnId, error: null });
			this.store.updateChat(key, { state: 'running', current_turn_id: turn.turnId, question_turn_id: null });
		});
		this.log(`${key}: run ${op.id} -> turn ${turn.turnId} ${turn.state}`);
	}

	/**
	 * Settles sends whose outcome was not known, oldest first, each by resending it under its id, and
	 * follows each to the end of its turn. False while one is still unconfirmed: nothing later may
	 * overtake it.
	 */
	private async *checkUnconfirmedSendsWithPine(key: string, env: PineConnection, epoch: number, session: PineSession, signal?: AbortSignal): AsyncGenerator<Update, boolean> {
		for (const op of this.store.unconfirmedSavedSends(key)) {
			yield { kind: 'progress', text: `Resending the run Pine did not confirm…` };
			const result = yield* this.send(key, env, epoch, session, op);
			if (result.kind === 'unknown') {
				return false;
			}
			if (result.kind === 'ended') {
				return true;
			}
			if (result.kind === 'sent') {
				yield* this.streamPineTurnEvents(key, env, epoch, session, signal);
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
	private async *streamPineTurnEvents(key: string, env: PineConnection, epoch: number, session: PineSession, signal?: AbortSignal): AsyncGenerator<Update> {
		// The person's Stop (`signal`) cancels the turn this follows, whenever it comes (stopTurn).
		const stop = () => void this.stopTurn(key).catch(error => this.log(`${key}: Stop: ${(error as Error).message}`));
		if (signal?.aborted) { stop(); } else { signal?.addEventListener('abort', stop, { once: true }); }
		try {
			yield* this.followTurnWithReconnects(key, env, epoch, session);
		} finally {
			signal?.removeEventListener('abort', stop);
		}
	}

	private async *followTurnWithReconnects(key: string, env: PineConnection, epoch: number, session: PineSession): AsyncGenerator<Update> {
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

		// What the turn has changed so far comes into the project folder while it runs, until it ends.
		const collecting = this.collectWhileRunning(key, env, epoch, () => turnId!);
		const ended = (async () => {
			for (; ;) {
				let turn = await this.held(key, epoch, () => this.port.turn(env, session, turnId!, TURN_WAIT_MS));
				touched(turn);
				while (turn.state === 'answered' && turn.nextTurnId) {
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
			void collecting.stop();
			await new Promise(resolve => setTimeout(resolve, this.options.turnEndGraceMs ?? TURN_END_GRACE_MS));
			stream.abort();
			await pump;
			finished = true;
			wake?.();
		}, async (error) => {
			void collecting.stop();
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
				// progress, and the result and its files come from the turn and the drama's folder on the Computer. Retried instead,
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
			const ending = this.composeTurnEnding(key, epoch, last);
			// Collected as every other pass: a second follower of the same turn in this window (the resume at start and
			// Chat's follow) waits in the line, then finds the turn settled and says only its ending.
			yield* this.collectResultsFromPine(key, env, epoch, ending);
			yield* this.tendIdle(key, env, epoch, session);
			return undefined;
		} finally {
			stream.abort();
			void collecting.stop();
		}
	}

	/**
	 * Collects a running turn on a timer (COLLECT_EVERY_MS), each collection in the Chat's line (runOneCollectionPerChat),
	 * so none overlaps another or the turn end's; a tick while one runs is skipped, not queued. It writes the turn's files
	 * into the folder with no commit (turn.ts collectTurn, not last). Stopped when the turn ends or its follow does.
	 */
	private collectWhileRunning(key: string, env: PineConnection, epoch: number, turnId: () => string): { stop(): Promise<void> } {
		let stopped = false;
		let wake: (() => void) | undefined;
		const running = (async () => {
			const pause = () => new Promise<void>(resolve => {
				if (stopped) { resolve(); return; }
				const timer = setTimeout(resolve, this.options.collectEveryMs ?? COLLECT_EVERY_MS);
				wake = () => { clearTimeout(timer); resolve(); };
			});
			// A pause asked for once it is stopped ends at once, so no timer outlives the stop.
			for (await pause(); !stopped; await pause()) {
				if (this.settling.has(key)) { continue; }
				try {
					for await (const _ of this.runOneCollectionPerChat(key, () => this.collectRunningTurn(key, env, epoch, turnId()))) { /* a running turn's collection says nothing */ }
				} catch (error) {
					if (error instanceof PineSessionReplacedError) { return; }
					this.log(`${key}: turn ${turnId()}'s files could not be collected while it runs: ${(error as Error).message}`);
				}
			}
		})();
		return { stop: async () => { stopped = true; wake?.(); await running; } };
	}

	/** collectWhileRunning's pass: each sent turn the running Pine turn carries, not settled, collected (not last). */
	private async *collectRunningTurn(key: string, env: PineConnection, epoch: number, pineTurn: string): AsyncGenerator<Update> {
		const root = this.projectRoot(key);
		if (!this.options.protocol || !root) { return; }
		const record = this.turnRecord(root);
		for (const op of this.store.savedSendsOfTurn(key, pineTurn)) {
			const sent = record.sentTurn(op.id);
			if (!sent || record.settled(op.id)) { continue; }
			this.inBoundFolder(key, root);
			const at = await this.turnSession(key, env, sent.session);
			if (!at) { continue; }
			const ids = { computer: this.store.chat(key)?.computer_id ?? '', session: sent.session, turn: pineTurn };
			const collected = await this.held(key, epoch, () => collectTurn(at, root, ids, { last: false }));
			if (collected.files.length) { this.changed(key); }
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
			// How the turn ended is Pine's turn state (its agent turns).
			switch (turn.state) {
				case 'needs_input':
					// The question is the turn result's summary, which Pine's turn gives as its question.
					final('question', turn.question);
					this.store.updateChat(key, { state: 'needs_input', question_turn_id: turn.turnId });
					break;
				case 'completed':
					if (turn.summary) { final('result', turn.summary); }
					this.store.updateChat(key, { state: 'idle', question_turn_id: null });
					break;
				case 'canceled':
					final('result', `You stopped this turn. ${turn.summary}`.trim());
					this.store.updateChat(key, { state: 'idle', question_turn_id: null });
					break;
				default:
					final('failed', `The work broke off${turn.terminalReason ? ` (${turn.terminalReason})` : ''}. ${turn.summary}`.trim());
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
	 * the longer window while a question waits, the working one otherwise. Called when a turn ends and
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
		const waiting = conv.state === 'needs_input';
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
	 * Puts a turn's files on the Chat's Computer before its message is sent (turn.ts putTurnFiles), and records the turn
	 * with the drama's folder there as its agent will find it. Nothing when the Chat has no folder: its message then goes
	 * as it is.
	 */
	private async sendTask(key: string, env: PineConnection, epoch: number, session: PineSession, task: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const root = this.projectRoot(key);
		if (!this.options.protocol || !root) {
			return;
		}
		mkdirSync(root, { recursive: true });
		const record = this.turnRecord(root);
		// One turn at a time per session: the next is sent only once the last one is settled, so it starts from that
		// turn's files (owedTurns: only a turn Pine admitted can have changed any).
		const waiting = this.owedTurns(key);
		if (waiting.length) { throw new Error(`the result of the previous turn (${waiting.map(t => t.pineTurn).join(', ')}) is not in the project yet`); }
		this.inBoundFolder(key, root);
		const { seed } = await this.held(key, epoch, () => putTurnFiles({ port: this.port, env, session, signal }, root, task));
		// The last point the person's Stop keeps the turn from starting; after it the run goes, and a Stop cancels its turn.
		signal?.throwIfAborted();
		await this.held(key, epoch, () => record.send(task, key, session.name));
		this.log(`${key}: turn ${task}: the project is on the Computer as ${seed}`);
	}

	/** The folder is still the bound one: a root moved away or replaced by a link receives nothing. */
	private inBoundFolder(key: string, root: string): void {
		if (!within(this.projectPlace(key)!.boundary, root)) { throw new Error('the project leads outside its bound folder'); }
	}

	/**
	 * The session a turn ran in, while it is still the Chat's: Pine keeps a session's files only until its Computer
	 * stops (Pine's limits), so a turn whose session was replaced has nothing left to collect.
	 */
	private async turnSession(key: string, env: PineConnection, sessionName: string): Promise<ComputerSession | undefined> {
		const conv = this.store.chat(key);
		const secrets = conv && await this.secrets(conv);
		if (!conv || conv.pine_session_name !== sessionName || !secrets?.binding || !secrets.sessionToken) { return undefined; }
		return { port: this.port, env, session: { credentials: secrets.credentials, binding: secrets.binding, name: sessionName, token: secrets.sessionToken, ...secrets.workdir ? { workdir: secrets.workdir } : {} } };
	}

	/** The Studio's record of the project's turns at `root`, under the extension's storage (turn.ts, TurnRecord). */
	private turnRecord(root: string): TurnRecord {
		return turnRecordOf(this.options.protocol!.storage, root);
	}






	// ---- collecting what a turn changed ----

	/**
	 * Every collection pass of a Chat, one at a time in its line (runOneCollectionPerChat): at a followed turn's end, with
	 * the ending composeTurnEnding formatted, and the owed pass at the chat opening, the resume at start, a restart and a
	 * send. Each drains the same list, the Chat's owed turns (owedTurns), so a pass that waited behind another finds only
	 * what it left. Its caller goes on to read what is left (replaceEndedPineSession), so it does not return at once.
	 */
	private async *collectResultsFromPine(key: string, env: PineConnection, epoch: number, ending: readonly Update[] = []): AsyncGenerator<Update> {
		yield* this.runOneCollectionPerChat(key, () => this.collectOwedTurns(key, env, epoch, ending));
	}

	/**
	 * The Chat's turns owed to the project, oldest first: sent, admitted by Pine, not settled, and not the turn Pine runs
	 * now, which is collected at its end.
	 */
	private owedTurns(key: string): { readonly sent: SentTurn; readonly pineTurn: string }[] {
		const root = this.projectRoot(key);
		const conv = this.store.chat(key);
		return (this.options.protocol && root ? this.turnRecord(root).unsettled(key) : []).flatMap(sent => {
			const op = this.store.savedSend(sent.turn);
			if (!op?.turn_id || op.state === 'failed') { return []; }
			if (conv && conv.pine_session_state !== 'ended' && conv.state === 'running' && conv.current_turn_id === op.turn_id) { return []; }
			return [{ sent, pineTurn: op.turn_id }];
		});
	}

	/**
	 * collectResultsFromPine's pass: each owed turn's changes landed (turn.ts collectTurn) and the turn settled, then the
	 * ending, then what the pass said. A turn whose session Pine no longer has took its files with it (Pine keeps them only
	 * while the Computer runs): said once, and settled, so it never holds up the next. One that fails stays owed.
	 */
	private async *collectOwedTurns(key: string, env: PineConnection, epoch: number, ending: readonly Update[]): AsyncGenerator<Update> {
		const finalWords = (): Update[] => ending.map(update => update.kind === 'markdown' && update.question
			? { kind: 'markdown', text: `${update.text}\n\n_Your next message answers it._` } : update);
		const root = this.projectRoot(key);
		const owed = this.owedTurns(key);
		if (!root || owed.length === 0) {
			yield* finalWords();
			return;
		}
		const record = this.turnRecord(root);
		// The last changes of a large result take minutes after the agent's reply (B5): the Chat says so until they are in,
		// as a progress part (ChatResponseStream.progress), which the turn's last words then follow.
		yield { kind: 'progress', text: 'Bringing the turn\'s last results into your project…' };
		const shown: Update[] = [];
		const tell = (turn: string, line: string) => {
			this.store.addMessage({ chat_key: key, turn_id: turn, saved_send_id: null, kind: 'notice', text: line, cost: null, currency: null });
			shown.push({ kind: 'markdown', text: `\n\n_${line}_` });
			this.changed(key);
		};
		let current = owed[0].pineTurn;
		try {
			for (const { sent, pineTurn } of owed) {
				current = pineTurn;
				this.generations.assert(key, epoch);
				this.inBoundFolder(key, root);
				const at = await this.turnSession(key, env, sent.session);
				const ids = { computer: this.store.chat(key)?.computer_id ?? '', session: sent.session, turn: pineTurn };
				const collected = at && await this.held(key, epoch, () => collectTurn(at, root, ids, { last: true })).catch(error => {
					if (error instanceof MissingError) { return undefined; }
					throw error;
				});
				if (!collected) { await forgetCaptures(root, sent.session); }
				await record.settle(sent.turn, { files: collected?.files ?? [] });
				if (!collected) { tell(pineTurn, `The results of turn ${pineTurn} were on a Computer session that has ended, so they could not be brought into your project. Nothing is run again by itself. What Pine charged for the turn is in your Pine account at ${PINE_ACCOUNT_URL}`); }
				if (collected?.leftOut.size) {
					tell(pineTurn, `Not brought into your project, and removed from the Computer at the next turn: ${[...collected.leftOut].map(([path, why]) => `${path} (${why})`).join(', ')}`);
				}
			}
		} catch (error) {
			if (error instanceof PineSessionReplacedError) { throw error; }
			// The turn stays owed: it is collected again at the next message or restart.
			this.log(`${key}: turn ${current}'s result could not be brought in: ${(error as Error).stack ?? error}`);
			this.changed(key);
			yield* finalWords();
			yield* shown;
			yield { kind: 'markdown', text: `\n\n**The result of turn ${current} could not be brought into your project:** ${(error as Error).message}. It is tried again at your next message.` };
			return;
		}
		this.changed(key);
		yield* finalWords();
		yield* shown;
	}

	/**
	 * Runs one collection pass for the Chat in its line: it waits for the passes before it, as Code-OSS's
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
	 * Whether `key` is bound to a project this window does not hold. Such a Chat is driven and collected
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

function intent(conv: Chat): { kind: 'run'; target: string | null } | { kind: 'busy'; target: string } {
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
	return `pine.conversation.${sha256(key).slice(0, 24)}`;
}

/** `steps` as they are, noting in `shown` when one of them gave the message back (an `unsent` line). */
async function* givingBack(steps: AsyncGenerator<Update>, shown: { given: boolean }): AsyncGenerator<Update> {
	for await (const update of steps) {
		if (update.kind === 'unsent') { shown.given = true; }
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

