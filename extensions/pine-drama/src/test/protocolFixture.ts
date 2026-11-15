// The protocol client's fixture (doc/protocol.md): the ChatService `protocol` option over a temporary storage.
import { join } from 'node:path';
import type { ChatServiceOptions } from '../core/chats';

/** The `protocol` option over `dir`. */
export function testProtocol(dir: string): NonNullable<ChatServiceOptions['protocol']> {
	return { storage: join(dir, 'protocol') };
}

