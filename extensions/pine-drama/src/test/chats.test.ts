import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { CHANGED_TARGET_NOTE } from '../core/instructions';
import { IDLE_WAITING_SECONDS, IDLE_WORKING_SECONDS, MissingError, NoPineError, OtherPineError, UnconfirmedError } from '../core/pinePort';
import { SdkPort } from '../sdkPort';
import type { PineConnection } from '../core/pinePort';
import { PineSessionReplacedError } from '../core/pineSessionGeneration';
import { setAsideNotice, Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { owningChat, projectFolder } from '../core/projectPlace';

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/local-1';
/** The window's one folder, as the chat handler passes it (core/binding.ts). */
const FOLDER = '/Users/x/Pine Drama Studio/Night Ward';

function setup() {
	const path = join(mkdtempSync(join(tmpdir(), 'pine-studio-')), 'studio.sqlite');
	const clock = { now: 1_000_000 };
	const pine = new FakePine();
	const vault = new MemoryVault();
	/** A Studio window: its own store connection. A new one after a crash is a restart. */
	const window = (log?: (line: string) => void) => {
		const store = new Store(path, () => clock.now);
		const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault, pine: ENV, ...(log ? { log } : {}) });
		return { store, service };
	};
	return { path, clock, pine, vault, window };
}

// A database of another schema is set aside, never migrated or deleted; the work is in the
// drama's folder, so the person continues from it in Project Chat. Told once, in plain words.
test('a database of another schema is set aside with its journal files, once, and the person is told where', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pine-studio-'));
	const path = join(dir, 'studio.sqlite');
	const old = new DatabaseSync(path);
	old.exec('pragma journal_mode = wal; create table conversations (key text primary key); pragma user_version = 2');
	const held = new DatabaseSync(path); // a second connection keeps the -wal and -shm files, as a running older app would
	held.prepare('select count(*) n from conversations').get();
	old.close();
	const wal = readFileSync(`${path}-wal`);
	const store = new Store(path, () => Date.parse('2026-11-05T23:15:00Z'));
	const aside = `${path}.schema2-20261105T231500Z`;
	assert.deepEqual(store.setAside, { schema: 2, path: aside });
	assert.deepEqual(readFileSync(`${aside}-wal`), wal, 'its -wal goes with it, unchanged');
	assert.equal(existsSync(`${aside}-shm`), true);
	assert.equal(setAsideNotice(store.setAside!), `Earlier Chat history from an older version of Pine Drama Studio was set aside at ${aside}. Open your project folder and continue in its pinned session: your work is in the folder.`);
	store.insertChat({ key: 'k', env: 'dev', endpoint: 'https://pine.test', label: 'k', secret_ref: 'k' });
	store.close();
	held.close();
	// The second start finds this schema: nothing is set aside again.
	const again = new Store(path, () => Date.parse('2026-11-06T08:00:00Z'));
	assert.equal(again.setAside, undefined);
	assert.equal(again.chats().length, 1);
	again.close();
	assert.deepEqual(readdirSync(dir).filter(f => f.includes('.schema')).sort(), [aside, `${aside}-shm`, `${aside}-wal`].map(p => basename(p)).sort());
	const after = new DatabaseSync(aside);
	assert.equal((after.prepare('pragma user_version').get() as { user_version: number }).user_version, 2);
	assert.equal(after.prepare("select count(*) n from sqlite_master where name = 'operations'").get()!.n, 0);
	after.close();
	// A new database opens, and opens again at this schema.
	const fresh = path.replace('studio.sqlite', 'fresh.sqlite');
	new Store(fresh).close();
	new Store(fresh).close();
});

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const out: Update[] = [];
	for await (const update of updates) {
		out.push(update);
	}
	return out;
}

/** The vault entry the database names as current. */
function currentSecret(store: Store): string {
	const conv = store.chat(KEY)!;
	return `${conv.secret_ref}.${conv.secret_gen}`;
}

const send = (service: ChatService, text: string) => drain(service.submit(KEY, text, text));
const markdown = (updates: Update[]) => updates.filter(u => u.kind !== 'progress').map(u => u.text).join('\n');
const kinds = (store: Store) => store.messages(KEY).map(m => m.kind);

test('a message runs a turn; its messages, cost and last applied event id are saved once', async () => {
	const { window } = setup();
	const { store, service } = window();
	const updates = await send(service, 'cast EP001');
	assert.match(markdown(updates), /done: cast EP001/);
	assert.deepEqual(kinds(store), ['prompt', 'instructions', 'progress', 'result', 'usage']);
	const conv = store.chat(KEY)!;
	assert.equal(conv.state, 'idle');
	assert.equal(conv.computer_state, 'running');
	assert.equal(conv.last_applied_event_id, 3);
	assert.equal(store.unconfirmedSavedSends(KEY).length, 0);
});

test('credentials are saved before the Computer is created; a failed save creates nothing', async () => {
	const { window, vault, pine } = setup();
	vault.failStore = true;
	const updates = await send(window().service, 'hello');
	assert.match(markdown(updates), /no Computer was created/);
	assert.equal(pine.calls.ensureComputer ?? 0, 0);
});

