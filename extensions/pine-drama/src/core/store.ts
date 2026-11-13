// The Chats' business state in SQLite (node:sqlite), shared by every Studio window.
// Secrets are not here:
// a row names its secret (`secret_ref`) in the vault. No vscode import.

import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { entryFor } from './binding';
import { DatabaseSync } from 'node:sqlite';
import { assertProjectRoot, projectIdentity } from './projectPlace';

export type ComputerState = 'none' | 'creating' | 'running' | 'stopped' | 'missing_credentials';
export type PineSessionState = 'none' | 'open' | 'ended';
export type ChatState = 'idle' | 'running' | 'needs_input' | 'failed';
export type SavedSendKind = 'run' | 'answer';
export type SavedSendState = 'pending' | 'sent' | 'unknown' | 'failed';
/** `unused`: a result that is not used, with its reason (resultImporter.ts, notUsedLine), shown as a native warning. */
export type MessageKind = 'prompt' | 'instructions' | 'decision' | 'progress' | 'activity' | 'result' | 'question' | 'usage' | 'failed' | 'notice' | 'unused';


export interface Chat {
	key: string;
	env: string;
	endpoint: string;
	label: string;
	secret_ref: string;
	/** The vault entry `<secret_ref>.<secret_gen>` that is current; null until secrets are saved. */
	secret_gen: string | null;
	computer_id: string | null;
	computer_state: ComputerState;
	pine_session_name: string | null;
	pine_session_state: PineSessionState;
	task_id: string | null;
	last_applied_event_id: number | null;
	state: ChatState;
	current_turn_id: string | null;
	question_turn_id: string | null;
	/** The run that carried the standing instructions in this session; null until one is sent (instructions.ts). */
	standing_saved_send_id: string | null;
	/**
	 * The canonical local project association. Null until explicitly associated; `projectRootOf` also supports
	 * per-Chat storage for the existing unbound core path. This field alone grants no execution authority.
	 */
	folder: string | null;
	/**
	 * 'main' for the project's pinned Project Chat, set when the project is admitted (bindFolder, admitExistingProject).
	 * Null for every other session of the project, whose results are installed under episodes/ only (sessionScoped).
	 */
	project_role: 'main' | null;
	created_at: string;
	updated_at: string;
}

export interface SavedSend {
	id: string;
	chat_key: string;
	kind: SavedSendKind;
	text: string;
	target_turn_id: string | null;
	state: SavedSendState;
	turn_id: string | null;
	error: string | null;
	/** Unused since chats cannot be cancelled; kept so a database opens unchanged. */
	cancel_requested: number;
	/** The Chat's last applied event id when it was saved: its input event can only come after. */
	after_event: number | null;
	/** The review this send answers; the review is answered when the send is. */
	review_id: string | null;
	created_at: string;
}

export interface Message {
	id: number;
	chat_key: string;
	turn_id: string | null;
	saved_send_id: string | null;
	kind: MessageKind;
	text: string;
	cost: number | null;
	currency: string | null;
	at: string;
}

export interface LibraryFile {
	id: number;
	chat_key: string;
	turn_id: string;
	sha: string;
	rel_path: string;
	size: number;
	type: string;
	kind: string;
	created_at: string;
}

export interface ReviewRow {
	id: string;
	chat_key: string;
	turn_id: string;
	kind: string;
	subject: string;
	question: string;
	items: string;
	verdicts: string;
	state: 'open' | 'answered' | 'closed';
	answer: string | null;
	created_at: string;
	decided_at: string | null;
}


export interface TurnFollowUp {
	turn_id: string;
	chat_key: string;
	state: string;
	asked: string;
	done: number;
	save_error: string | null;
	returned: string;
	created_at: string;
}

