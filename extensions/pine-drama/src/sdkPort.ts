// PinePort over the Pine SDK (@pinesandbox/computer). Each call rebuilds its handles from the
// serialized credentials, binding and session token, as open-pinedrama's pine-fleet.ts does.
// Errors map to the port's kinds: UnconfirmedError (a send may have arrived), MissingError (the remote resource is
// gone) and ConnectionLostError (a read got no answer); everything else passes through.

import type { ArtifactStore } from './core/taskArtifacts';
import { AccountError, ConnectionLostError, MissingError, NoSuchFileError, START_WAIT_SECONDS, StartNotConfirmedError, StartTimeoutError, UnconfirmedError, type FolderEntry, type IdlePolicy, type PineConnection, type PineEvent, type PinePort, type PineSession, type TurnFile, type TurnView } from './core/pinePort';

const importSdk = () => import('@pinesandbox/computer');
type Sdk = Awaited<ReturnType<typeof importSdk>>;
let loaded: Promise<Sdk> | undefined;
const sdk = () => (loaded ??= importSdk());

/** What the agent wrote, with real line breaks (open-pinedrama pine-fleet.ts, `said`). */
function said(text: string): string {
	return text.replace(/(?<!\\)(?:\\r)?\\n/g, '\n').replace(/(?<!\\)\\t/g, '\t');
}

/**
 * Pine answers 409 `/errors/computer-stopped` to a call on a Computer that is stopped or being stopped (PineSandbox
 * components/session-coordinator/pkg/server/finish.go:66, specs/coordinator-api.yaml:8704; not retryable,
 * sdks/pine-computer/contract/error-taxonomy.json:403). Pine keeps no session across a stop, so for a session this is
 * the resource being gone: MissingError, not an error to show. The SDK (0.3.5) has no ProblemType constant for it.
 */
const COMPUTER_STOPPED = '/errors/computer-stopped';
function isComputerStopped(error: unknown, s: Sdk): boolean {
	return error instanceof s.ApiError && error.is(COMPUTER_STOPPED);
}

/**
 * The resource is gone: a call's or the event stream's answer alike (F4: the stream's SandboxGoneError went unmapped). A
 * session Pine no longer has answers `/errors/session-not-found` (`ProblemType.sessionNotFound`, @pinesandbox/computer
 * 0.3.5 dist/index.js:21; not retryable, :2427), an ApiError, not a NotFoundError.
 */
function isGone(error: unknown, s: Sdk): boolean {
	return error instanceof s.NotFoundError || error instanceof s.SandboxGoneError || isComputerStopped(error, s)
		|| (error instanceof s.ApiError && error.is(s.ProblemType.sessionNotFound));
}

/**
 * No answer arrived, after the SDK's own retries: exactly what @pinesandbox/computer 0.3.5 throws for it (dist/index.js):
 * TimeoutError (:97), ConnectionError (:108) and its subclass StreamLostError (:165, the event stream's reconnect budget,
 * :2623-2668), and an ApiError of a lost-response status, 408/502/503/504 (`isLostResponseStatus`, :1948-1950; the
 * SDK's own `lostResponse`, :3323-3326, is these same three).
 */
function isLost(error: unknown, s: Sdk): boolean {
	return error instanceof s.ConnectionError || error instanceof s.TimeoutError || isLostResponse(error, s);
}

export class SdkPort implements PinePort {
	private async client(env: PineConnection) {
		const { Client } = await sdk();
		return new Client({ endpoint: env.endpoint, apiKey: env.apiKey, ...(env.controlHost ? { controlHost: env.controlHost } : {}) });
	}

	private async computer(env: PineConnection, credentials: string, binding: string) {
		const { Binding, Credentials } = await sdk();
		return (await this.client(env)).reconnectComputer(Credentials.parse(credentials), Binding.parse(binding));
	}

	private async session(env: PineConnection, s: PineSession) {
		return (await this.computer(env, s.credentials, s.binding)).adoptSession(s.name, s.token);
	}

	/** Maps SDK errors to the port's; `unconfirmed` lists the ones that leave a send's outcome unknown. */
	private async mapped<T>(call: () => Promise<T>, unconfirmed: 'run' | 'send' | 'none'): Promise<T> {
		const s = await sdk();
		try {
			return await call();
		} catch (error) {
			if (isGone(error, s)) {
				throw new MissingError((error as Error).message);
			}
			if (unconfirmed === 'run' && error instanceof s.RunUnconfirmedError) {
				throw new UnconfirmedError((error as Error).message);
			}
			if (isLost(error, s)) {
				throw unconfirmed === 'none' ? new ConnectionLostError((error as Error).message) : new UnconfirmedError((error as Error).message);
			}
			throw accountProblem(error, s) ?? error;
		}
	}

