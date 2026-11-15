// The narrow surface of Pine the Chat service needs. The SDK
// implementation is extensions/pine-drama/src/sdkPort.ts; tests use a fake. No vscode import.

import { START_WAIT_SECONDS } from './tuning';

/** The one Pine environment the Studio connects to: no name, only its endpoint and key. */
export interface PineConnection {
	readonly endpoint: string;
	readonly apiKey: string;
	readonly controlHost?: string;
}

/** Serialized SDK handles. Whoever holds them controls the Computer: kept in the secret vault. */
export interface ComputerSecrets {
	readonly credentials: string;
	binding?: string;
	sessionToken?: string;
	/** The session's working directory, as its shell printed it before any turn (PineSession.workdir). */
	workdir?: string;
}

/**
 * What the environment's project allows of a Computer's idle timeout (SDK `client.projectPolicy()`): without a lifetime
 * policy (`lifecycle` null) the timeout is fixed at start; with one it may change up to `maxIdleTimeoutSeconds`.
 */
export interface IdlePolicy {
	readonly adjustable: boolean;
	readonly maxIdleSeconds: number | null;
}

export interface PineSession {
	readonly credentials: string;
	readonly binding: string;
	readonly name: string;
	readonly token: string;
	/**
	 * The session's working directory, absolute, as `pwd` printed it right after the session was made: the shell keeps
	 * the directory the agent last went to (PineSandbox components/execd/pkg/runtime/bash_session.go:384-390), so every
	 * exec names it. Absent for a session an earlier Studio made, which runs no exec.
	 */
	readonly workdir?: string;
}

export interface TurnView {
	readonly turnId: string;
	/** running | canceling | needs_input | answered | completed | failed | canceled */
	readonly state: string;
	readonly question: string;
	readonly summary: string;
	readonly nextTurnId: string;
	readonly terminalReason: string;
	readonly cost: { readonly total: number | null; readonly currency: string } | null;
	/**
	 * The turn's place in its Task's ordered event log (SDK `AgentTurn.lastEventId`): every later ending of the same turn
	 * has a larger one, as a cancel that closes a waiting question appends a second terminal result and moves it there
	 * (PineSandbox session-coordinator/pkg/taskbroker/turns.go, the fold's `closesFoldedQuestion`; broker.go
	 * `cancelQuestion`). It orders a turn's endings only: an answer or revised usage does not move it (publicturns.go).
	 */
	readonly lastEventId: number;
}

export interface PineEvent {
	readonly eventId: number;
	readonly taskId: string;
	readonly turnId: string;
	readonly kind: 'progress' | 'activity' | 'result' | 'usage' | 'other';
	readonly text: string;
	readonly state?: string;
	/** An `activity` event's step id; the step's events are upserts by it (SDK `AgentActivity`). */
	readonly activityId?: string;
	readonly cost?: number | null;
	readonly currency?: string;
}

/** The request may or may not have reached Pine: its outcome is unknown. */
export class UnconfirmedError extends Error {
	readonly name = 'UnconfirmedError';
}

/**
 * The working directory has no such file or folder (HTTP 404, as open-pinedrama's settle tests it). Not MissingError,
 * which means the Computer, session or task is gone.
 */
export class NoSuchFileError extends Error {
	readonly name = 'NoSuchFileError';
}

/**
 * Pine did not start the Computer within START_WAIT_SECONDS (SDK `ReadyTimeoutError`). The SDK gives the last state it
 * saw, not Pine's reason, so neither does this.
 */
export class StartTimeoutError extends Error {
	readonly name = 'StartTimeoutError';
	constructor(readonly sandboxId: string, readonly lastState: string) {
		super(`Pine had no Computer ready within ${START_WAIT_SECONDS / 60} minutes. Try again in a minute`);
	}
}

/**
 * Pine did not confirm this start. Either another start of the same Computer was accepted first (SDK
 * `BindingRevisionConflictError`), or Portal committed this start's revision but the attach did not complete (SDK
 * `AttachAuthorizationCommittedError`, after which the SDK shuts the Computer down best-effort). The winner's binding is
 * not returned, and the SDK's documented model is to load the binding that worker saved and never to retry
 * automatically. The Computer stays reserved as `creating`; only the person's next explicit send or restart starts it
 * again, which reconciles it through Stop by id (SdkPort.ensureComputer).
 */
export class StartNotConfirmedError extends Error {
	readonly name = 'StartNotConfirmedError';
	constructor(detail: string) {
		super(`Pine did not confirm this start of the Computer (${detail}).`);
	}
}

/** Where the person checks their Pine account: keys, permissions, credits and limits. */
export const PINE_ACCOUNT_URL = 'https://console.pinecomputer.io';

/** The Pine account problems the person can fix, each with its one line (AccountError). */
export type AccountProblem = 'key' | 'permission' | 'noMedia' | 'credits' | 'spendLimit' | 'suspended' | 'rateLimited' | 'capacity';

const ACCOUNT_LINES: Record<AccountProblem, string> = {
	key: `Pine does not accept this project's API key: it is unknown or was revoked. Check the key in your Pine account at ${PINE_ACCOUNT_URL}`,
	permission: `this project's API key is not allowed to do this. Check the key's permissions in your Pine account at ${PINE_ACCOUNT_URL}`,
	noMedia: `this Pine project cannot generate media, so the agent cannot make a drama. Turn on media generation for the project in your Pine account at ${PINE_ACCOUNT_URL}`,
	credits: `your Pine organization is out of credits. Add credits in your Pine account at ${PINE_ACCOUNT_URL}`,
	spendLimit: `this Pine project has reached its monthly spend limit. Raise the limit in your Pine account at ${PINE_ACCOUNT_URL}`,
	suspended: `this Pine project is suspended. See your Pine account at ${PINE_ACCOUNT_URL}`,
	rateLimited: 'Pine is receiving too many requests from this project. Try again in a minute',
	capacity: 'this Pine project already runs as many Computers as it may at once. Try again in a minute, once one has stopped',
};

