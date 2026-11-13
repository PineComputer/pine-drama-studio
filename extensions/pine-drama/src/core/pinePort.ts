// The narrow surface of Pine the Chat service needs. The SDK
// implementation is extensions/pine-drama/src/sdkPort.ts; tests use a fake. No vscode import.

/** The one Pine environment the Studio connects to: no name, only its endpoint and key. */
import type { ArtifactStore } from './taskArtifacts';

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
}

/**
 * Idle timeouts (open-pinedrama docs/PROPOSAL.md section 5.3, src/engine/config.ts). Work keeps a Computer running;
 * a question or review waiting for the person does not, so a waiting Computer gets longer.
 */
export const IDLE_WORKING_SECONDS = 60 * 60;
export const IDLE_WAITING_SECONDS = 3 * 60 * 60;

/**
 * How long a start waits for Pine to give the Computer (the SDK's `readyTimeoutMs`, passed rather than assumed; its
 * default is the same 300 000 ms). Pine waits for capacity meanwhile when it has none free (PineSandbox
 * specs/computer-api.yaml; lines 663-666; S1).
 */
export const START_WAIT_SECONDS = 5 * 60;

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

/** A file a turn returned (SDK `Artifact`; open-pinedrama fleet.ts `TurnFile`). */
export interface TurnFile {
	/** Relative to where Pine keeps it: the session's working directory for root `workdir`. */
	readonly path: string;
	/** Where Pine keeps it: workdir | artifact | download_quarantine | artifact_store (SDK 0.3.5 `FileRef.root`). */
	readonly root: string;
	/** The Computer whose artifact store holds it, for root `artifact_store` (SDK `FileRef.computerId`). */
	readonly computerId?: string;
	readonly sha256: string;
	readonly size: number;
	readonly type: string;
}

/** An entry of a working-directory folder (SDK `FileEntry`). */
export interface FolderEntry {
	readonly path: string;
	readonly folder: boolean;
	readonly size: number;
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
		super(`Pine did not start a Computer within ${START_WAIT_SECONDS / 60} minutes; it was still "${lastState}".`);
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
	createSession(env: PineConnection, credentials: string, binding: string, label: string): Promise<{ name: string; token: string }>;
	/** The session's Task id (undefined before its first run); MissingError when the session is gone. */
	sessionTask(env: PineConnection, session: PineSession): Promise<string | undefined>;
	/** Idempotent by `key`: a repeat returns the turn it admitted (SDK session.ts, AgentMode.run). */
	run(env: PineConnection, session: PineSession, text: string, key: string): Promise<TurnView>;
	/** Bound to the question that ended `turnId`. */
	answer(env: PineConnection, session: PineSession, turnId: string, text: string): Promise<TurnView>;
	/** The turn once it ends, or after `timeoutMs` while it runs; 0 reads it once. */
	turn(env: PineConnection, session: PineSession, turnId: string, timeoutMs: number, signal?: AbortSignal): Promise<TurnView>;
	events(env: PineConnection, session: PineSession, after: number | undefined, taskId: string | undefined, signal: AbortSignal): AsyncIterable<PineEvent>;
	/** The files the turn returned (SDK `session.listArtifacts({ turnId })`), with their SHA-256. Pine lists only what the agent returns. */
	turnFiles(env: PineConnection, session: PineSession, turnId: string): Promise<TurnFile[]>;
	/** A working-directory file as a stream (SDK `session.openFile`); NoSuchFileError when it is not there. */
	openFile(env: PineConnection, session: PineSession, path: string): Promise<ReadableStream<Uint8Array>>;
	/**
	 * A file a turn returned, read from where its root says: the working directory, or the Computer's artifact store
	 * (`client.artifacts(computerId)`). Any other root is refused by name rather than read as a working-directory path.
	 */
	openReturned(env: PineConnection, session: PineSession, file: TurnFile): Promise<ReadableStream<Uint8Array>>;
	/** Puts a file under the session's `attachments/` (SDK `session.writeFile`; `name` is one file name). Safe to repeat. */
	writeFile(env: PineConnection, session: PineSession, name: string, content: Uint8Array): Promise<void>;
	/** A working-directory folder's entries (SDK `session.listFiles({ path })`); NoSuchFileError when it is not there. */
	listFolder(env: PineConnection, session: PineSession, folder: string): Promise<FolderEntry[]>;
	/** The project's idle-timeout policy (`client.projectPolicy()`); allocates nothing. */
	idlePolicy(env: PineConnection): Promise<IdlePolicy>;
	/**
	 * Changes the running Computer's idle window (SDK `computer.setIdleTimeout`) and returns what Pine applied. It is
	 * refused with a conflict or fails when the outcome is uncertain: the caller reports that, never assumes it applied.
	 */
	setIdleTimeout(env: PineConnection, session: Pick<PineSession, 'credentials' | 'binding'>, seconds: number): Promise<number>;
	stopComputer(env: PineConnection, credentials: string, binding: string): Promise<void>;
	/**
	 * The Computer's artifacts (SDK `client.artifacts(computerId)`): a task's input set goes up and its result comes back
	 * through them (core/taskArtifacts.ts). They outlive a stop, so a stopped Computer's results are read with no restart,
	 * but not a deletion (UnknownComputerError, seen on pine-dev 2026-11-03): this port has no way to delete a Computer.
	 */
	artifacts(env: PineConnection, computerId: string): Promise<ArtifactStore>;
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