test('create response lost: the retry uses the same credentials and creates one Computer', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.lose('ensureComputer');
	await assert.rejects(send(service, 'hello'), /response lost/);
	assert.equal(store.chat(KEY)!.computer_state, 'creating');
	await send(service, 'hello again');
	assert.equal(pine.calls.create, 1);
	assert.equal(pine.computers.size, 1);
	assert.equal(store.chat(KEY)!.computer_state, 'running');
});

test('missing credentials on restart are reported; no Computer is created silently', async () => {
	const { window, vault, pine } = setup();
	const first = window();
	await send(first.service, 'hello');
	vault.values.delete(currentSecret(first.store));
	const restarted = window();
	const updates = await send(restarted.service, 'again');
	assert.match(markdown(updates), /no longer has the credentials/);
	assert.equal(pine.calls.create, 1);
	assert.equal(restarted.store.chat(KEY)!.computer_state, 'missing_credentials');
});

test('run response lost: resent with the same key, so Pine opens one turn', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	await send(service, 'first');
	pine.lose('run');
	const lost = await send(service, 'second');
	assert.match(markdown(lost), /did not confirm the run/);
	const [op] = store.unconfirmedSavedSends(KEY);
	assert.equal(op.state, 'unknown');
	await send(service, 'third');
	assert.equal(store.savedSend(op.id)!.state, 'sent');
	// Two runs reached the fake for 'second' (lost, resent) but one turn exists for it.
	const turns = store.db.prepare("select count(distinct turn_id) n from saved_sends where text = 'second'").get() as { n: number };
	assert.equal(turns.n, 1);
	assert.equal(store.messages(KEY).filter(m => m.kind === 'result').length, 3);
});

test('crash after sending: a restarted window resends the saved run with its key', async () => {
	const { window, pine } = setup();
	const first = window();
	await send(first.service, 'first');
	// The window saved the operation and sent it, then died before recording the answer.
	const conv = first.store.chat(KEY)!;
	first.store.tx(() => first.store.insertSavedSend({ id: 'op-crash', chat_key: KEY, kind: 'run', text: 'lost in crash', target_turn_id: null }));
	const secrets = await window().service['secrets'](conv);
	await pine.run(ENV, { credentials: secrets!.credentials, binding: secrets!.binding!, name: conv.pine_session_name!, token: secrets!.sessionToken! }, 'lost in crash', 'op-crash');
	const runsBefore = pine.calls.run;
	// The window that died held its project's window lock; the next one has it now and recovers at once.
	const restarted = window();
	await send(restarted.service, 'after');
	const op = restarted.store.savedSend('op-crash')!;
	assert.equal(op.state, 'sent');
	assert.ok(op.turn_id);
	assert.equal(pine.calls.run, runsBefore + 2);
	assert.equal(restarted.store.db.prepare("select count(*) n from messages where kind = 'result' and text like '%lost in crash%'").get()!.n, 1);
});

test('an event write interrupted midway changes nothing; the replay applies it once and the last applied event id never moves back', async () => {
	const { window } = setup();
	const { store, service } = window();
	const addMessage = store.addMessage.bind(store);
	let failed = false;
	store.addMessage = (m) => {
		if (m.kind === 'result' && !failed) {
			failed = true;
			throw new Error('disk full');
		}
		return addMessage(m);
	};
	await assert.rejects(send(service, 'cast'), /disk full/);
	assert.equal(store.db.prepare('select count(*) n from events').get()!.n, 1);
	assert.equal(store.chat(KEY)!.last_applied_event_id, 1);
	await drain(service.attachChatToPineTurn(KEY));
	assert.deepEqual(kinds(store), ['prompt', 'instructions', 'progress', 'result', 'usage']);
	assert.equal(store.chat(KEY)!.last_applied_event_id, 3);
	// Replaying old events through the same path changes nothing.
	const before = store.messages(KEY).length;
	for (const event of [1, 2, 3]) {
		service['apply'](KEY, 1, { eventId: event, taskId: store.chat(KEY)!.task_id!, turnId: store.chat(KEY)!.current_turn_id!, kind: 'result', text: 'again' });
	}
	assert.equal(store.messages(KEY).length, before);
	assert.equal(store.chat(KEY)!.last_applied_event_id, 3);
});

test('a pass of a replaced Pine session writes nothing: its generation is refused and leaves no trace', async () => {
	const { window } = setup();
	const a = window();
	await send(a.service, 'from a');
	const generation = a.service['pineSessionGeneration'](KEY);
	// replaceEndedPineSession advances the generation; a follower or import still running for the earlier session
	// carries the one it started with.
	a.service['generations'].advance(KEY);
	const before = a.store.messages(KEY).length;
	assert.throws(() => a.service['write'](KEY, generation, () => a.store.addMessage({ chat_key: KEY, turn_id: null, saved_send_id: null, kind: 'notice', text: 'late', cost: null, currency: null })), PineSessionReplacedError);
	assert.equal(a.store.messages(KEY).length, before);
	// A pass that starts now works under the new generation.
	assert.match(markdown(await send(a.service, 'from a again')), /done: from a again/);
});