/**
 * A problem with the person's Pine account or project that only they can fix (the console) or that passes (a rate limit).
 * Its message is the one line the person reads; nothing is retried by itself, and a refused paid call is never repeated.
 */
export class AccountError extends Error {
	readonly name = 'AccountError';
	constructor(readonly problem: AccountProblem) {
		super(ACCOUNT_LINES[problem]);
	}
}

/** The remote resource (Computer, session, task) no longer exists. */
export class MissingError extends Error {
	readonly name = 'MissingError';
}

/**
 * A read got no answer from Pine: the network or Pine's host was unreachable, or the SDK's own retries ran out (its lost
 * responses: ConnectionError, TimeoutError, StreamLostError and 408/502/503/504). Nothing is known about the resource,
 * so it is neither gone nor changed; a follower reads it again (streamPineTurnEvents).
 */
export class ConnectionLostError extends Error {
	readonly name = 'ConnectionLostError';
}

export interface PinePort {
	newCredentials(): Promise<{ id: string; serialized: string }>;
	/**
	 * Brings the Computer these credentials name to running and returns its binding: created when
	 * Pine does not know it (a create whose answer was lost), started when stopped. Safe to repeat. It waits at most
	 * START_WAIT_SECONDS (then StartTimeoutError).
	 */
	ensureComputer(env: PineConnection, credentials: string, label: string, idleTimeoutSeconds: number): Promise<{ binding: string }>;
	/** `running`, `stopped`, … ; MissingError when Pine no longer knows the binding. */
	computerState(env: PineConnection, credentials: string, binding: string): Promise<string>;
	createSession(env: PineConnection, credentials: string, binding: string, label: string): Promise<{ name: string; token: string; workdir: string }>;
	/** The session's Task id (undefined before its first run); MissingError when the session is gone. */
	sessionTask(env: PineConnection, session: PineSession): Promise<string | undefined>;
	/** Idempotent by `key`: a repeat returns the turn it admitted (SDK session.ts, AgentMode.run). */
	run(env: PineConnection, session: PineSession, text: string, key: string): Promise<TurnView>;
	/**
	 * Asks Pine to cancel the turn (SDK `session.agent.cancel`, POST /v2/sessions/{name}/agent/cancel): a running turn is
	 * `canceling` until its run unwinds, then `canceled`; a waiting question closes and its turn ends `canceled`; an
	 * ended turn is left as it is (PineSandbox session-coordinator pkg/server/agent_turns.go, handleAgentCancelV2). Returns
	 * the turn as Pine holds it after the cancel (SDK `agent.cancel`, an `AgentTurn`).
	 */
	cancel(env: PineConnection, session: PineSession, turnId: string): Promise<TurnView>;
	/** The turn once it ends, or after `timeoutMs` while it runs; 0 reads it once. */
	turn(env: PineConnection, session: PineSession, turnId: string, timeoutMs: number, signal?: AbortSignal): Promise<TurnView>;
	events(env: PineConnection, session: PineSession, after: number | undefined, taskId: string | undefined, signal: AbortSignal): AsyncIterable<PineEvent>;
	/**
	 * Runs `command` in the session's shell, between turns or during one, without starting a turn (SDK `session.exec`),
	 * and returns its output, which is text lines; a command that exits other than 0 is thrown with what it printed.
	 */
	exec(env: PineConnection, session: PineSession, command: string, signal?: AbortSignal): Promise<string>;
	/** A working-directory file as a stream (SDK `session.openFile`); NoSuchFileError when it is not there. */
	openFile(env: PineConnection, session: PineSession, path: string): Promise<ReadableStream<Uint8Array>>;
	/** Puts a file under the session's `attachments/` (SDK `session.writeFile`; `name` is one file name). Safe to repeat. */
	writeFile(env: PineConnection, session: PineSession, name: string, content: Uint8Array): Promise<void>;
	/** The project's idle-timeout policy (`client.projectPolicy()`); allocates nothing. */
	idlePolicy(env: PineConnection): Promise<IdlePolicy>;
	/**
	 * Changes the running Computer's idle window (SDK `computer.setIdleTimeout`) and returns what Pine applied. It is
	 * refused with a conflict or fails when the outcome is uncertain: the caller reports that, never assumes it applied.
	 */
	setIdleTimeout(env: PineConnection, session: Pick<PineSession, 'credentials' | 'binding'>, seconds: number): Promise<number>;
	stopComputer(env: PineConnection, credentials: string, binding: string): Promise<void>;
}

/** Where secrets live: VS Code SecretStorage in the extension, a map in tests. */
export interface SecretVault {
	get(name: string): Promise<string | undefined>;
	store(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
}

/** An endpoint as it is shown: its host and port, without scheme or path. */
export function endpointHost(endpoint: string): string {
	return endpoint.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
}

/** No Pine environment is set up: the file names none (pineConfig.ts says why; section 3). */
export class NoPineError extends Error {
	readonly name = 'NoPineError';
	constructor() {
		super('No Pine environment is set up, so nothing was sent.');
	}
}

/** A session that began on another Pine environment than the one the Studio connects to now. */
export class OtherPineError extends Error {
	readonly name = 'OtherPineError';
	constructor(was: string, now: string) {
		super(`**This session ran on \`${endpointHost(was)}\`; the Studio now connects to \`${endpointHost(now)}\`.** Its history stays here. To continue it, set the Studio back to that Pine environment and reopen it, or start a new session.`);
	}
}