const SCHEMA_VERSION = 16;
const SCHEMA = `
create table if not exists chats (
  key text primary key,               -- the chat session resource
  env text not null,
  endpoint text not null,             -- the environment's endpoint when the Chat began
  label text not null,
  secret_ref text not null,           -- the vault entries' prefix
  secret_gen text,                    -- the current entry, <secret_ref>.<secret_gen>: credentials, binding, session token
  computer_id text,
  computer_state text not null,       -- none | creating | running | stopped | missing_credentials
  pine_session_name text,
  pine_session_state text not null,        -- none | open | ended
  task_id text,
  last_applied_event_id integer,      -- the last applied event id of task_id
  state text not null,                -- idle | running | needs_input | failed
  current_turn_id text,
  question_turn_id text,
  standing_saved_send_id text,                -- the run that carried the standing instructions in this session
  folder text,                        -- the drama's folder the session is bound to; null: its folder under the extension's storage
  project_role text check (project_role in ('main')), -- main: the pinned Project Chat; null: another session of the project
  created_at text not null,
  updated_at text not null,
  check (folder is not null or project_role is null)
);
-- Canonical folders and explicit roles: no title, insertion order or runtime observation chooses a Project Chat.
create unique index if not exists project_main_chat on chats(folder) where project_role = 'main';
-- Every send, saved before it is sent; id is the idempotency key of a run.
create table if not exists saved_sends (
  id text primary key,
  chat_key text not null references chats(key),
  kind text not null,                 -- run | answer (steer, before D25)
  text text not null,
  target_turn_id text,                -- an answer: the turn it addresses
  state text not null,                -- pending | sent | unknown | failed
  turn_id text,                       -- the turn it opened
  error text,
  cancel_requested integer not null default 0, -- unused since D25 (no Stop); kept so a database opens unchanged
  after_event integer,                -- the last applied event id when it was saved
  review_id text,                     -- the review this send answers; it is answered when the send is
  created_at text not null,
  updated_at text not null
);
create table if not exists messages (
  id integer primary key,
  chat_key text not null references chats(key),
  turn_id text,
  saved_send_id text,
  kind text not null,                 -- prompt | instructions | progress | activity | result | question | usage | failed | notice | unused
  text text not null,
  cost real,
  currency text,
  at text not null
);
-- One prompt per saved send; one final result, question, usage or failure per turn.
create unique index if not exists messages_prompt on messages (saved_send_id) where kind = 'prompt';
create unique index if not exists messages_final on messages (chat_key, turn_id, kind)
  where turn_id is not null and kind in ('result', 'question', 'usage', 'failed');
-- Turns in the order Pine started them: the first run or event that names one fixes its place, so a record that
-- is saved late never overtakes a newer turn's.
create table if not exists turns (
  seq integer primary key,
  chat_key text not null,
  turn_id text not null,
  unique (chat_key, turn_id)
);
-- Applied events, so a replayed event changes nothing.
create table if not exists events (
  chat_key text not null,
  task_id text not null,
  event_id integer not null,
  primary key (chat_key, task_id, event_id)
);
-- The library's index (doc/adapters/computer-read.md): every file a turn returned. Bytes live outside the database, once
-- each, named by SHA-256 (core/library.ts). Ported from open-pinedrama src/engine/db.ts files table.
create table if not exists library_files (
  id integer primary key,
  chat_key text not null references chats(key),
  turn_id text not null,
  sha text not null,
  rel_path text not null,             -- relative to the session's working directory
  size integer not null,
  type text not null,                 -- media type
  kind text not null,                 -- core/library.ts Origin.kind: archive, or other
  created_at text not null,
  unique (turn_id, rel_path)
);
create index if not exists library_files_path on library_files (chat_key, rel_path, sha);
-- One row per ended turn: the follow-up it still owes (import its results, then open its Review), marked done when finished,
-- so a follow-up the Studio stopped halfway is taken up again where it was (open-pinedrama turns.settled, turns.save_error).
create table if not exists turn_follow_ups (
  turn_id text primary key,
  chat_key text not null references chats(key),
  state text not null,                -- how the turn ended
  asked text not null,                -- its question, or its summary: the files it names are fetched
  done integer not null default 0,
  save_error text,
  returned text not null default '[]', -- the paths the turn returned, as Pine listed them
  created_at text not null
);
-- What a stop asks the person to decide (core/reviews.ts; open-pinedrama reviews table). The record is generic: a kind
-- and subject for the wording, the items to give a verdict on (JSON: key, label, files), and the verdicts given so far.
create table if not exists reviews (
  id text primary key,
  chat_key text not null references chats(key),
  turn_id text not null,
  kind text not null,                 -- looks | references | storyboards | takes | cut | question, or another feature's own
  subject text not null,              -- what was reviewed, as the answer words it
  question text not null,
  items text not null default '[]',
  verdicts text not null default '{}',-- item key -> { verdict, reason }; the draft until the answer is sent
  state text not null,                -- open | answered | closed (the Chat moved on without a decision)
  answer text,
  created_at text not null,
  decided_at text,
  unique (chat_key, turn_id)
);
-- A review one window asks another to reveal: the session's project window reads it when it activates or gains focus
-- (doc/workbench/right-region.md, "Revealing a decision in another window").
create table if not exists reveal_requests (
  chat_key text primary key references chats(key),
  review_id text not null,
  requested_at integer not null
);
-- A named Chat destination for another project window. Navigation only, never execution/Review authority.
create table if not exists chat_reveal_requests (
  project text primary key,
  chat_key text not null references chats(key),
  token text not null unique,
  requested_at integer not null
);
-- A task's record (doc/architecture/local-first-remote-execution.md, 6.1): committed before anything is dispatched, since
-- Pine keeps no task record beyond a Computer (11.1). One open record per stage. A record ends only on completion,
-- charged-not-selected (including a result that can never be installed, 6.2) or lost-charged; nothing else ends it. The completion record is the one
-- replay keys on (6.2). Producing-runtime attribution is immutable from schema 11 onward.
`;


