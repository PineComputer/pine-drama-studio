import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Update } from '../core/chats';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { folderOf, testService } from './protocolFixture';

const drain = async (updates: AsyncGenerator<Update>): Promise<void> => { for await (const _ of updates) { /* drain */ } };

// A Chat has one follower in a window, in the Chat's line (Codex on #239): an old follower still waiting on an ended
// runtime's answer keeps the person's next message waiting, and the agent is started again only once that follower has
// ended, so nothing it does lands on the session that replaces it.
for (const response of ['missing', 'question', 'event'] as const) {
	test(`a message sent while an old follower waits on an ended runtime's ${response} goes once that follower ends, to the agent started again`, async () => {
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
			// A reopened Chat starts its follower from its persisted running turn.
			store.updateChat('main', { state: 'running', current_turn_id: op.turn_id });
			const original = store.chat('main')!;
			const turn = pine.turn.bind(pine);
			// Only the ended runtime's reads are held: the new session's own turn goes on.
			pine.turn = async (...args) => {
				if (args[1].name !== original.pine_session_name) { return turn(...args); }
				const snapshot = response !== 'missing' ? await turn(...args) : undefined;
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
			let followed = false;
			const follower = drain(service.attachChatToPineTurn('main')).then(() => undefined, error => error as Error).finally(() => { followed = true; });
			await started;
			// Pine stops the Computer (an idle stop, as FakePine.stop models it) while the follower waits on its answer.
			const computer = pine.computers.get(original.computer_id!)!;
			computer.state = 'stopped'; computer.sessions.clear();
			const createSession = pine.createSession.bind(pine);
			const startedAgain: boolean[] = [];
			pine.createSession = async (...args) => { startedAgain.push(followed); return createSession(...args); };
			// The person's next message waits for the follower; the ended runtime answers; the message finds the session ended
			// and starts the agent again (replacePineSessionAndSend).
			const sent = drain(service.submit('main', 'continue', 'continue', [], folderOf(service)));
			release();
			await follower;
			await sent;
			assert.deepEqual(startedAgain, [true], 'the agent is started again once, after the old follower ended');
			const after = store.chat('main')!;
			assert.notEqual(after.pine_session_name, original.pine_session_name);
			assert.equal(after.pine_session_state, 'open');
			assert.equal(after.computer_state, 'running');
			assert.equal(after.state, 'idle', 'the message\'s own turn ended, and nothing after it changed the Chat');
			assert.equal(after.question_turn_id, null);
		} finally { release(); store.close(); }
	});
}
