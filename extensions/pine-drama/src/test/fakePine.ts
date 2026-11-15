// A fake Pine for the Chat tests: Computers, sessions and turns in memory, with run
// idempotent by key as the SDK documents, and failure injection. `lose(op)` makes the next call
// of that operation take effect remotely and then fail as if its response were lost. Each session's working directory
// is a real temporary folder, and exec runs its command there in bash, so the Studio's own commands are what is tested.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STANDING_PARAGRAPH } from '../core/instructions';
import { ConnectionLostError, MissingError, NoSuchFileError, StartNotConfirmedError, UnconfirmedError, type IdlePolicy, type PineConnection, type PineEvent, type PinePort, type PineSession, type SecretVault, type TurnView } from '../core/pinePort';

interface FakeTurn { id: string; state: string; question: string; summary: string; next: string; cost: number }
/** `dir`: the session's working directory, with Pine's attachments/ in it. */
interface FakeSession { name: string; token: string; taskId: string; dir: string; turns: Map<string, FakeTurn>; runs: Map<string, string>; events: PineEvent[]; inputs: { kind: string; text: string; turnId: string; eventId: number }[] }

/** Every session folder the fakes made, removed when the test process ends. */
const folders: string[] = [];
process.on('exit', () => { for (const dir of folders) { rmSync(dir, { recursive: true, force: true }); } });
/** `revision` is Portal's binding revision: each start that attaches advances it (PineSandbox client.ts:168-170). */
interface FakeComputer { id: string; state: 'running' | 'stopped' | 'stopping' | 'terminated'; binding: string; revision: number; idleTimeout: number; sessions: Map<string, FakeSession> }

export type TurnPlan = {
	state: 'completed' | 'needs_input' | 'running' | 'failed';
	text?: string;
	/** Files the agent writes, by their path in the working directory (`drama/…` for the drama's); null deletes one. */
	files?: Record<string, string | Uint8Array | null>;
	/** What the agent reports, in order, after its first progress line: activity events (SDK `AgentActivity`: upsert by id) and its own messages. */
	steps?: ({ id: string; title: string; state: string } | { said: string })[];
};

/** The agent's writes in a session's working directory. */
function write(session: FakeSession, files: TurnPlan['files'] = {}): void {
	for (const [path, content] of Object.entries(files)) {
		const file = join(session.dir, path);
		if (content === null) { rmSync(file, { force: true }); continue; }
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}

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

	private sessionNamed(name: string): FakeSession {
		for (const computer of this.computers.values()) {
			const session = computer.sessions.get(name);
			if (session) {
				return session;
			}
		}
		throw new Error(`no session ${name}`);
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

	async createSession(_env: PineConnection, _credentials: string, binding: string) {
		await this.count('createSession');
		const computer = this.bound(binding);
		const name = `s-${++this.seq}`;
		const dir = mkdtempSync(join(tmpdir(), 'fake-pine-session-'));
		folders.push(dir);
		mkdirSync(join(dir, 'attachments'));
		computer.sessions.set(name, { name, token: `ps_${name}`, taskId: `task-${name}`, dir, turns: new Map(), runs: new Map(), events: [], inputs: [] });
		return { name, token: `ps_${name}`, workdir: dir };
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
		};
		write(session, plan.files);
		session.turns.set(turn.id, turn);
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
					write(session, plan.files);
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

	/** Every command the Studio ran in a session, in order. */
	readonly commands: { readonly session: string; readonly command: string }[] = [];

	/** The agent's working directory of a session, where its files are. */
	workdirOf(sessionName: string): string {
		return this.sessionNamed(sessionName).dir;
	}

	async writeFile(_env: PineConnection, s: PineSession, name: string, content: Uint8Array): Promise<void> {
		await this.count('writeFile');
		writeFileSync(join(this.sessionOf(s).dir, 'attachments', name), content);
	}

	/** Pine's exec: the command runs in bash, in the directory the session handle names, as SdkPort's does. */
	async exec(_env: PineConnection, s: PineSession, command: string, signal?: AbortSignal): Promise<string> {
		await this.count('exec');
		const session = this.sessionOf(s);
		if (s.workdir !== session.dir) { throw new Error(`exec in ${s.workdir}, not the session's working directory`); }
		this.commands.push({ session: s.name, command });
		return new Promise((resolve, reject) => execFile('bash', ['-c', command], { cwd: s.workdir, signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) { reject(new Error(`a command on the Computer failed (exit ${error.code}): ${stderr.trim()}`)); } else { resolve(stdout); }
		}));
	}

	async openFile(_env: PineConnection, s: PineSession, path: string) {
		await this.count('openFile');
		const session = this.sessionOf(s);
		let bytes: Buffer;
		try {
			bytes = readFileSync(join(session.dir, path));
		} catch {
			throw new NoSuchFileError(`404 ${path}`);
		}
		// In two chunks, as a network body arrives.
		const half = Math.floor(bytes.length / 2);
		return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, half)); controller.enqueue(bytes.subarray(half)); controller.close(); } });
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
