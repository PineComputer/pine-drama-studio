// A fake Pine for the Chat tests: Computers, sessions and turns in memory, with run
// idempotent by key as the SDK documents, and failure injection. `lose(op)` makes the next call
// of that operation take effect remotely and then fail as if its response were lost.

import { sha256 } from '../core/sha256';
import { STANDING_PARAGRAPH } from '../core/instructions';
import { changeKey, fileKey, type ArtifactStore } from '../core/taskArtifacts';
import { REQUEST_ATTACHMENT } from '../core/protocol';
import { ConnectionLostError, MissingError, NoSuchFileError, StartNotConfirmedError, UnconfirmedError, type FolderEntry, type IdlePolicy, type PineConnection, type PineEvent, type PinePort, type PineSession, type SecretVault, type TurnFile, type TurnView } from '../core/pinePort';

interface FakeTurn { id: string; state: string; question: string; summary: string; next: string; cost: number; returned: Map<string, Uint8Array> }
interface FakeSession { name: string; token: string; taskId: string; turns: Map<string, FakeTurn>; runs: Map<string, string>; files: Map<string, Uint8Array>; attachments: Map<string, Uint8Array>; events: PineEvent[]; inputs: { kind: string; text: string; turnId: string; eventId: number }[] }
/** `revision` is Portal's binding revision: each start that attaches advances it (PineSandbox client.ts:168-170). */
interface FakeComputer { id: string; state: 'running' | 'stopped' | 'stopping' | 'terminated'; binding: string; revision: number; idleTimeout: number; sessions: Map<string, FakeSession> }

export type TurnPlan = {
	state: 'completed' | 'needs_input' | 'running' | 'failed';
	text?: string;
	/** Files the turn writes to the working directory and returns, by relative path. */
	files?: Record<string, string | Uint8Array>;
	/** Files the turn writes to the working directory but does not return (Pine lists only what the agent returns). */
	hidden?: Record<string, string | Uint8Array>;
	/** What the agent reports, in order, after its first progress line: activity events (SDK `AgentActivity`: upsert by id) and its own messages. */
	steps?: ({ id: string; title: string; state: string } | { said: string })[];
};

const TYPES: Record<string, string> = { png: 'image/png', mp4: 'video/mp4', md: 'text/markdown', json: 'application/json', txt: 'text/plain' };
const bytesOf = (content: string | Uint8Array) => typeof content === 'string' ? new TextEncoder().encode(content) : content;

export class FakePine implements PinePort {
	readonly computers = new Map<string, FakeComputer>();
	readonly calls: Record<string, number> = {};
	/** How the next run or answer ends; default completed. */
	plans: TurnPlan[] = [];
	/** Milliseconds an operation takes, e.g. a cold start. */
	readonly delays: Record<string, number> = {};
	private readonly holds = new Map<string, Promise<void>>();
	private lost = new Set<string>();
	private dropped = new Set<string>();
	private failing = new Map<string, { error: Error; skip: number }>();
	private seq = 0;
	private unreadable = new Map<string, Error>();
	/** Where Pine keeps a returned file, by path; workdir unless a test says otherwise. */
	readonly roots = new Map<string, string>();

	lose(op: string): void { this.lost.add(op); }
	/** The next call of `op` never reaches Pine, and the caller cannot tell. */
	drop(op: string): void { this.dropped.add(op); }
	/** Usage events carry no turn id, as older events may. */
	unscopedUsage = false;
	/** Result events carry no turn id. */
	unscopedResults = false;
	/** At most this many events per events() call, consumed call by call (a stream that ends early). */
	eventLimits: number[] = [];
	/** The next call of `op` after `skip` more calls fails with `error`. */
	fail(op: string, error: Error, skip = 0): void { this.failing.set(op, { error, skip }); }
	/** The network is down: every turn read and event stream gets no answer, as the SDK's ConnectionError. */
	offline = false;
	/** Only the event stream gets no answer (its reconnects run out, StreamLostError); turn reads work. */
	streamDown = false;
	/** Every read of this working-directory path fails with `error` until `readable(path)`. */
	unreadablePath(path: string, error: Error): void { this.unreadable.set(path, error); }
	readable(path: string): void { this.unreadable.delete(path); }

	private sessionNamed(name: string): FakeSession {
		for (const computer of this.computers.values()) {
			const session = computer.sessions.get(name);
			if (session) {
				return session;
			}
		}
		throw new Error(`no session ${name}`);
	}

	/** Puts a file in a session's working directory without any turn returning it. */
	putFile(sessionName: string, path: string, content: string | Uint8Array): void {
		this.sessionNamed(sessionName).files.set(path, bytesOf(content));
	}

