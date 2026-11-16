// The Chats' business state in SQLite (node:sqlite), shared by every Studio window.
// Secrets are not here:
// a row names its secret (`secret_ref`) in the vault. No vscode import.

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { entryFor } from './binding';
import { DatabaseSync } from 'node:sqlite';
import { projectIdentity } from './projectPlace';
import { STORE_BUSY_TIMEOUT_MS } from './tuning';

export type ComputerState = 'none' | 'creating' | 'running' | 'stopped' | 'missing_credentials';
export type PineSessionState = 'none' | 'open' | 'ended';
export type ChatState = 'idle' | 'running' | 'needs_input' | 'failed';
export type SavedSendState = 'pending' | 'sent' | 'unknown' | 'failed';
export type MessageKind = 'prompt' | 'instructions' | 'progress' | 'activity' | 'result' | 'question' | 'usage' | 'failed' | 'notice';


export interface Chat {
	key: string;
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
	/**
	 * A command turn's argv as JSON (PineSandbox PublicCommandRun): the send runs that program as the turn instead of
	 * giving `text` to the agent, which stays what the Chat shows. Null for a message to the agent.
	 */
	command: string | null;
	state: SavedSendState;
	turn_id: string | null;
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
}

/** One step of the store's schema: run once, in order, when the file's `user_version` is below `version`. */
export interface Migration { readonly version: number; readonly sql: string }

/**
 * The store's schema as numbered steps, as Code-OSS keeps its own SQLite stores (sessionDatabase.ts,
 * sessionDatabaseMigrations): a schema change appends the next version; a step that has shipped is never edited.
 * The first step is 20, the schema staging stores were at when steps began; an older file is set aside (Store).
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 20, sql: `
create table if not exists chats (
  key text primary key,               -- the chat session resource
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
  created_at text not null
);
create table if not exists messages (
  id integer primary key,
  chat_key text not null references chats(key),
  turn_id text,
  saved_send_id text,
  kind text not null,                 -- prompt | instructions | progress | activity | result | question | usage | failed | notice
  text text not null,
  cost real,
  currency text
);
-- One prompt per saved send; one final result, question, usage or failure per turn.
create unique index if not exists messages_prompt on messages (saved_send_id) where kind = 'prompt';
create unique index if not exists messages_final on messages (chat_key, turn_id, kind)
  where turn_id is not null and kind in ('result', 'question', 'usage', 'failed');
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
` }, { version: 21, sql: `
-- A command turn's argv as JSON; null for a message to the agent.
alter table saved_sends add column command text;
` }];


/** Where a store older than the first step is copied aside: beside it, named by its schema and the time, never over a file. */
function asidePath(path: string, schema: number, at: Date): string {
	const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const base = `${path}.schema${schema}-${stamp}`;
	let aside = base;
	for (let n = 2; existsSync(aside); n++) { aside = `${base}-${n}`; }
	return aside;
}

/** The refusal of a store a newer Studio wrote: its file records only its schema, not that Studio's release. */
export function newerStoreMessage(found: number, latest: number): string {
	return `This Chat history was written by a newer Pine Drama Studio (store schema ${found}; this one reads up to ${latest}). Update Pine Drama Studio to open it.`;
}

/** What the person is told when an older database was set aside: plain words, and where it is. */
export function setAsideNotice(aside: { path: string }): string {
	return `Chat history from an older version of Pine Drama Studio was moved to ${aside.path}; your work is in your project folder.`;
}


export class Store {
	readonly db: DatabaseSync;
	/** A store older than the first step, copied aside when this Store opened it, with the schema it had. */
	readonly setAside: { schema: number; path: string } | undefined;

