import type { ChatService } from '../core/chats';
import type { Store } from '../core/store';
import type { FakePine } from './fakePine';

/**
 * Pine's idle stop, recorded as the Studio records its discovery, on Pine's evidence only: FakePine stops the Chat's
 * Computer, as Pine's idle timeout does, and the Chat is left as `recordPineSessionEnded` leaves it once Pine reported the
 * stop: session ended, Computer stopped, unsettled sends failed. A send that discovers the stop itself now starts the
 * agent again and sends there (replacePineSessionAndSend; sendRestarts.test.ts), so these preconditions record the discovery
 * directly, as restartAdmission.test.ts's fixture does, and leave the restart to the test.
 */
export async function idleStopAndDiscover(pine: FakePine, store: Store, _discover: () => ChatService, key: string, _folder?: string): Promise<void> {
	const computer = pine.computers.get(store.chat(key)!.computer_id!)!;
	computer.state = 'stopped';
	computer.sessions.clear();
	store.tx(() => {
		store.updateChat(key, { pine_session_state: 'ended', state: 'idle', current_turn_id: null, question_turn_id: null, computer_state: 'stopped' });
		for (const op of store.unconfirmedSavedSends(key)) { store.updateSavedSend(op.id, { state: 'failed', error: 'the session ended' }); }
	});
}