	/** Makes every call of an operation wait until the returned function is called: a slow call that no timer decides. */
	hold(op: string): () => void {
		let release!: () => void;
		this.holds.set(op, new Promise<void>(resolve => { release = resolve; }));
		return release;
	}

	private async count(op: string): Promise<void> {
		this.calls[op] = (this.calls[op] ?? 0) + 1;
		await this.holds.get(op);
		if (this.delays[op]) {
			await new Promise(resolve => setTimeout(resolve, this.delays[op]));
		}
		if (this.dropped.delete(op)) {
			throw new UnconfirmedError(`${op}: never arrived`);
		}
		const failing = this.failing.get(op);
		if (failing && failing.skip-- === 0) {
			this.failing.delete(op);
			throw failing.error;
		}
	}

	/** After the effect: throws if this call's response is to be lost. */
	private respond<T>(op: string, value: T): T {
		if (this.lost.delete(op)) {
			throw new UnconfirmedError(`${op}: response lost`);
		}
		return value;
	}

	private computerOf(credentials: string): FakeComputer | undefined {
		return this.computers.get(credentials.replace(/^cred:/, ''));
	}

	private bound(binding: string): FakeComputer {
		const computer = [...this.computers.values()].find(c => c.binding === binding);
		if (!computer || computer.state !== 'running') {
			throw new MissingError('no such binding');
		}
		return computer;
	}

	/**
	 * The Computer side of a turn, protocol major 2 (doc/protocol.md 4.3): the files the turn wrote under drama/, one change
	 * per object folder, their bytes stored at files/<hash> first, numbered after the turn's changes stored already with the
	 * previous change's hash. A message that does not start a turn stores nothing this way.
	 */
	private storeTurnChanges(session: FakeSession, text: string, returned: ReadonlyMap<string, Uint8Array>): void {
		const turn = /^pine-drama-turn ([\w-]+)/.exec(text)?.[1];
		const computer = [...this.computers.values()].find(c => c.sessions.get(session.name) === session);
		const store = computer && this.artifactFiles.get(computer.id);
		const request = session.attachments.get(REQUEST_ATTACHMENT);
		if (!turn || !store || !request || (JSON.parse(Buffer.from(request).toString('utf8')) as { turn_id: string }).turn_id !== turn) {
			return;
		}
		// A change is one result: the files of one object folder, an output with its receipt (doc/protocol.md 4.3). Changes
		// go after those the turn stored already, each written once.
		let number = [...store.keys()].filter(k => k.startsWith(`turns/${turn}/changes/`)).length;
		let previous: Buffer | null = number ? store.get(changeKey(turn, number))! : null;
		// What the turn's stored changes wrote last, by path: a file returned again unchanged is no new change.
		const written = new Map<string, string | null>();
		for (let n = 1; n <= number; n++) {
			for (const [path, hash] of Object.entries((JSON.parse(store.get(changeKey(turn, n))!.toString('utf8')) as { files_after_change: Record<string, string | null> }).files_after_change)) { written.set(path, hash); }
		}
		const byFolder = new Map<string, Record<string, string>>();
		for (const [path, content] of returned) {
			if (!path.startsWith('drama/')) { continue; }
			const bytes = Buffer.from(content);
			const rel = path.slice('drama/'.length);
			if (written.get(rel) === sha256(bytes)) { continue; }
			store.set(fileKey(sha256(bytes)), bytes);
			const folder = rel.slice(0, rel.lastIndexOf('/') + 1);
			byFolder.set(folder, { ...byFolder.get(folder), [rel]: sha256(bytes) });
		}
		for (const files of byFolder.values()) {
			const change: Buffer = Buffer.from(JSON.stringify({ schema: 2, turn_id: turn, change_number: ++number, previous_change_sha256: previous && sha256(previous), files_after_change: files }));
			store.set(changeKey(turn, number), change);
			previous = change;
		}
	}





	private sessionOf(s: PineSession): FakeSession {
		const session = this.bound(s.binding).sessions.get(s.name);
		if (!session || session.token !== s.token) {
			throw new MissingError('no such session');
		}
		return session;
	}

	async newCredentials() {
		const id = `pc-${++this.seq}`;
		return { id, serialized: `cred:${id}` };
	}

	/** The idle timeout each start was given (the SDK's `readyTimeoutMs` is the port's to pass). */
	readonly starts: { idleTimeoutSeconds: number }[] = [];