test('a message sent while a turn runs waits for it, then goes as a new run, an answer to the question it ended on included (D25: nothing is cancelled)', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }];
	await send(service, 'start');
	// The turn is still running as far as the Studio knows when the message comes.
	store.tx(() => store.updateChat(KEY, { state: 'running', question_turn_id: null }));
	const waited = markdown(await send(service, 'EP003'));
	assert.match(waited, /Pine Computer is still running this turn; your message will be sent when it finishes\./);
	const ops = store.db.prepare('select kind, text from saved_sends order by created_at').all() as { kind: string; text: string }[];
	assert.deepEqual(ops.map(o => o.kind), ['run', 'run'], 'the answer to the question the turn ended on is a new run (doc/protocol.md, 4.3)');
	assert.equal(pine.calls.run, 2);
	store.tx(() => store.updateChat(KEY, { state: 'running' }));
	await send(service, 'again');
	assert.equal((store.db.prepare('select kind from saved_sends order by created_at desc limit 1').get() as { kind: string }).kind, 'run', 'a finished turn: a new run');
});

test('a reply whose view ended stops reading; the next message follows the turn, shows how it ended, then is sent (D25; Codex at ed5ee3b)', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }];
	const first = service.submit(KEY, 'make the drama', 'make the drama');
	const end = Date.now() + 10_000;
	while (store.chat(KEY)?.state !== 'running') {
		assert.ok(Date.now() < end, 'the turn runs');
		await first.next();
	}
	await first.return(undefined); // the view ended (pineSessions.ts, replyEnded)
	pine.finish(store.chat(KEY)!.current_turn_id!, { state: 'completed', text: 'The drama is made.' });
	const next = markdown(await send(service, 'and the poster'));
	assert.match(next, /Pine Computer is still running this turn[^]*The drama is made\.[^]*done: and the poster/);
	assert.deepEqual(store.messages(KEY).filter(m => m.kind === 'result').map(m => m.text), ['The drama is made.', 'done: and the poster'], 'each turn settled once');
});

test('a message waiting for a turn whose session is lost goes to a new session, once (D25: it comes after the reply that found the loss)', async () => {
	const { window } = setup();
	const { store, service } = window();
	await send(service, 'start');
	// The turn it waits for is gone, as Pine answers when the session is (MissingError).
	store.tx(() => store.updateChat(KEY, { state: 'running', current_turn_id: 'turn-gone' }));
	const said = await drain(service.submit(KEY, 'make it darker', 'make it darker', FOLDER));
	assert.ok(said.every(u => u.kind !== 'sessionEnded'), markdown(said));
	assert.match(markdown(said), /done: make it darker/);
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text like 'make it darker%' and state = 'sent'").get()!.n, 1);
	assert.doesNotMatch(markdown(said), /was not sent/);
});

test('a message whose session ends during the recovery of an earlier send goes to a new session once (Codex\'s review at ed5ee3b)', async () => {
	const { window, pine, vault } = setup();
	const { store, service } = window();
	await send(service, 'first');
	pine.lose('run');
	await send(service, 'second'); // unconfirmed: resent before the next message
	pine.stop(JSON.parse(vault.values.get(currentSecret(store))!).credentials);
	const said = await drain(service.submit(KEY, 'third', 'third', FOLDER));
	assert.ok(said.every(u => u.kind !== 'sessionEnded'));
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text like 'third%' and state = 'sent'").get()!.n, 1, 'delivered once');
	assert.doesNotMatch(markdown(said), /was not sent/);
});

test('a message that finds its session already ended is sent in a new session, with no "not sent" line', async () => {
	const { window, pine, vault } = setup();
	const { store, service } = window();
	await send(service, 'first');
	pine.stop(JSON.parse(vault.values.get(currentSecret(store))!).credentials);
	const sent = await drain(service.submit(KEY, 'second', 'second', FOLDER));
	assert.ok(sent.every(u => u.kind !== 'sessionEnded'));
	assert.match(markdown(sent), /done: second/);
	// The first try found the session gone at Pine (MissingError: not delivered); only the new session's send went.
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text like 'second%' and state = 'sent'").get()!.n, 1, 'delivered once');
});

test('Computer stopped: the next message starts the agent again on it and is sent there; the history is kept', async () => {
	const { window, pine, vault } = setup();
	const first = window();
	await send(first.service, 'first');
	const credentials = JSON.parse(vault.values.get(currentSecret(first.store))!).credentials as string;
	pine.stop(credentials);
	const restarted = window();
	const updates = await send(restarted.service, 'second');
	// The person's send is the explicit action: the Studio starts the agent again and sends it.
	assert.ok(updates.every(u => u.kind !== 'sessionEnded'), 'no ended part, no button');
	assert.doesNotMatch(markdown(updates), /was not sent/);
	assert.equal(pine.calls.createSession, 2);
	assert.match(markdown(updates), /done: second/);
	const conv = restarted.store.chat(KEY)!;
	assert.deepEqual([conv.pine_session_state, conv.computer_state], ['open', 'running']);
	assert.ok(restarted.store.messages(KEY).some(m => m.kind === 'result' && /done: first/.test(m.text)), 'the history is kept');
	assert.ok(restarted.store.messages(KEY).some(m => /does not remember earlier turns/.test(m.text)));
	const after = await send(restarted.service, 'third');
	assert.match(markdown(after), /done: third/);
});