	async newCredentials() {
		const { Credentials } = await sdk();
		const credentials = await Credentials.generate();
		return { id: credentials.id, serialized: credentials.serialize() };
	}

	/**
	 * Starts the Computer whatever state it was left in, as open-pinedrama's startComputer does. Each start waits at most
	 * START_WAIT_SECONDS (computer.ts, `attach`).
	 */
	async ensureComputer(env: PineConnection, credentials: string, label: string, idleTimeoutSeconds: number) {
		const s = await sdk();
		const client = await this.client(env);
		const parsed = s.Credentials.parse(credentials);
		const options = { idleTimeoutSeconds, metadata: { app: label }, readyTimeoutMs: START_WAIT_SECONDS * 1000 };
		try {
			let computer;
			try {
				computer = await client.startComputer(parsed, options);
			} catch (error) {
				if (error instanceof s.UnknownComputerError) {
					computer = await client.createComputer({ credentials: parsed, ...options });
				} else if (error instanceof s.SandboxRetainedError) {
					await client.stopComputer(parsed.id);
					computer = await client.startComputer(parsed, options);
				} else if (error instanceof s.SandboxFailedError) {
					computer = await client.recoverComputer(parsed, options);
				} else {
					throw error;
				}
			}
			return { binding: computer.binding().serialize() };
		} catch (error) {
			if (error instanceof s.ReadyTimeoutError) {
				throw new StartTimeoutError(error.sandboxId, error.lastState);
			}
			if (error instanceof s.BindingRevisionConflictError) {
				throw new StartNotConfirmedError(`another start of it was accepted first; Pine now binds sandbox ${error.currentSandboxId}`);
			}
			if (error instanceof s.AttachAuthorizationCommittedError) {
				throw new StartNotConfirmedError(`Pine committed binding revision ${error.bindingRevision} for sandbox ${error.sandboxId}, but the attach did not complete`);
			}
			throw accountProblem(error, s) ?? error;
		}
	}

	async computerState(env: PineConnection, credentials: string, binding: string) {
		return this.mapped(async () => (await this.computer(env, credentials, binding)).status(), 'none');
	}

	async createSession(env: PineConnection, credentials: string, binding: string, label: string) {
		return this.mapped(async () => {
			const computer = await this.computer(env, credentials, binding);
			// The drama-workflow skill comes with media generation: without it the agent would make up a drama of its own at
			// the project's expense, so no session starts (open-pinedrama 58b1eb0 scheduler.ts:157-185, offersDramaSkill;
			// PineSandbox apps/portal/app/services/playground.rb:24, the media.generate opt-in).
			const skills = await computer.skills.list();
			if (!skills.some(skill => skill.name === DRAMA_SKILL && skill.enabled !== false)) { throw new AccountError('noMedia'); }
			// The agent reads and writes the Computer's artifacts: a task's request and return travel through them (doc/protocol.md, 4.1).
			const session = await computer.createSession({ label, artifactAccess: 'read_write' });
			return { name: session.name, token: session.token };
		}, 'none');
	}

	async sessionTask(env: PineConnection, s: PineSession) {
		const { ApiError, ProblemType } = await sdk();
		return this.mapped(async () => {
			try {
				return (await (await this.session(env, s)).agent.status()).taskId || undefined;
			} catch (error) {
				// A session no message has reached yet has no Task: GET /agent answers 404 task-not-found
				// (PineSandbox specs/coordinator-api.yaml, "or its task (`/errors/task-not-found`) does not exist").
				// Any other problem still fails; session-not-found is the session being gone (isGone, MissingError).
				if (error instanceof ApiError && error.problemType === ProblemType.taskNotFound) {
					return undefined;
				}
				throw error;
			}
		}, 'none');
	}

	async run(env: PineConnection, s: PineSession, text: string, key: string) {
		return this.mapped(async () => turnView(await (await this.session(env, s)).agent.run(text, { idempotencyKey: key })), 'run');
	}

	async answer(env: PineConnection, s: PineSession, turnId: string, text: string) {
		return this.mapped(async () => turnView(await (await this.session(env, s)).agent.answer(turnId, text)), 'send');
	}

	async turn(env: PineConnection, s: PineSession, turnId: string, timeoutMs: number, signal?: AbortSignal) {
		return this.mapped(async () => turnView(await (await this.session(env, s)).agent.wait(turnId, { timeoutMs, ...(signal ? { signal } : {}) })), 'none');
	}