/** Where a database of another schema is set aside: beside it, named by its schema and the time, never over a file. */
function asidePath(path: string, schema: number, at: Date): string {
	const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const base = `${path}.schema${schema}-${stamp}`;
	let aside = base;
	for (let n = 2; ['', '-wal', '-shm'].some(suffix => existsSync(aside + suffix)); n++) { aside = `${base}-${n}`; }
	return aside;
}

/** What the person is told when an older database was set aside: plain words, and where it is. */
export function setAsideNotice(aside: { path: string }): string {
	return `Earlier Chat history from an older version of Pine Drama Studio was set aside at ${aside.path}. Open your project folder and continue in its pinned session: your work is in the folder.`;
}


export class Store {
	readonly db: DatabaseSync;
	/** A database of another schema this Store set aside when it opened, with the schema it had. */
	readonly setAside: { schema: number; path: string } | undefined;

	constructor(path: string, readonly now: () => number = Date.now) {
		this.db = new DatabaseSync(path);
		// No migration while the product is in development. A database of another schema is
		// neither read nor rewritten, nor deleted: it is renamed aside, byte for byte, and a fresh one opens. The drama's folder is its only copy, so the work continues from the folder.
		const version = (this.db.prepare('pragma user_version').get() as { user_version: number }).user_version;
		if (version !== 0 && version !== SCHEMA_VERSION) {
			this.db.close();
			const aside = asidePath(path, version, new Date(now()));
			// The journal files first, so that a stale -wal never lies beside the fresh database.
			for (const suffix of ['-wal', '-shm', '']) {
				if (existsSync(path + suffix)) { renameSync(path + suffix, aside + suffix); }
			}
			this.setAside = { schema: version, path: aside };
			this.db = new DatabaseSync(path);
		}
		this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;');
		this.db.exec(SCHEMA);
		this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
	}

	close(): void {
		this.db.close();
	}

	iso(): string {
		return new Date(this.now()).toISOString();
	}

	/** Runs `work` in one write transaction (begin immediate: takes the write lock up front). */
	tx<T>(work: () => T): T {
		this.db.exec('begin immediate');
		try {
			const result = work();
			this.db.exec('commit');
			return result;
		} catch (error) {
			this.db.exec('rollback');
			throw error;
		}
	}

	/** Asks the window of `key`'s project to reveal a review of the Chat `key`; a newer request replaces an older one. */
	requestReveal(key: string, reviewId: string): void {
		this.db.prepare('insert into reveal_requests (chat_key, review_id, requested_at) values (?, ?, ?) on conflict (chat_key) do update set review_id = excluded.review_id, requested_at = excluded.requested_at')
			.run(key, reviewId, this.now());
	}

	/**
	 * The review a project's window reveals: the newest request for any of its Chats (`keys`, the project's members) made
	 * within `maxAgeMs`. Every request of the project is consumed either way. The request names its Chat and the window
	 * takes by project, so no request is keyed by one session (fix plan, item 9).
	 */
	takeReveal(keys: readonly string[], maxAgeMs: number): string | undefined {
		if (!keys.length) { return undefined; }
		const marks = keys.map(() => '?').join(', ');
		return this.tx(() => {
			const row = this.db.prepare(`select review_id, requested_at from reveal_requests where chat_key in (${marks}) order by requested_at desc limit 1`).get(...keys) as { review_id: string; requested_at: number } | undefined;
			this.db.prepare(`delete from reveal_requests where chat_key in (${marks})`).run(...keys);
			return row && this.now() - row.requested_at <= maxAgeMs ? row.review_id : undefined;
		});
	}