test('a reconnected session is logged, with its Task, only after the Task matched, and the person is not shown the id', async () => {
	const { window } = setup();
	await send(window().service, 'first');
	const lines: string[] = [];
	const restarted = window(line => lines.push(line));
	const updates = await send(restarted.service, 'second');
	assert.ok(lines.some(l => /reconnected to the original session \(Task task-/.test(l)), lines.join('\n'));
	assert.doesNotMatch(markdown(updates), /Reconnected|Task task-/);
	assert.match(markdown(updates), /done: second/);
});

test('core/ does not import vscode', () => {
	const dir = join(__dirname, '..', '..', 'src', 'core');
	for (const file of readdirSync(dir)) {
		assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /from ['"]vscode['"]/, file);
	}
});

test('review P1: a pass whose Pine session is replaced during a slow call publishes neither its session nor its token', async () => {
	const path = join(mkdtempSync(join(tmpdir(), 'pine-studio-')), 'studio.sqlite');
	const pine = new FakePine();
	const vault = new MemoryVault();
	const store = new Store(path);
	const a = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault, pine: ENV });
	const release = pine.hold('createSession');
	const slow = send(a, 'from a').then(() => undefined, (error: Error) => error);
	for (let waited = 0; pine.calls.createSession !== 1; waited += 5) {
		assert.ok(waited < 10_000, 'the first send reaches its slow createSession');
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	// The Chat's Pine session is replaced while the call is out (replaceEndedPineSession advances the generation).
	a['generations'].advance(KEY);
	release();
	assert.ok(await slow instanceof PineSessionReplacedError, 'the earlier pass stops at the check after its call');
	assert.equal(store.chat(KEY)!.pine_session_state, 'none', 'its session was not recorded');
	// The next send creates the Chat's session; only its entry is current.
	assert.match(markdown(await send(a, 'from a again')), /done: from a again/);
	const conv = store.chat(KEY)!;
	const secrets = JSON.parse(vault.values.get(currentSecret(store))!);
	assert.equal(pine.calls.createSession, 2);
	assert.equal(secrets.sessionToken, `ps_${conv.pine_session_name}`);
});

test('review P2: while an earlier send is unconfirmed, later messages wait for it', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	await send(service, 'first');
	pine.drop('run');
	await send(service, 'second');
	pine.drop('run');
	const blocked = await send(service, 'third');
	// The person's typed message comes back in the line, quoted, as on every other path that does not send it.
	assert.match(markdown(blocked), /was not sent: an earlier message is still unconfirmed by Pine[^]*```text\nthird\n```/);
	await send(service, 'fourth');
	const results = store.messages(KEY).filter(m => m.kind === 'result').map(m => m.text);
	assert.deepEqual(results, ['done: first', 'done: second', 'done: fourth']);
	assert.equal(store.db.prepare("select count(*) n from saved_sends where text = 'third'").get()!.n, 0);
});

// A readiness failure that is said in its own words (the keychain refused the credentials) ends the
// send without recording it; the message is still given back, once, under that line.
test('a send whose credentials the keychain refuses gives the message back once, under the line that says why', async () => {
	const { window, pine, vault } = setup();
	const { service } = window();
	vault.failStore = true;
	const said = await drain(service.submit(KEY, 'make the poster', 'x', FOLDER));
	assert.match(markdown(said), /Could not save the Computer's credentials to the keychain/);
	const back = said.filter(u => u.kind === 'unsent');
	assert.equal(back.length, 1, markdown(said));
	assert.match(back[0].text, /Your message was not sent: the line above says why\. Here it is, to send again:_\n\n```text\nmake the poster\n```/);
	assert.equal(pine.calls.run ?? 0, 0);
});

test('review P2: gateway timeouts leave a send unknown, as the SDK defines them', async () => {
	const { ApiError } = await import('@pinesandbox/computer');
	const port = new SdkPort();
	for (const status of [408, 502, 503, 504]) {
		const error = Object.assign(Object.create(ApiError.prototype), { status, message: `HTTP ${status}` });
		await assert.rejects(port['mapped'](() => Promise.reject(error), 'send'), UnconfirmedError);
	}
	const notFound = Object.assign(Object.create(ApiError.prototype), { status: 400, message: 'bad' });
	await assert.rejects(port['mapped'](() => Promise.reject(notFound), 'send'), (e: Error) => !(e instanceof UnconfirmedError) && !(e instanceof MissingError));
});

test('a session no message has reached has no Task: task-not-found reads as none, a session Pine no longer has is gone, other problems still fail', async () => {
	const { ApiError, ProblemType } = await import('@pinesandbox/computer');
	const port = new SdkPort();
	const problem = (problemType: string) => Object.assign(Object.create(ApiError.prototype), { status: 404, problemType, message: problemType });
	const ref = { credentials: '', binding: '', name: 's', token: 't' };
	let failure = problem(ProblemType.taskNotFound);
	port['session'] = async () => ({ agent: { status: () => Promise.reject(failure) } }) as never;
	assert.equal(await port.sessionTask(ENV, ref), undefined);
	// session-not-found is the session being gone, which its caller ends as "Pine no longer has this session".
	failure = problem(ProblemType.sessionNotFound);
	await assert.rejects(port.sessionTask(ENV, ref), MissingError);
	failure = problem(ProblemType.sessionBusy);
	await assert.rejects(port.sessionTask(ENV, ref), (e: Error) => e === failure);
});

test('review P2: a usage snapshot is replaced by the final cost, and the cost is shown once', async () => {
	const { window } = setup();
	const { store, service } = window();
	const updates = await send(service, 'cast');
	const usage = store.messages(KEY).filter(m => m.kind === 'usage');
	assert.deepEqual(usage.map(m => [m.text, m.cost]), [['final', 0.01]]);
	assert.equal(markdown(updates).match(/cost of this turn/g)!.length, 1);
	assert.equal(updates.filter(u => u.kind === 'usage').length, 1, 'the cost line is its own kind of update, so Chat can leave it out');
	assert.equal(store.messages(KEY).filter(m => m.kind === 'usage').length, 1, 'the cost is saved whether or not the line is shown');
});

test('review P2: usage events without a turn id are not counted twice', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.unscopedUsage = true;
	const updates = await send(service, 'cast');
	assert.deepEqual(store.messages(KEY).filter(m => m.kind === 'usage').map(m => [m.text, m.cost]), [['final', 0.01]]);
	assert.equal(markdown(updates).match(/cost of this turn/g)!.length, 1);
});