	async ensureComputer(_env: PineConnection, credentials: string, _label: string, idleTimeoutSeconds: number) {
		this.starts.push({ idleTimeoutSeconds });
		const id = credentials.replace(/^cred:/, '');
		// A start reads the binding revision first and attaches with it; Portal refuses an attach another one overtook
		// (BindingRevisionConflictError, 412), which SdkPort reports as StartNotConfirmedError.
		const read = this.computers.get(id)?.revision ?? 0;
		await this.count('ensureComputer');
		let computer = this.computers.get(id);
		if ((computer?.revision ?? 0) !== read) {
			throw new StartNotConfirmedError(`another start of it was accepted first; Pine now binds sandbox ${computer!.binding}`);
		}
		if (!computer) {
			this.calls.create = (this.calls.create ?? 0) + 1;
			computer = { id, state: 'running', binding: `bind-${id}-${++this.seq}`, revision: read + 1, idleTimeout: idleTimeoutSeconds, sessions: new Map() };
			this.computers.set(id, computer);
		} else if (computer.state === 'stopped') {
			computer.state = 'running';
			computer.binding = `bind-${id}-${++this.seq}`;
			computer.revision = read + 1;
			computer.sessions.clear();
			computer.idleTimeout = idleTimeoutSeconds;
		}
		return this.respond('ensureComputer', { binding: computer.binding });
	}

	/** Pine stops the Computer (idle timeout): its sessions are gone. */
	stop(credentials: string): void {
		const computer = this.computerOf(credentials)!;
		computer.state = 'stopped';
		computer.sessions.clear();
	}

	async computerState(_env: PineConnection, credentials: string, binding: string) {
		const computer = this.computerOf(credentials);
		if (!computer) {
			throw new MissingError('unknown Computer');
		}
		return computer.binding === binding ? computer.state : 'stopped';
	}

	/** Each Computer's artifacts by its id: they outlive its sessions and a stop (local-first, 11.1). */
	readonly artifactFiles = new Map<string, Map<string, Buffer>>();