	requestChatReveal(key: string): string {
		const conv = this.chat(key);
		if (!conv?.folder) { throw new Error('This conversation has no associated project to open.'); }
		const token = randomUUID();
		this.db.prepare(`insert into chat_reveal_requests (project, chat_key, token, requested_at) values (?, ?, ?, ?)
			on conflict(project) do update set chat_key = excluded.chat_key, token = excluded.token, requested_at = excluded.requested_at`)
			.run(conv.folder, key, token, this.now());
		return token;
	}

	/** A failed earlier open cannot erase a newer click, even when both name the same Chat. */
	clearChatReveal(token: string): void {
		this.db.prepare('delete from chat_reveal_requests where token = ?').run(token);
	}

	/** Last explicit click wins inside this project; another project's request remains untouched. */
	takeChatReveal(project: string, maxAgeMs: number): string | undefined {
		return this.tx(() => {
			const root = projectIdentity(project);
			const row = this.db.prepare(`select r.chat_key, r.token, r.requested_at from chat_reveal_requests r
				join chats c on c.key = r.chat_key where r.project = ? and c.folder = r.project`)
				.get(root) as { chat_key: string; token: string; requested_at: number } | undefined;
			if (row) { this.clearChatReveal(row.token); }
			const now = this.now();
			return row && row.requested_at <= now && now - row.requested_at <= maxAgeMs ? row.chat_key : undefined;
		});
	}

	// ---- Chats ----


	/**
	 * Whether `key`'s results are installed under episodes/ only: a session of a project other than its Project Chat
	 * (taskScope.ts; told so by EPISODE_SESSION, core/instructions.ts). An unattributed result, or the Project Chat's, may write the whole project.
	 */
	sessionScoped(key: string | null): boolean {
		const conv = key ? this.chat(key) : undefined;
		return !!conv?.folder && conv.project_role !== 'main';
	}


	/** Exact generated feedback identity, not language interpretation. A queued duplicate cannot start another turn. */
	submittedReviewForAnswer(key: string, text: string): Pick<ReviewRow, 'id' | 'state'> | undefined {
		return this.db.prepare(`select r.id, r.state from reviews r
			where r.chat_key = ? and r.answer = ? order by r.created_at desc, r.rowid desc limit 1`)
			.get(key, text) as Pick<ReviewRow, 'id' | 'state'> | undefined;
	}


	chat(key: string): Chat | undefined {
		return this.db.prepare('select * from chats where key = ?').get(key) as Chat | undefined;
	}

	chats(): Chat[] {
		return this.db.prepare('select * from chats order by created_at').all() as unknown as Chat[];
	}

	insertChat(c: Pick<Chat, 'key' | 'env' | 'endpoint' | 'label' | 'secret_ref'>): void {
		const at = this.iso();
		this.db.prepare(`insert into chats (key, env, endpoint, label, secret_ref, computer_state, pine_session_state, state, created_at, updated_at)
			values (?, ?, ?, ?, ?, 'none', 'none', 'idle', ?, ?)`).run(c.key, c.env, c.endpoint, c.label, c.secret_ref, at, at);
	}

	/** Exact associations only; reading them starts no runtime and never picks a Chat by title or age. */
	projectChats(project: string): Chat[] {
		return this.db.prepare('select * from chats where folder = ? order by created_at, key')
			.all(projectIdentity(project)) as unknown as Chat[];
	}

	/** The project's pinned Project Chat, once the project is admitted. */
	projectChat(project: string): Chat | undefined {
		return this.db.prepare(`select * from chats where folder = ? and project_role = 'main'`).get(projectIdentity(project)) as Chat | undefined;
	}


	/** Missing folder metadata is not proof that earlier runtime work belongs to a newly selected project. */
	private assertUnboundHistory(conv: Chat): void {
		if (conv.folder) { return; }
		const history = this.db.prepare(`select 1 from saved_sends where chat_key = ?
			union all select 1 from messages where chat_key = ?
			union all select 1 from library_files where chat_key = ? limit 1`)
			.get(conv.key, conv.key, conv.key);
		if (conv.computer_id || conv.computer_state !== 'none' || conv.pine_session_state !== 'none' || conv.task_id || conv.state !== 'idle' || history) {
			throw new Error('This conversation has execution history. Reconcile its existing project before assigning a folder.');
		}
	}