test('review P2: a session lost while the Studio stays open: the next message starts the agent again and is sent', async () => {
	const { window, pine, vault } = setup();
	const { store, service } = window();
	await send(service, 'first');
	pine.stop(JSON.parse(vault.values.get(currentSecret(store))!).credentials);
	const sent = await send(service, 'second');
	assert.ok(sent.every(u => u.kind !== 'sessionEnded'));
	assert.match(markdown(sent), /done: second/);
	assert.equal(store.chat(KEY)!.pine_session_state, 'open');
	assert.match(markdown(await send(service, 'third')), /done: third/);
});

test('a queued answer whose question was answered meanwhile goes to the next question with the note: sent, not given back', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }, { state: 'needs_input', text: 'Which scene?' }];
	await send(service, 'draw the storyboard');
	const originalQuestion = store.chat(KEY)!.question_turn_id;
	const release = pine.hold('run');
	const first = send(service, 'EP001');
	for (let i = 0; (pine.calls.run ?? 0) < 2 && i < 500; i++) { await new Promise(r => setTimeout(r, 10)); }
	assert.equal(pine.calls.run, 2);
	const queued = send(service, 'EP002 instead');
	await new Promise(resolve => setImmediate(resolve));
	release();
	await first;
	const response = markdown(await queued);
	assert.match(response, /What your message was written for changed while it waited[^]*done: EP002 instead/);
	assert.doesNotMatch(response, /not sent/);
	assert.equal(pine.calls.run, 3, 'it answers the scene question, as written, with the note');
	const sent = store.db.prepare("select kind, target_turn_id, text from saved_sends where text like 'EP002 instead%'").get()!;
	assert.equal(sent.kind, 'run');
	assert.notEqual(sent.target_turn_id, originalQuestion);
	assert.equal(sent.text, `EP002 instead\n\n${CHANGED_TARGET_NOTE}`);
});

test('a message queued during a running turn can follow that exact turn after it completes', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'running' }, { state: 'completed', text: 'Second request completed.' }];
	const first = send(service, 'first request');
	for (let i = 0; store.chat(KEY)?.state !== 'running' && i < 500; i++) { await new Promise(r => setTimeout(r, 10)); }
	const runningTurn = store.chat(KEY)!.current_turn_id!;
	const queued = send(service, 'second request');
	await new Promise(resolve => setImmediate(resolve));
	pine.finish(runningTurn, { state: 'completed', text: 'First request completed.' });
	await first;
	assert.match(markdown(await queued), /Second request completed/);
	assert.equal(pine.calls.run, 2);
});

test('re-review P2: an unscoped backlog result does not take the next turn\'s result', async () => {
	const { window, pine } = setup();
	const { store, service } = window();
	pine.unscopedResults = true;
	pine.eventLimits = [1];
	await send(service, 'first');
	const second = await send(service, 'second');
	assert.match(markdown(second), /done: second/);
	assert.doesNotMatch(markdown(second), /done: first/);
	const results = store.db.prepare("select turn_id, text from messages where kind = 'result' order by id").all() as { turn_id: string; text: string }[];
	assert.deepEqual(results.map(r => r.text), ['done: first', 'done: second']);
	assert.notEqual(results[0].turn_id, results[1].turn_id);
});

