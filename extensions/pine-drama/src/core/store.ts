// The Chats' business state in SQLite (node:sqlite), shared by every Studio window.
// Secrets are not here:
// a row names its secret (`secret_ref`) in the vault. No vscode import.

import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { entryFor } from './binding';
import { DatabaseSync } from 'node:sqlite';
import { projectIdentity } from './projectPlace';

export type ComputerState = 'none' | 'creating' | 'running' | 'stopped' | 'missing_credentials';
export type PineSessionState = 'none' | 'open' | 'ended';
export type ChatState = 'idle' | 'running' | 'needs_input' | 'failed';
export type SavedSendState = 'pending' | 'sent' | 'unknown' | 'failed';
export type MessageKind = 'prompt' | 'instructions' | 'progress' | 'activity' | 'result' | 'question' | 'usage' | 'failed' | 'notice';


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
	/**
	 * The canonical local project association. Null until explicitly associated; `projectRootOf` also supports
	 * per-Chat storage for the existing unbound core path. This field alone grants no execution authority.
	 */
	folder: string | null;
	created_at: string;
	updated_at: string;
}

export interface SavedSend {
	id: string;
	chat_key: string;
	text: string;
	state: SavedSendState;
	turn_id: string | null;
	error: string | null;
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

const SCHEMA_VERSION = 19;
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
  folder text,                        -- the drama's folder the session is bound to; null: its folder under the extension's storage
  created_at text not null,
  updated_at text not null
);
-- Every send, saved before it is sent; id is the idempotency key of a run.
create table if not exists saved_sends (
  id text primary key,
  chat_key text not null references chats(key),
  text text not null,
  state text not null,                -- pending | sent | unknown | failed
  turn_id text,                       -- the turn it opened
  error text,
  created_at text not null,
  updated_at text not null
);
create table if not exists messages (
  id integer primary key,
  chat_key text not null references chats(key),
  turn_id text,
  saved_send_id text,
  kind text not null,                 -- prompt | instructions | progress | activity | result | question | usage | failed | notice
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
-- A named Chat destination for another project window. Navigation only, never execution authority.
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
	return `Earlier Chat history from an older version of Pine Drama Studio was set aside at ${aside.path}. Open your project folder and continue in a chat: your work is in the folder.`;
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

	/** Missing folder metadata is not proof that earlier runtime work belongs to a newly selected project. */
	private assertUnboundHistory(conv: Chat): void {
		if (conv.folder) { return; }
		const history = this.db.prepare(`select 1 from saved_sends where chat_key = ?
			union all select 1 from messages where chat_key = ? limit 1`)
			.get(conv.key, conv.key);
		if (conv.computer_id || conv.computer_state !== 'none' || conv.pine_session_state !== 'none' || conv.task_id || conv.state !== 'idle' || history) {
			throw new Error('This conversation has execution history. Reconcile its existing project before assigning a folder.');
		}
	}

	/** A Chat's first send binds it to its project, atomically: every Chat of a project is a peer. */
	bindFolder(key: string, folder: string): boolean {
		return this.tx(() => {
			const conv = this.chat(key);
			if (!conv || conv.folder) { return false; }
			this.assertUnboundHistory(conv);
			const root = projectIdentity(folder);
			const entry = entryFor(this.chats(), '', key, root);
			if (entry.kind !== 'go' || !entry.bind) { return false; }
			this.db.prepare('update chats set folder = ?, updated_at = ? where key = ?').run(root, this.iso(), key);
			return true;
		});
	}

	updateChat(key: string, patch: Partial<Omit<Chat, 'key' | 'created_at' | 'updated_at' | 'folder'>>): void {
		const entries = Object.entries(patch);
		if (entries.some(([key]) => key === 'folder')) {
			throw new Error('A Chat is bound to its project only by its first send.');
		}
		if (entries.length === 0) {
			return;
		}
		const sets = entries.map(([column]) => `${column} = ?`).join(', ');
		this.db.prepare(`update chats set ${sets}, updated_at = ? where key = ?`)
			.run(...entries.map(([, value]) => value as string | number | null), this.iso(), key);
	}

	// ---- operations ----

	insertSavedSend(op: Pick<SavedSend, 'id' | 'chat_key' | 'text'>): void {
		const at = this.iso();
		this.db.prepare(`insert into saved_sends (id, chat_key, text, state, created_at, updated_at)
			values (?, ?, ?, 'pending', ?, ?)`).run(op.id, op.chat_key, op.text, at, at);
	}

	updateSavedSend(id: string, patch: Partial<Pick<SavedSend, 'state' | 'turn_id' | 'error'>>): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([column]) => `${column} = ?`).join(', ');
		this.db.prepare(`update saved_sends set ${sets}, updated_at = ? where id = ?`)
			.run(...entries.map(([, value]) => value as string | number | null), this.iso(), id);
	}

	/** The runs and answers whose turn is `turnId`: each is a task of its own (local-first, 6.1). */
	savedSendsOfTurn(key: string, turnId: string): SavedSend[] {
		return this.db.prepare("select * from saved_sends where chat_key = ? and turn_id = ? order by created_at").all(key, turnId) as unknown as SavedSend[];
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

	// ---- settling ----

	/** Opens the settle of an ended turn; a repeat keeps the steps already done. */

	// ---- task claims (local-first, 6.1) ----


}