	/** First production admission, atomically: an empty root's first Chat becomes its Project Chat, a later one a session. */
	bindFolder(key: string, folder: string): boolean {
		return this.tx(() => {
			const conv = this.chat(key);
			if (!conv || conv.folder) { return false; }
			this.assertUnboundHistory(conv);
			const root = projectIdentity(folder);
			const entry = entryFor(this.chats(), '', key, root);
			if (entry.kind !== 'go' || !entry.bind) { return false; }
			this.db.prepare('update chats set folder = ?, project_role = ?, updated_at = ? where key = ?')
				.run(root, this.projectChat(root) ? null : 'main', this.iso(), key);
			return true;
		});
	}

	/** First explicit send after CLI validation. Recheck authority atomically; navigation never calls this. */
	admitExistingProject(key: string, root: string): void {
		this.tx(() => {
			assertProjectRoot(root, root);
			const conv = this.chat(key);
			if (!conv) { throw new Error('The project conversation no longer exists.'); }
			this.assertUnboundHistory(conv);
			if (entryFor(this.chats(), '', key, root).kind !== 'adopt') {
				throw new Error('Project admission changed during validation. Reopen its Project Chat and retry.');
			}
			// No Project Chat is not evidence that old work finished. This path admits pristine Chats only;
			// attributable recovery/handoff must reconcile retained runtime history separately.
			for (const associated of [conv, ...this.projectChats(root).filter(c => c.key !== key)]) {
				const work = this.db.prepare(`select 1 from saved_sends where chat_key = ?
					union all select 1 from reviews where chat_key = ? limit 1`).get(associated.key, associated.key);
				if (work || associated.computer_state !== 'none' || associated.pine_session_state !== 'none' || associated.computer_id || associated.task_id || associated.state !== 'idle') {
					throw new Error('This project has execution history without its Project Chat. Reconcile its original runtime before continuing.');
				}
			}
			this.db.prepare(`update chats set folder = ?, project_role = 'main',
				updated_at = ? where key = ?`).run(root, this.iso(), key);
		});
	}

	updateChat(key: string, patch: Partial<Omit<Chat, 'key' | 'created_at' | 'updated_at' | 'folder' | 'project_role'>>): void {
		const entries = Object.entries(patch);
		if (entries.some(([key]) => ['folder', 'project_role'].includes(key))) {
			throw new Error('Project association and the Project Chat require explicit admission.');
		}
		if (entries.length === 0) {
			return;
		}
		const sets = entries.map(([column]) => `${column} = ?`).join(', ');
		this.db.prepare(`update chats set ${sets}, updated_at = ? where key = ?`)
			.run(...entries.map(([, value]) => value as string | number | null), this.iso(), key);
	}

	// ---- operations ----

