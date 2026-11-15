import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Update } from '../core/chats';
import { PineSessionReplacedError } from '../core/pineSessionGeneration';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { folderOf, testService } from './protocolFixture';

const drain = async (updates: AsyncGenerator<Update>): Promise<void> => { for await (const _ of updates) { /* drain */ } };

for (const response of ['missing', 'missing while the old binding still answers', 'question', 'event'] as const) {
	test(`a delayed ${response} from an old follower cannot mutate a restarted Session`, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pine-restart-follower-'));
		const store = new Store(join(dir, 'studio.sqlite'));
		const pine = new FakePine();
		const service = testService(dir, { holdsProject: () => true, store, port: pine, vault: new MemoryVault(),
			pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' } });
		let release!: () => void; let entered!: () => void;
		const waiting = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { entered = resolve; });
		try {
			await drain(service.submit('main', 'fixture', 'fixture', [], folderOf(service)));
			const op = store.db.prepare('select turn_id from saved_sends limit 1').get() as { turn_id: string };
			// A reopened Chat may start a follower from its persisted running turn.
			store.updateChat('main', { state: 'running', current_turn_id: op.turn_id });
			const original = store.chat('main')!;
			const turn = pine.turn.bind(pine);
			// Only the ended runtime's reads are held: the new session's own turn goes on.
			pine.turn = async (...args) => {
				if (args[1].name !== original.pine_session_name) { return turn(...args); }
				const snapshot = !response.startsWith('missing') ? await turn(...args) : undefined;
				entered(); await waiting;
				if (!snapshot) { return turn(...args); }
				return response === 'question' ? { ...snapshot, state: 'needs_input', question: 'Old runtime question' } : snapshot;
			};
			if (response === 'event') {
				const events = pine.events.bind(pine);
				pine.events = async function* (...args) {
					if (args[1].name !== original.pine_session_name) { yield* events(...args); return; }
					await waiting;
					yield { kind: 'progress', eventId: 99999, taskId: original.task_id!, turnId: op.turn_id, text: 'Old runtime event' };
				};
			}
			const follower = drain(service.attachChatToPineTurn('main')).then(() => undefined, error => error as Error);
			await started;
			// Pine stops the Computer (an idle stop, as FakePine.stop models it). Discovery is set directly, as the session's end
			// that ensureLivePineSession() records on Pine's evidence: this window's follower holds the running turn, so a send that
			// would discover it queues behind that turn, which this test holds open on purpose.
			const computer = pine.computers.get(original.computer_id!)!;
			computer.state = 'stopped'; computer.sessions.clear();
			store.updateChat('main', { pine_session_state: 'ended', computer_state: 'stopped', state: 'idle', current_turn_id: null });
			// The person's next message finds the session ended and starts the agent again (replacePineSessionAndSend), while
			// the old follower, attached outside the send queue, still awaits the ended runtime.
			await drain(service.submit('main', 'continue', 'continue', [], folderOf(service)));
			const replacement = store.chat('main')!;
			assert.notEqual(replacement.pine_session_name, original.pine_session_name);
			assert.equal(replacement.pine_session_state, 'open');
			if (response === 'missing while the old binding still answers') {
				// Pine may still answer for the old binding after the same Computer was started again: the old follower's
				// stale MissingError then reads the Computer as running, and only the check after that call keeps it from
				// stopping the Computer its replacement now runs on (ChatService.held).
				pine.computerState = async () => 'running';
			}
			release();
			const error = await follower;
			const after = store.chat('main')!;
			assert.equal(after.pine_session_state, 'open');
			assert.equal(after.computer_state, 'running');
			assert.equal(after.pine_session_name, replacement.pine_session_name);
			assert.equal(after.state, 'idle');
			assert.equal(after.question_turn_id, null);
			assert.deepEqual([after.task_id, after.last_applied_event_id], [replacement.task_id, replacement.last_applied_event_id], 'the successor\'s own turn, untouched');
			assert.equal(store.messages('main').some(m => m.text.includes('Old runtime')), false);
			assert.equal(pine.calls.stopComputer ?? 0, 0, 'the old follower cannot stop the successor');
			assert.ok(error instanceof PineSessionReplacedError, 'retired follower loses write and remote-call authority');
		} finally { release(); store.close(); }
	});
}