test('second re-review P2: the meaning of a message is bound before the first wait; a question recorded meanwhile gets it with the note', async () => {
	const { window, pine, vault } = setup();
	const { store, service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }];
	await send(service, 'first');
	const asked = store.chat(KEY)!.question_turn_id!;
	// The Chat shows no question when the message is sent: it is written as a new run.
	store.tx(() => store.updateChat(KEY, { state: 'idle', question_turn_id: null }));
	vault.getDelay = 150;
	const pending = send(service, 'faster please');
	// While the keychain read waits, the Chat's background follow records the question.
	setTimeout(() => store.tx(() => store.updateChat(KEY, { state: 'needs_input', question_turn_id: asked })), 50);
	const updates = await pending;
	assert.match(markdown(updates), /What your message was written for changed while it waited/);
	const sent = store.db.prepare("select kind, target_turn_id, text from saved_sends where text like 'faster please%'").get()!;
	assert.deepEqual([sent.kind, sent.target_turn_id, sent.text], ['run', asked, `faster please\n\n${CHANGED_TARGET_NOTE}`]);
});

test("a window belongs to the session bound to its folder, or to an older session whose stored folder is open", () => {
	const chats = [
		{ key: 'pine-computer:/local-1', label: 'one', folder: null },
		{ key: 'pine-computer:/local-2', label: 'two', folder: null },
		{ key: 'pine-computer:/local-3', label: 'bound', folder: '/Users/x/Pine Drama Studio/Night Ward' },
	];
	const root = projectFolder('/projects', 'pine-computer:/local-2');
	assert.equal(owningChat(chats, '/projects', [root])?.label, 'two', 'a session made before binding, by its folder under the storage');
	assert.equal(owningChat(chats, '/projects', ['/Users/x/Pine Drama Studio/Night Ward/'])?.label, 'bound', 'a bound session, by its folder');
	assert.equal(owningChat(chats, '/projects', ['/Users/x/Pine Drama Studio/Night Ward/drama'])?.label, undefined, 'the drama/ inside is not the folder');
	assert.equal(owningChat(chats, '/projects', ['/elsewhere/drama']), undefined);
	assert.equal(owningChat(chats, '/projects', []), undefined, 'a window with no folder belongs to no session');
});

const idleOf = (pine: FakePine) => [...pine.computers.values()][0].idleTimeout;

test('idle timeout: a Computer starts with the working one, is raised while a question waits, and is set back when the answer is sent', async () => {
	const { window, pine } = setup();
	const { service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }, { state: 'completed' }];
	await send(service, 'draw the storyboard');
	assert.equal(idleOf(pine), IDLE_WAITING_SECONDS, 'raised when the turn ended with a question');
	await send(service, 'EP003');
	assert.equal(idleOf(pine), IDLE_WORKING_SECONDS, 'set back when the answer was sent');
	assert.deepEqual(pine.idleRequests, [IDLE_WAITING_SECONDS, IDLE_WORKING_SECONDS]);
	await send(service, 'thanks');
	assert.equal(pine.idleRequests.length, 2, 'an unchanged timeout is not asked for again');
});

test('idle timeout: a turn that ends without a question asks for nothing', async () => {
	const { window, pine } = setup();
	await send(window().service, 'hello');
	assert.deepEqual(pine.idleRequests, []);
});

test('idle timeout: a refusal is logged and shown, and asked again at the next call', async () => {
	const { window, pine } = setup();
	const { service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }];
	pine.fail('setIdleTimeout', new Error('conflict: the Computer changed'));
	const shown = markdown(await send(service, 'draw the storyboard'));
	assert.match(shown, /idle timeout could not be raised while you decide \(conflict: the Computer changed\)/);
	assert.equal(idleOf(pine), IDLE_WORKING_SECONDS);
	assert.match(shown, /The agent asks:\*\* Which episode\?/, 'the question still reaches the person');
});

test('idle timeout: one that could not be set back is logged for Output and not shown in Chat (issue #140)', async () => {
	const { window, pine } = setup();
	const lines: string[] = [];
	const { service } = window(line => lines.push(line));
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }, { state: 'completed' }];
	await send(service, 'draw the storyboard');
	pine.fail('setIdleTimeout', new Error('pinesandbox: Computer was started without a lifetime policy; choose the idle timeout on the next Start'));
	const shown = markdown(await send(service, 'EP003'));
	assert.doesNotMatch(shown, /idle timeout|lifetime policy/);
	assert.match(shown, /done: EP003/);
	assert.ok(lines.some(l => /could not set the Computer's idle timeout to \d+s: .*without a lifetime policy/.test(l)), lines.join('\n'));
});

test('idle timeout: after the Computer stopped and a new session began, the next question raises it again', async () => {
	const { window, pine, vault } = setup();
	const { service, store } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }];
	await send(service, 'draw the storyboard');
	pine.stop(JSON.parse(vault.values.get(currentSecret(store))!).credentials as string);
	// The next message starts the agent again on the stopped Computer and is sent there.
	await send(service, 'EP003');
	assert.equal(store.chat(KEY)!.pine_session_state, 'open');
	assert.equal(idleOf(pine), IDLE_WORKING_SECONDS, 'a restarted Computer has the working timeout');
	pine.plans = [{ state: 'needs_input', text: 'Which scene?' }];
	await send(service, 'again');
	assert.equal(idleOf(pine), IDLE_WAITING_SECONDS);
	assert.deepEqual(pine.idleRequests, [IDLE_WAITING_SECONDS, IDLE_WAITING_SECONDS]);
});