	constructor(path: string, readonly now: () => number = Date.now, migrations: readonly Migration[] = MIGRATIONS) {
		this.db = new DatabaseSync(path, { timeout: STORE_BUSY_TIMEOUT_MS });
		try {
			this.setAside = this.migrate(path, migrations);
			// After the version is accepted, so a refused file keeps its journal mode. Best effort, as Code-OSS's
			// configureSqliteJournal: another connection's lock leaves the mode as it is, and a later open retries.
			try { this.db.exec('pragma journal_mode = wal'); } catch { /* the mode stays; the next open tries again */ }
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	/**
	 * Runs the steps above the file's `user_version` in one write transaction, as Code-OSS's runMigrations, with foreign
	 * keys off around it and checked before commit (https://www.sqlite.org/lang_altertable.html#otheralter). A file older
	 * than the first step is copied aside with VACUUM INTO and replaced in place (Firefox Places' "replace the database"
	 * for schemas it no longer migrates); a newer one is refused before anything writes to it.
	 */
	private migrate(path: string, migrations: readonly Migration[]): { schema: number; path: string } | undefined {
		const latest = migrations.at(-1)!.version;
		const version = (): number => (this.db.prepare('pragma user_version').get() as { user_version: number }).user_version;
		const before = version();
		if (before > latest) { throw new Error(newerStoreMessage(before, latest)); }
		if (before === latest) { return undefined; }
		this.db.exec('pragma foreign_keys = off');
		let aside: { schema: number; path: string } | undefined;
		try {
			return this.tx(() => {
				// Again under the write lock: another window may have migrated, or a newer Studio written, meanwhile.
				const found = version();
				if (found > latest) { throw new Error(newerStoreMessage(found, latest)); }
				if (found === latest) { return undefined; }
				if (found !== 0 && found < migrations[0].version) {
					// The lock holder alone copies it, before any change: no writer commits between the copy and the drop.
					aside = { schema: found, path: asidePath(path, found, new Date(this.now())) };
					const reader = new DatabaseSync(path, { timeout: STORE_BUSY_TIMEOUT_MS });
					try { reader.prepare('vacuum into ?').run(aside.path); } finally { reader.close(); }
					const tables = this.db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[];
					for (const { name } of tables) { this.db.exec(`drop table "${name.replace(/"/g, '""')}"`); }
				}
				const from = aside ? 0 : found;
				for (const step of migrations.filter(m => m.version > from)) {
					this.db.exec(step.sql);
					// A pragma takes no parameter; the version is the step's own number.
					this.db.exec(`pragma user_version = ${step.version}`);
				}
				const broken = this.db.prepare('pragma foreign_key_check').all();
				if (broken.length > 0) { throw new Error(`The Chat store's migration to schema ${latest} broke ${broken.length} reference(s).`); }
				return aside;
			});
		} catch (error) {
			// The migration rolled back, so the file is still the one copied: its copy would only be a second one.
			if (aside) { rmSync(aside.path, { force: true }); }
			throw error;
		} finally {
			this.db.exec('pragma foreign_keys = on');
		}
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

	insertChat(c: Pick<Chat, 'key' | 'endpoint' | 'label' | 'secret_ref'>): void {
		const at = this.iso();
		this.db.prepare(`insert into chats (key, endpoint, label, secret_ref, computer_state, pine_session_state, state, created_at, updated_at)
			values (?, ?, ?, ?, 'none', 'none', 'idle', ?, ?)`).run(c.key, c.endpoint, c.label, c.secret_ref, at, at);
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

	insertSavedSend(op: Pick<SavedSend, 'id' | 'chat_key' | 'text' | 'command'>): void {
		this.db.prepare(`insert into saved_sends (id, chat_key, text, command, state, created_at)
			values (?, ?, ?, ?, 'pending', ?)`).run(op.id, op.chat_key, op.text, op.command, this.iso());
	}

	updateSavedSend(id: string, patch: Partial<Pick<SavedSend, 'state' | 'turn_id'>>): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([column]) => `${column} = ?`).join(', ');
		this.db.prepare(`update saved_sends set ${sets} where id = ?`).run(...entries.map(([, value]) => value as string | number | null), id);
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

	/** Adds a message; returns its id, or undefined when a unique index already holds one like it. */
	addMessage(m: Omit<Message, 'id'>): number | undefined {
		const result = this.db.prepare(`insert into messages (chat_key, turn_id, saved_send_id, kind, text, cost, currency)
			values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing`)
			.run(m.chat_key, m.turn_id, m.saved_send_id, m.kind, m.text, m.cost, m.currency);
		return result.changes > 0 ? Number(result.lastInsertRowid) : undefined;
	}

	/** Moves one operation's prompt to another operation; true when there was one to move. */
	movePrompt(from: string, to: string): boolean {
		return this.db.prepare(`update messages set saved_send_id = ? where saved_send_id = ? and kind = 'prompt'`).run(to, from).changes > 0;
	}

	messages(key: string): Message[] {
		return this.db.prepare('select * from messages where chat_key = ? order by id').all(key) as unknown as Message[];
	}

	/**
	 * The turn's one cost record. A snapshot replaces it until a final cost settles it; later
	 * snapshots and a repeated final change nothing. True when the record changed.
	 */
	setTurnCost(key: string, turnId: string, cost: number | null, currency: string, final: boolean): boolean {
		const result = this.db.prepare(`insert into messages (chat_key, turn_id, saved_send_id, kind, text, cost, currency)
			values (?, ?, null, 'usage', ?, ?, ?)
			on conflict (chat_key, turn_id, kind) where turn_id is not null and kind in ('result', 'question', 'usage', 'failed')
			do update set text = excluded.text, cost = excluded.cost, currency = excluded.currency
			where messages.text <> 'final'`)
			.run(key, turnId, final ? 'final' : 'snapshot', cost, currency);
		return result.changes > 0;
	}

	/** Records an event as applied; false when it already was. Must run in the transaction that applies it. */
	markEvent(key: string, taskId: string, eventId: number): boolean {
		const result = this.db.prepare('insert into events (chat_key, task_id, event_id) values (?, ?, ?) on conflict (chat_key, task_id, event_id) do nothing')
			.run(key, taskId, eventId);
		return result.changes > 0;
	}
}