	async *events(env: PineConnection, s: PineSession, after: number | undefined, taskId: string | undefined, signal: AbortSignal): AsyncIterable<PineEvent> {
		const agent = (await this.session(env, s)).agent;
		try {
			for await (const event of agent.events({ lastEventId: after === undefined ? '' : String(after), ...(taskId ? { expectedTaskId: taskId } : {}), frames: false, signal })) {
				const base = { eventId: event.eventId, taskId: event.taskId, turnId: event.turnId };
				const progress = event.progress();
				const activity = event.activity();
				const result = event.result();
				const usage = event.type === 'usage' ? (event.payload.usage as { cost?: { total?: unknown; currency?: unknown } } | undefined) : undefined;
				if (progress?.text) {
					yield { ...base, kind: 'progress', text: said(progress.text) };
				} else if (activity) {
					yield { ...base, kind: 'activity', text: activity.title, state: activity.state, activityId: activity.id };
				} else if (result) {
					yield { ...base, kind: 'result', text: said(result.summary) };
				} else if (usage?.cost) {
					yield { ...base, kind: 'usage', text: '', cost: typeof usage.cost.total === 'number' ? usage.cost.total : null, currency: String(usage.cost.currency ?? '') };
				} else {
					yield { ...base, kind: 'other', text: '' };
				}
			}
		} catch (error) {
			// The stream's own failures, mapped as calls' are: a Computer stopped or gone under a followed turn ends the session
			// (F4: Stop All's SandboxGoneError on agent/events was shown as a Pine error and the turn stayed running), and a
			// stream whose reconnects ran out is a lost connection.
			const s = await sdk();
			if (isGone(error, s)) {
				throw new MissingError((error as Error).message);
			}
			if (isLost(error, s)) {
				throw new ConnectionLostError((error as Error).message);
			}
			throw error;
		}
	}

	async turnFiles(env: PineConnection, s: PineSession, turnId: string): Promise<TurnFile[]> {
		// The turn's own result names what it returned, in the working directory, as open-pinedrama main reads it
		// (src/engine/pine-fleet.ts:53, `turn.result.artifacts`); `listArtifacts` lists the separate returned copies,
		// whose paths the working directory does not have (404 on pine-dev).
		const turn = await this.mapped(async () => (await this.session(env, s)).agent.wait(turnId, { timeoutMs: 0 }), 'none');
		return (turn.result?.artifacts ?? []).map(a => ({ path: a.relativePath, root: a.root, ...(a.computerId ? { computerId: a.computerId } : {}), sha256: a.sha256, size: a.size, type: a.contentType }));
	}

	async openFile(env: PineConnection, s: PineSession, path: string) {
		return this.readable(async () => (await this.session(env, s)).openFile(path));
	}

	async artifacts(env: PineConnection, computerId: string): Promise<ArtifactStore> {
		const { ArtifactNotFoundError } = await sdk();
		const store = (await this.client(env)).artifacts(computerId);
		return {
			list: async prefix => {
				const paths: { path: string; size: number }[] = [];
				let pageToken = '';
				do {
					// A Computer Pine no longer has has no artifacts either: MissingError, as for its other resources.
					const page = await this.mapped(() => store.list({ prefix, recursive: true, ...(pageToken ? { pageToken } : {}) }), 'none');
					paths.push(...page.files.map(f => ({ path: f.path, size: f.size })));
					pageToken = page.nextPageToken;
				} while (pageToken);
				return paths;
			},
			upload: async (path, bytes) => { await store.upload(path, new Uint8Array(bytes)); },
			copy: async (fromComputer, path) => { await store.copy(fromComputer, path, path); },
			read: async path => {
				try {
					const chunks: Uint8Array[] = [];
					// A web ReadableStream is async-iterable in Node 20 and later.
					for await (const chunk of await store.open(path) as unknown as AsyncIterable<Uint8Array>) {
						chunks.push(chunk);
					}
					return Buffer.concat(chunks);
				} catch (error) {
					if (error instanceof ArtifactNotFoundError) {
						return undefined;
					}
					throw error;
				}
			},
		};
	}

	async openReturned(env: PineConnection, s: PineSession, file: TurnFile) {
		if (file.root === 'workdir') {
			return this.openFile(env, s, file.path);
		}
		if (file.root === 'artifact_store' && file.computerId) {
			return this.readable(async () => (await this.client(env)).artifacts(file.computerId!).open(file.path));
		}
		throw new Error(`the turn returned ${file.path} from Pine's "${file.root}" store, which the Studio does not read yet`);
	}

	async writeFile(env: PineConnection, s: PineSession, name: string, content: Uint8Array) {
		await this.mapped(async () => (await this.session(env, s)).writeFile(name, content), 'none');
	}

	async listFolder(env: PineConnection, s: PineSession, folder: string): Promise<FolderEntry[]> {
		const entries = await this.readable(async () => (await this.session(env, s)).listFiles({ path: folder }));
		return entries.map(e => ({ path: e.relativePath, folder: e.isDir, size: e.size }));
	}