	insertSavedSend(op: Pick<SavedSend, 'id' | 'chat_key' | 'kind' | 'text' | 'target_turn_id'> & { after_event?: number | null; review_id?: string | null }): void {
		const at = this.iso();
		this.db.prepare(`insert into saved_sends (id, chat_key, kind, text, target_turn_id, state, after_event, review_id, created_at, updated_at)
			values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(op.id, op.chat_key, op.kind, op.text, op.target_turn_id, op.after_event ?? null, op.review_id ?? null, at, at);
	}

	updateSavedSend(id: string, patch: Partial<Pick<SavedSend, 'state' | 'turn_id' | 'error'>>): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([column]) => `${column} = ?`).join(', ');
		this.db.prepare(`update saved_sends set ${sets}, updated_at = ? where id = ?`)
			.run(...entries.map(([, value]) => value as string | number | null), this.iso(), id);
	}

	/** The runs and answers whose turn is `turnId`: each is a task of its own (local-first, 6.1). */
	savedSendsOfTurn(key: string, turnId: string): SavedSend[] {
		return this.db.prepare("select * from saved_sends where chat_key = ? and turn_id = ? and kind in ('run', 'answer') order by created_at").all(key, turnId) as unknown as SavedSend[];
	}

	savedSend(id: string): SavedSend | undefined {
		return this.db.prepare('select * from saved_sends where id = ?').get(id) as SavedSend | undefined;
	}

	/** Sends whose outcome is not known yet, oldest first. */
	unconfirmedSavedSends(key: string): SavedSend[] {
		return this.db.prepare("select * from saved_sends where chat_key = ? and state in ('pending', 'unknown') order by created_at").all(key) as unknown as SavedSend[];
	}

	// ---- messages and events ----

	/** Adds a message; false when its unique slot (a prompt's operation, a turn's final kind) is taken. */
	/** Adds a message; returns its id, or undefined when a unique index already holds one like it. */
	addMessage(m: Omit<Message, 'id' | 'at'>): number | undefined {
		const result = this.db.prepare(`insert into messages (chat_key, turn_id, saved_send_id, kind, text, cost, currency, at)
			values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`)
			.run(m.chat_key, m.turn_id, m.saved_send_id, m.kind, m.text, m.cost, m.currency, this.iso());
		return result.changes > 0 ? Number(result.lastInsertRowid) : undefined;
	}


	/** Moves one operation's messages of these kinds to another operation; returns the kinds moved. */
	moveMessages(from: string, to: string, kinds: readonly MessageKind[]): MessageKind[] {
		const moved = this.db.prepare(`select distinct kind from messages where saved_send_id = ? and kind in (${kinds.map(() => '?').join(', ')})`).all(from, ...kinds) as unknown as { kind: MessageKind }[];
		this.db.prepare(`update messages set saved_send_id = ? where saved_send_id = ? and kind in (${kinds.map(() => '?').join(', ')})`).run(to, from, ...kinds);
		return moved.map(row => row.kind);
	}

	messages(key: string): Message[] {
		return this.db.prepare('select * from messages where chat_key = ? order by id').all(key) as unknown as Message[];
	}

	/**
	 * The turn's one cost record. A snapshot replaces it until a final cost settles it; later
	 * snapshots and a repeated final change nothing. True when the record changed.
	 */
	setTurnCost(key: string, turnId: string, cost: number | null, currency: string, final: boolean): boolean {
		const result = this.db.prepare(`insert into messages (chat_key, turn_id, saved_send_id, kind, text, cost, currency, at)
			values (?, ?, null, 'usage', ?, ?, ?, ?)
			on conflict (chat_key, turn_id, kind) where turn_id is not null and kind in ('result', 'question', 'usage', 'failed')
			do update set text = excluded.text, cost = excluded.cost, currency = excluded.currency, at = excluded.at
			where messages.text <> 'final'`)
			.run(key, turnId, final ? 'final' : 'snapshot', cost, currency, this.iso());
		return result.changes > 0;
	}

	/** Fixes the turn's place in Pine's order the first time it is named; later calls change nothing. */
	noteTurn(key: string, turnId: string): void {
		this.db.prepare('insert into turns (chat_key, turn_id) values (?, ?) on conflict do nothing').run(key, turnId);
	}

	/** Records an event as applied; false when it already was. Must run in the transaction that applies it. */
	markEvent(key: string, taskId: string, eventId: number): boolean {
		const result = this.db.prepare('insert into events (chat_key, task_id, event_id) values (?, ?, ?) on conflict (chat_key, task_id, event_id) do nothing')
			.run(key, taskId, eventId);
		return result.changes > 0;
	}

	// ---- library ----

	libraryFile(turnId: string, relPath: string): LibraryFile | undefined {
		return this.db.prepare('select * from library_files where turn_id = ? and rel_path = ?').get(turnId, relPath) as LibraryFile | undefined;
	}

	/** The first row of this path with these bytes (open-pinedrama library.ts `seenBefore` and `save`). */
	libraryFileBySha(key: string, relPath: string, sha: string): LibraryFile | undefined {
		return this.db.prepare('select * from library_files where chat_key = ? and rel_path = ? and sha = ? order by id limit 1').get(key, relPath, sha) as LibraryFile | undefined;
	}

	libraryKnows(key: string, relPath: string): boolean {
		return this.db.prepare('select 1 from library_files where chat_key = ? and rel_path = ? limit 1').get(key, relPath) !== undefined;
	}

	libraryFileById(id: number): LibraryFile | undefined {
		return this.db.prepare('select * from library_files where id = ?').get(id) as LibraryFile | undefined;
	}

	/** Every settle of a Chat, oldest first: what each stop listed, and whether it finished. */
	turnFollowUps(key: string): TurnFollowUp[] {
		return this.db.prepare('select * from turn_follow_ups where chat_key = ? order by created_at, rowid').all(key) as unknown as TurnFollowUp[];
	}

	libraryFiles(turnId: string): LibraryFile[] {
		return this.db.prepare('select * from library_files where turn_id = ? order by id').all(turnId) as unknown as LibraryFile[];
	}


	insertLibraryFile(f: Omit<LibraryFile, 'id' | 'created_at'>): number {
		const result = this.db.prepare(`insert into library_files (chat_key, turn_id, sha, rel_path, size, type, kind, created_at)
			values (?, ?, ?, ?, ?, ?, ?, ?)`).run(f.chat_key, f.turn_id, f.sha, f.rel_path, f.size, f.type, f.kind, this.iso());
		return Number(result.lastInsertRowid);
	}

	// ---- settling ----

	/** Opens the settle of an ended turn; a repeat keeps the steps already done. */
	startTurnFollowUp(key: string, turnId: string, state: string, asked: string): TurnFollowUp {
		this.db.prepare('insert into turn_follow_ups (turn_id, chat_key, state, asked, created_at) values (?, ?, ?, ?, ?) on conflict do nothing')
			.run(turnId, key, state, asked, this.iso());
		return this.turnFollowUp(turnId)!;
	}

	turnFollowUp(turnId: string): TurnFollowUp | undefined {
		return this.db.prepare('select * from turn_follow_ups where turn_id = ?').get(turnId) as TurnFollowUp | undefined;
	}

	updateTurnFollowUp(turnId: string, patch: Partial<Pick<TurnFollowUp, 'done' | 'save_error' | 'returned'>>): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([column]) => `${column} = ?`).join(', ');
		this.db.prepare(`update turn_follow_ups set ${sets} where turn_id = ?`).run(...entries.map(([, value]) => value as string | number | null), turnId);
	}

	/** Turns of this Chat that ended with their follow-up not done, oldest first. */
	unfinishedTurnFollowUps(key: string): TurnFollowUp[] {
		return this.db.prepare('select * from turn_follow_ups where chat_key = ? and done = 0 order by created_at, rowid').all(key) as unknown as TurnFollowUp[];
	}

	// ---- reviews ----


	/** Records a stop once per turn; false when the turn already has its review. */
	insertReview(r: Pick<ReviewRow, 'id' | 'chat_key' | 'turn_id' | 'kind' | 'subject' | 'question' | 'items'>): boolean {
		const result = this.db.prepare(`insert into reviews (id, chat_key, turn_id, kind, subject, question, items, state, created_at)
			values (?, ?, ?, ?, ?, ?, ?, 'open', ?) on conflict do nothing`).run(r.id, r.chat_key, r.turn_id, r.kind, r.subject, r.question, r.items, this.iso());
		return Number(result.changes) > 0;
	}

	review(id: string): ReviewRow | undefined {
		return this.db.prepare('select * from reviews where id = ?').get(id) as ReviewRow | undefined;
	}

	reviews(key: string): ReviewRow[] {
		return this.db.prepare('select * from reviews where chat_key = ? order by created_at desc, rowid desc').all(key) as unknown as ReviewRow[];
	}

	reviewOfTurn(key: string, turnId: string): ReviewRow | undefined {
		return this.db.prepare('select * from reviews where chat_key = ? and turn_id = ?').get(key, turnId) as ReviewRow | undefined;
	}

	/** The Chat's newest review that waits for the person. */
	openReview(key: string): ReviewRow | undefined {
		return this.db.prepare("select * from reviews where chat_key = ? and state = 'open' order by created_at desc, rowid desc limit 1").get(key) as ReviewRow | undefined;
	}


	setVerdicts(id: string, verdicts: string): void {
		this.db.prepare("update reviews set verdicts = ? where id = ? and state = 'open'").run(verdicts, id);
	}

	/** The answer the person's decision makes, kept when it is saved to be sent. */
	setReviewAnswer(id: string, answer: string): void {
		this.db.prepare("update reviews set answer = ?, decided_at = ? where id = ? and state = 'open'").run(answer, this.iso(), id);
	}

	/** The Chat moved on without a decision on these: they are kept, no longer asked. */
	closeOpenReviews(key: string): void {
		this.db.prepare("update reviews set state = 'closed' where chat_key = ? and state = 'open'").run(key);
	}

	/** Pine took the answer. */
	answerReview(id: string): void {
		this.db.prepare("update reviews set state = 'answered' where id = ?").run(id);
	}


	// ---- task claims (local-first, 6.1) ----


}