test('idle timeout: a project without a lifetime policy starts its Computers with the waiting timeout and never calls setIdleTimeout', async () => {
	const { window, pine } = setup();
	pine.policy = { adjustable: false, maxIdleSeconds: null };
	const { service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }, { state: 'completed' }];
	await send(service, 'draw the storyboard');
	assert.equal(idleOf(pine), IDLE_WAITING_SECONDS);
	await send(service, 'EP003');
	assert.equal(idleOf(pine), IDLE_WAITING_SECONDS, 'fixed at start');
	assert.equal(pine.calls.setIdleTimeout ?? 0, 0);
});

test('idle timeout: a project with a lifetime policy gets timeouts clamped to its maximum, at start and when raised', async () => {
	const { window, pine } = setup();
	pine.policy = { adjustable: true, maxIdleSeconds: 1800 };
	const { service } = window();
	pine.plans = [{ state: 'needs_input', text: 'Which episode?' }, { state: 'completed' }];
	await send(service, 'draw the storyboard');
	assert.equal(idleOf(pine), 1800, 'the working timeout is clamped at start and the raise asks for the same');
	assert.deepEqual(pine.idleRequests, []);
	await send(service, 'EP003');
	assert.deepEqual(pine.idleRequests, []);
});

test('idle timeout: a project policy that cannot be read fails visibly at start and starts no Computer', async () => {
	const { window, pine } = setup();
	const { service } = window();
	pine.fail('idlePolicy', new Error('policy unavailable'));
	await assert.rejects(send(service, 'hello'), /policy unavailable/);
	assert.equal(pine.calls.create ?? 0, 0, 'no Computer was started without knowing the policy');
});

/**
 * pine-dev, 2026-11-02: a window following an answer's turn is reloaded; the restored window's Chat opens the Chat
 * (activeResponseCallback, follow) at once. Window a is the reloaded one: it sent the answer
 * and dies while its turn runs (its store closes with it); window b is the window after the reload.
 */
async function reloadedWhileRunning() {
	const path = join(mkdtempSync(join(tmpdir(), 'pine-studio-')), 'studio.sqlite');
	const pine = new FakePine();
	const vault = new MemoryVault();
	const make = () => {
		const store = new Store(path);
		return { store, service: new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault, pine: ENV }) };
	};
	const a = make();
	pine.plans = [{ state: 'needs_input', text: 'Which look?' }, { state: 'running' }];
	await send(a.service, 'first');
	const inflight = a.service.submit(KEY, 'the red one', 'x');
	for await (const update of inflight) {
		if (update.kind === 'activity' && /working on the red one/.test(update.text)) {
			break; // the window goes away mid-turn; nothing cancels the turn on Pine
		}
	}
	const turnId = a.store.chat(KEY)!.current_turn_id!;
	a.store.close();
	const sent = { run: pine.calls.run, steer: pine.calls.steer ?? 0 };
	const b = make();
	assert.equal(b.store.chat(KEY)!.state, 'running');
	return { pine, b, turnId, make, sent };
}

test('reload while a turn runs: the restored window follows the turn at once; nothing is sent again', async () => {
	const { pine, b, turnId, sent } = await reloadedWhileRunning();
	setTimeout(() => pine.finish(turnId, { state: 'needs_input', text: 'Which shot?' }), 600);
	const updates = await drain(b.service.attachChatToPineTurn(KEY));
	// The window that reloaded held the project's window lock until its process ended: nothing is left to wait out.
	assert.doesNotMatch(updates.filter(u => u.kind === 'progress').map(u => u.text).join('\n'), /Waiting up to/);
	assert.match(markdown(updates), /The agent asks:\*\* Which shot\?/);
	assert.doesNotMatch(markdown(updates), /Not sent|another Studio window/);
	assert.deepEqual({ run: pine.calls.run, steer: pine.calls.steer ?? 0 }, sent);
	assert.equal(b.store.db.prepare("select count(*) n from saved_sends where text = 'the red one'").get()!.n, 1);
	assert.deepEqual([b.store.chat(KEY)!.state, b.store.chat(KEY)!.question_turn_id], ['needs_input', turnId]);
});

test('reload while a turn runs, and the turn ends while no window is open: the restored window records its end; nothing is sent', async () => {
	const { pine, b, turnId, sent } = await reloadedWhileRunning();
	pine.finish(turnId, { state: 'completed', text: 'all four shots drawn' });
	const updates = await drain(b.service.attachChatToPineTurn(KEY));
	assert.match(markdown(updates), /all four shots drawn/);
	assert.deepEqual({ run: pine.calls.run, steer: pine.calls.steer ?? 0 }, sent);
	assert.equal(b.store.chat(KEY)!.state, 'idle');
	assert.equal(b.store.messages(KEY).filter(m => m.kind === 'result' && m.turn_id === turnId).length, 1);
});

// One Pine environment per Studio (sections 2-4).

test('one Pine environment: with none set up, a message is refused before anything is written or sent', async () => {
	const { path, pine, vault } = setup();
	const store = new Store(path);
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault, pine: undefined });
	await assert.rejects(send(service, 'make the drama'), (error: Error) => error instanceof NoPineError && error.message === 'No Pine environment is set up, so nothing was sent.');
	assert.equal(pine.calls.run ?? 0, 0);
	assert.equal(pine.calls.ensureComputer ?? 0, 0);
	assert.equal(store.chats().length, 0);
});


