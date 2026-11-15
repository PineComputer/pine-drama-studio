// The protocol client's fixtures (doc/protocol.md): the ChatService `protocol` option over a temporary storage, and a
// turn that returns versions for the person to choose.
import { sha256 } from '../core/sha256';
import { join } from 'node:path';
import type { ChatServiceOptions } from '../core/chats';

export const hash = sha256;

/** The `protocol` option over `dir`. */
export function testProtocol(dir: string): NonNullable<ChatServiceOptions['protocol']> {
	return { storage: join(dir, 'protocol') };
}

/** The person's words of a task message: without its first line, `pine-drama-turn <id>` (doc/protocol.md, 4.1). */
export function withoutTask(text: string): string {
	return text.replace(/^pine-drama-turn [\w-]+\n/, '');
}