	/**
	 * A working-directory read: a 404 is "no such file", as open-pinedrama's settle tests it (`error.status === 404`). It is
	 * told before `mapped` turns the SDK's NotFoundError into MissingError, which would read as a lost session.
	 */
	private async readable<T>(call: () => Promise<T>): Promise<T> {
		const s = await sdk();
		return this.mapped(async () => {
			try {
				return await call();
			} catch (error) {
				if (error instanceof s.ApiError && error.status === 404) {
					throw new NoSuchFileError((error as Error).message);
				}
				throw error;
			}
		}, 'none');
	}

	async idlePolicy(env: PineConnection): Promise<IdlePolicy> {
		const policy = await (await this.client(env)).projectPolicy();
		return { adjustable: policy.lifecycle !== null, maxIdleSeconds: policy.lifecycle?.maxIdleTimeoutSeconds ?? null };
	}

	async setIdleTimeout(env: PineConnection, s: Pick<PineSession, 'credentials' | 'binding'>, seconds: number) {
		return this.mapped(async () => (await (await this.computer(env, s.credentials, s.binding)).setIdleTimeout(seconds)).lifetime?.idleTimeoutSeconds ?? seconds, 'none');
	}

	async stopComputer(env: PineConnection, credentials: string, binding: string) {
		// SDK Computer.stop (dist/index.d.ts): false means its wait expired; shutdown continues server-side.
		// Never release execution authority on a request acknowledgement without confirmed completion.
		if (!await (await this.computer(env, credentials, binding)).stop()) {
			throw new UnconfirmedError('Computer shutdown is not confirmed; it may still be stopping. Retry Stop before continuing with another worker.');
		}
	}
}

/**
 * The SDK's own rule for "the server may have acted although no response arrived": an ApiError of
 * status 408, 502, 503 or 504 (PineSandbox sdks/pine-computer/typescript/src/internal/http.ts,
 * isLostResponseStatus).
 */
function isLostResponse(error: unknown, s: { ApiError: abstract new (...args: never[]) => { status: number } }): boolean {
	return error instanceof s.ApiError && [408, 502, 503, 504].includes(error.status);
}

function turnView(turn: { turnId: string; state: string; question: string; nextTurnId: string; result?: { summary: string; terminalReason: string; usage: { cost: { total: number | null; currency: string } } } | undefined }): TurnView {
	const cost = turn.result?.usage.cost;
	return {
		turnId: turn.turnId,
		state: turn.state,
		question: said(turn.question),
		summary: said(turn.result?.summary ?? ''),
		nextTurnId: turn.nextTurnId,
		terminalReason: turn.result?.terminalReason ?? '',
		cost: cost ? { total: cost.total, currency: cost.currency } : null,
	};
}

/** The skill that makes a drama on the Computer (open-pinedrama 58b1eb0 goals.ts:7, DRAMA_SKILL). */
const DRAMA_SKILL = 'drama-workflow';

/**
 * The Pine account problem an SDK error is, if any (AccountError). The codes and statuses are Pine's: Portal answers 401
 * INVALID_API_KEY and 403 INSUFFICIENT_SCOPE before any key-scoped call (PineSandbox 567ed28ec
 * apps/portal/app/controllers/api/base_controller.rb:19-31), 403 PROJECT_ACCESS_DENIED (project_policies_controller.rb:12),
 * and on attach 403 with reason spend_limit_reached, project_suspended or api_access_disabled
 * (attach_credentials_controller.rb:85-95), whose spend-limit message says which of the two limits it is
 * (attach_credential_mint.rb:48-54); the lifecycle API answers 429 COMPUTER_CAPACITY_EXCEEDED or
 * COMPUTER_CREATE_RATE_LIMITED (sdks/pine-computer/typescript/src/internal/lifecycle.ts:215-216).
 */
export function accountProblem(error: unknown, s: Sdk): AccountError | undefined {
	if (error instanceof AccountError) { return error; }
	if (error instanceof s.InvalidClientKeyError || error instanceof s.UnauthorizedError) { return new AccountError('key'); }
	if (error instanceof s.InsufficientScopeError || error instanceof s.ProjectAccessDeniedError || error instanceof s.ForbiddenError) { return new AccountError('permission'); }
	if (error instanceof s.RateLimitedError || error instanceof s.CreateRateLimitedError) { return new AccountError('rateLimited'); }
	if (error instanceof s.CapacityExceededError) { return new AccountError('capacity'); }
	if (error instanceof s.PortalError) {
		if (error.status === 401) { return new AccountError('key'); }
		if (error.status === 429) { return new AccountError('rateLimited'); }
		if (error.reason === 'spend_limit_reached') { return new AccountError(/monthly spend limit/.test(error.message) ? 'spendLimit' : 'credits'); }
		if (error.reason === 'project_suspended') { return new AccountError('suspended'); }
		if (error.reason === 'api_access_disabled') { return new AccountError('permission'); }
	}
	return undefined;
}