test('one Pine environment: a session of another endpoint is refused in its words, and Stop All leaves its Computer', async () => {
	const { path, window, pine, vault } = setup();
	const { service } = window();
	await send(service, 'first');
	const runs = pine.calls.run;
	const prod: PineConnection = { endpoint: 'https://pinesandbox.io', apiKey: 'pk_prod_secret' };
	const other = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store: new Store(path), port: pine, vault, pine: prod });
	await assert.rejects(send(other, 'second'), (error: Error) => error instanceof OtherPineError && error.message ===
		'**This session ran on `lvh.me:18080`; the Studio now connects to `pinesandbox.io`.** Its history stays here. To continue it, set the Studio back to that Pine environment and reopen it, or start a new session.');
	assert.equal(pine.calls.run, runs);
	assert.deepEqual(await other.stopAll(), [], 'a previous Pine environment\'s Computers are stopped by swapping back to its file');
	assert.equal((await service.stopAll()).length, 1);
});

test('one Pine environment: a session saved under an environment name reads as a session of its stored endpoint', async () => {
	const { window } = setup();
	const { store, service } = window();
	await send(service, 'first');
	// Before 2026-11-02 the env column named the environment; a profile keeps such rows ("default" was production).
	store.db.prepare('update chats set env = ? where key = ?').run('default', KEY);
	assert.match(markdown(await send(service, 'second')), /done: second/);
	assert.doesNotMatch(markdown(await send(service, 'third')), /default|dev ·/);
});

test('Pine\'s 409 computer-stopped, on a call or on the event stream, is the resource gone (MissingError), not an error to show', async () => {
	const { ApiError } = await import('@pinesandbox/computer');
	const port = new SdkPort();
	const stopped = Object.assign(Object.create(ApiError.prototype), { status: 409, problemType: '/errors/computer-stopped', message: 'pinesandbox: 409 /errors/computer-stopped: Computer is stopped' });
	await assert.rejects(port['mapped'](() => Promise.reject(stopped), 'none'), MissingError);
	const ref = { credentials: '', binding: '', name: 's', token: 't' };
	port['session'] = async () => ({ agent: { events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(stopped) }) }) } }) as never;
	await assert.rejects(async () => { for await (const _ of port.events(ENV, ref, undefined, undefined, new AbortController().signal)) { /* none */ } }, MissingError);
	// Another 409 stays what it is.
	const other = Object.assign(Object.create(ApiError.prototype), { status: 409, problemType: '/errors/session-busy', message: 'busy' });
	await assert.rejects(port['mapped'](() => Promise.reject(other), 'none'), (e: Error) => e === other);
});

test('an agent step is one update by its id: a running step and its end are the same row, in the agent\'s own words', async () => {
	const { window, pine } = setup();
	const { service } = window();
	pine.plans = [{ state: 'completed', text: 'Done.', steps: [{ id: 'a1', title: 'Run drama-cli jobs', state: 'running' }, { id: 'a1', title: 'Run drama-cli jobs', state: 'completed' }, { id: 'a2', title: 'Write plan.md', state: 'failed' }] }];
	const updates = await send(service, 'go');
	assert.deepEqual(updates.filter(u => u.kind === 'activity' && u.id.startsWith('a')), [
		{ kind: 'activity', id: 'a1', text: 'Run drama-cli jobs', state: 'running' },
		{ kind: 'activity', id: 'a1', text: 'Run drama-cli jobs', state: 'completed' },
		{ kind: 'activity', id: 'a2', text: 'Write plan.md', state: 'failed' },
	]);
});

test('between two activities the stream has no plain progress row: the agent\'s message and the cost are not one (Code-OSS groups tools only across pinnable parts)', async () => {
	const { window, pine } = setup();
	const { service, store } = window();
	pine.plans = [{ state: 'completed', text: 'Done.', steps: [{ id: 'a1', title: 'Run drama-cli jobs', state: 'running' }, { said: 'Both leads are drawn; finishing the assets…' }, { id: 'a2', title: 'Write plan.md', state: 'running' }] }];
	const updates = await send(service, 'go');
	const turn = updates.slice(updates.findIndex(u => u.kind === 'activity'));
	const firstTool = turn.findIndex(u => u.kind === 'activity' && u.id === 'a1');
	const lastTool = turn.findIndex(u => u.kind === 'activity' && u.id === 'a2');
	assert.ok(firstTool >= 0 && lastTool > firstTool);
	assert.deepEqual(turn.slice(firstTool, lastTool + 1).map(u => u.kind), ['activity', 'activity', 'activity'], 'activity, the message, activity: all rows of the chain');
	assert.deepEqual(turn[firstTool + 1], { kind: 'activity', id: (turn[firstTool + 1] as { id: string }).id, text: 'Both leads are drawn; finishing the assets…', state: 'completed' });
	assert.equal(turn.some(u => u.kind === 'progress' && /Cost so far/.test(u.text)), false);
	assert.ok(store.messages(KEY).some(m => m.kind === 'usage' || m.cost !== null), 'the cost is still saved');
});