	async artifacts(_env: PineConnection, computerId: string): Promise<ArtifactStore> {
		await this.count('artifacts');
		const files = this.artifactFiles.get(computerId) ?? new Map<string, Buffer>();
		this.artifactFiles.set(computerId, files);
		return {
			list: async prefix => [...files].filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => ({ path, size: bytes.length })),
			upload: async (path, bytes, signal) => { signal?.throwIfAborted(); files.set(path, Buffer.from(bytes)); },
			copy: async (from, path) => { await this.count('copy'); const bytes = this.artifactFiles.get(from)?.get(path); if (!bytes) { throw new Error(`${from} has no ${path}`); } files.set(path, bytes); },
			read: async path => files.get(path),
		};
	}

	async createSession(_env: PineConnection, _credentials: string, binding: string) {
		await this.count('createSession');
		const computer = this.bound(binding);
		const name = `s-${++this.seq}`;
		computer.sessions.set(name, { name, token: `ps_${name}`, taskId: `task-${name}`, turns: new Map(), runs: new Map(), files: new Map(), attachments: new Map(), events: [], inputs: [] });
		return { name, token: `ps_${name}` };
	}

	async sessionTask(_env: PineConnection, s: PineSession) {
		return this.sessionOf(s).taskId;
	}

	private open(session: FakeSession, text: string): FakeTurn {
		const plan = this.plans.shift() ?? { state: 'completed' };
		const turn: FakeTurn = {
			id: `turn-${++this.seq}`, state: plan.state, next: '', cost: 0.01,
			question: plan.state === 'needs_input' ? (plan.text ?? 'Which episode?') : '',
			// Pine's turn result: a waiting turn's summary is its question (its SDK, parse.ts: question = summary).
			summary: plan.state === 'completed' ? (plan.text ?? `done: ${text.replace(`\n\n${STANDING_PARAGRAPH}`, '')}`) : plan.state === 'needs_input' ? (plan.text ?? 'Which episode?') : '',
			returned: new Map(Object.entries(plan.files ?? {}).map(([path, content]) => [path, bytesOf(content)])),
		};
		for (const [path, content] of Object.entries({ ...plan.hidden, ...plan.files })) {
			session.files.set(path, bytesOf(content));
		}
		session.turns.set(turn.id, turn);
		this.storeTurnChanges(session, text, turn.returned);
		const id = () => session.events.length + 1;
		session.inputs.push({ kind: 'run', text, turnId: turn.id, eventId: session.events.length });
		const base = { taskId: session.taskId, turnId: turn.id, text: '' };
		session.events.push({ ...base, eventId: id(), kind: 'progress', text: `working on ${text}` });
		for (const step of plan.steps ?? []) {
			session.events.push('said' in step
				? { ...base, eventId: id(), kind: 'progress', text: step.said }
				: { ...base, eventId: id(), kind: 'activity', text: step.title, state: step.state, activityId: step.id });
		}
		if (turn.summary) {
			session.events.push({ ...base, eventId: id(), kind: 'result', text: turn.summary, ...(this.unscopedResults ? { turnId: '' } : {}) });
		}
		// A cumulative snapshot before the end; the final cost comes with the turn (view()).
		session.events.push({ ...base, eventId: id(), kind: 'usage', cost: turn.cost / 10, currency: 'USD', ...(this.unscopedUsage ? { turnId: '' } : {}) });
		return turn;
	}

	/** Pine's cancel: a running turn, or one waiting on a question, ends `canceled`; an ended one is left as it is. */
	async cancel(_env: PineConnection, s: PineSession, turnId: string) {
		await this.count('cancel');
		const turn = this.sessionOf(s).turns.get(turnId);
		if (!turn) {
			throw new MissingError('no such turn');
		}
		if (turn.state === 'running' || turn.state === 'needs_input') {
			turn.state = 'canceled';
			turn.question = '';
		}
	}

	async run(_env: PineConnection, s: PineSession, text: string, key: string) {
		await this.count('run');
		const session = this.sessionOf(s);
		let turnId = session.runs.get(key);
		if (!turnId) {
			turnId = this.open(session, text).id;
			session.runs.set(key, turnId);
		}
		return this.respond('run', view(session.turns.get(turnId)!));
	}


	async turn(_env: PineConnection, s: PineSession, turnId: string) {
		if (this.offline) {
			await new Promise(resolve => setTimeout(resolve, 5));
			throw new ConnectionLostError('pinesandbox: connection failed: fetch failed');
		}
		const turn = this.sessionOf(s).turns.get(turnId);
		if (!turn) {
			throw new MissingError('no such turn');
		}
		if (turn.state === 'running') {
			// Pine's wait holds the call while the turn runs; a few milliseconds keep a follower from spinning.
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		return view(turn);
	}

	/** A running turn ends as `plan` says, as the agent on the Computer would end it with no Studio watching. */
	finish(turnId: string, plan: TurnPlan): void {
		for (const computer of this.computers.values()) {
			for (const session of computer.sessions.values()) {
				const turn = session.turns.get(turnId);
				if (turn) {
					turn.state = plan.state;
					turn.question = plan.state === 'needs_input' ? (plan.text ?? 'Which episode?') : '';
					turn.summary = plan.state === 'completed' ? (plan.text ?? 'done') : plan.state === 'needs_input' ? turn.question : '';
					for (const [path, content] of Object.entries(plan.files ?? {})) {
						turn.returned.set(path, bytesOf(content));
						session.files.set(path, bytesOf(content));
					}
					const input = session.inputs.find(i => i.turnId === turnId);
					this.storeTurnChanges(session, input?.text ?? '', turn.returned);
					return;
				}
			}
		}
		throw new Error(`no turn ${turnId}`);
	}

	async *events(_env: PineConnection, s: PineSession, after: number | undefined): AsyncIterable<PineEvent> {
		await this.count('events');
		if (this.offline || this.streamDown) {
			throw new ConnectionLostError('pinesandbox: connection failed: event stream lost');
		}
		let left = this.eventLimits.shift() ?? Infinity;
		for (const event of this.sessionOf(s).events) {
			if (event.eventId > (after ?? 0)) {
				if (left-- <= 0) {
					return;
				}
				yield event;
			}
		}
	}

	/** Replays every event of the session, as a reconnecting stream might. */
	allEvents(s: { name: string }): PineEvent[] {
		for (const computer of this.computers.values()) {
			const session = computer.sessions.get(s.name);
			if (session) {
				return session.events;
			}
		}
		return [];
	}

	/** The messages the Studio sent to a session, in order, as the agent received them. */
	inputsOf(sessionName: string): { kind: string; text: string; turnId: string }[] {
		return this.sessionNamed(sessionName).inputs;
	}

	/** What the Studio wrote under a session's attachments/, by file name. */
	attachmentsOf(sessionName: string): Map<string, Uint8Array> {
		return this.sessionNamed(sessionName).attachments;
	}

	/** Every attachment the Studio wrote, in order: a turn's request replaces the one before it in the session. */
	readonly written: { readonly session: string; readonly name: string; readonly content: Uint8Array }[] = [];

	async writeFile(_env: PineConnection, s: PineSession, name: string, content: Uint8Array): Promise<void> {
		await this.count('writeFile');
		this.sessionOf(s).attachments.set(name, content);
		this.written.push({ session: s.name, name, content });
	}

	async turnFiles(_env: PineConnection, s: PineSession, turnId: string): Promise<TurnFile[]> {
		await this.count('turnFiles');
		const session = this.sessionOf(s);
		const turn = session.turns.get(turnId);
		if (!turn) {
			throw new MissingError('no such turn');
		}
		return [...turn.returned].map(([path, bytes]) => {
			return { path, root: this.roots.get(path) ?? 'workdir', sha256: sha256(bytes), size: bytes.length, type: TYPES[path.split('.').pop()!] ?? 'application/octet-stream' };
		});
	}

	async openFile(_env: PineConnection, s: PineSession, path: string) {
		await this.count('openFile');
		const session = this.sessionOf(s);
		const error = this.unreadable.get(path);
		if (error) {
			throw error;
		}
		const bytes = session.files.get(path);
		if (!bytes) {
			throw new NoSuchFileError(`404 ${path}`);
		}
		// In two chunks, as a network body arrives.
		const half = Math.floor(bytes.length / 2);
		return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, half)); controller.enqueue(bytes.subarray(half)); controller.close(); } });
	}

	async openReturned(env: PineConnection, s: PineSession, file: TurnFile) {
		if (file.root !== 'workdir') {
			throw new Error(`the turn returned ${file.path} from Pine's "${file.root}" store, which the Studio does not read yet`);
		}
		return this.openFile(env, s, file.path);
	}

	async listFolder(_env: PineConnection, s: PineSession, folder: string): Promise<FolderEntry[]> {
		await this.count('listFolder');
		const session = this.sessionOf(s);
		const prefix = folder.replace(/\/$/, '') + '/';
		const entries = new Map<string, FolderEntry>();
		for (const [path, bytes] of session.files) {
			if (path.startsWith(prefix)) {
				const rest = path.slice(prefix.length);
				const slash = rest.indexOf('/');
				entries.set(slash < 0 ? path : prefix + rest.slice(0, slash), slash < 0 ? { path, folder: false, size: bytes.length } : { path: prefix + rest.slice(0, slash), folder: true, size: 0 });
			}
		}
		if (entries.size === 0) {
			throw new NoSuchFileError(`404 ${folder}`);
		}
		return [...entries.values()];
	}

	/** A turn's state, for assertions. */
	turnState(turnId: string): string | undefined {
		for (const computer of this.computers.values()) {
			for (const session of computer.sessions.values()) {
				const turn = session.turns.get(turnId);
				if (turn) {
					return turn.state;
				}
			}
		}
		return undefined;
	}
	/** The project's idle-timeout policy: without a lifetime policy (`adjustable` false) the timeout is fixed at start. */
	policy: IdlePolicy = { adjustable: true, maxIdleSeconds: null };
	async idlePolicy() {
		await this.count('idlePolicy');
		return this.policy;
	}
	/** The idle timeouts asked for, in order. */
	readonly idleRequests: number[] = [];
	idleTimeoutOf(credentials: string): number {
		return this.computerOf(credentials)!.idleTimeout;
	}
	async setIdleTimeout(_env: PineConnection, s: { credentials: string; binding: string }, seconds: number) {
		await this.count('setIdleTimeout');
		if (!this.policy.adjustable) {
			throw new Error('pinesandbox: Computer was started without a lifetime policy; choose the idle timeout on the next Start');
		}
		this.idleRequests.push(seconds);
		const computer = this.computerOf(s.credentials);
		if (!computer || computer.binding !== s.binding || computer.state !== 'running') {
			throw new MissingError('Computer is not running');
		}
		computer.idleTimeout = seconds;
		return this.respond('setIdleTimeout', seconds);
	}
	async stopComputer(_env: PineConnection, credentials: string) {
		await this.count('stopComputer');
		this.stop(credentials);
	}
}

function view(turn: FakeTurn): TurnView {
	return { turnId: turn.id, state: turn.state, question: turn.question, summary: turn.summary, nextTurnId: turn.next, terminalReason: '', cost: { total: turn.cost, currency: 'USD' } };
}

export class MemoryVault implements SecretVault {
	readonly values = new Map<string, string>();
	failStore = false;
	/** Milliseconds a read takes, like a keychain prompt. */
	getDelay = 0;
	async get(name: string) {
		if (this.getDelay) {
			await new Promise(resolve => setTimeout(resolve, this.getDelay));
		}
		return this.values.get(name);
	}
	async store(name: string, value: string) {
		if (this.failStore) {
			throw new Error('keychain locked');
		}
		this.values.set(name, value);
	}
	async delete(name: string) { this.values.delete(name); }
}
