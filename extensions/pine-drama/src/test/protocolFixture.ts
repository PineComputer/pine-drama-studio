// The protocol client's fixture (doc/protocol.md): a ChatService with the places the desktop gives it, over temporary
// folders.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ChatService, type ChatServiceOptions } from '../core/chats';

/** The `protocol` option over `dir`. */
export function testProtocol(dir: string): ChatServiceOptions['protocol'] {
	return { storage: join(dir, 'protocol') };
}

/** The drama folder of the window each test's ChatService sends from. */
const folders = new WeakMap<ChatService, string>();

/**
 * A window's ChatService as the desktop makes one, with its places under `dir`: where projects are kept, the protocol's
 * storage, and the window's drama folder (`folderOf`).
 */
export function testService(dir: string, options: Omit<ChatServiceOptions, 'files' | 'protocol'>): ChatService {
	const folder = join(dir, 'drama');
	mkdirSync(folder, { recursive: true });
	const service = new ChatService({ ...options, files: { projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir) });
	folders.set(service, realpathSync(folder));
	return service;
}

/** The drama folder `service`'s window sends from (testService). */
export const folderOf = (service: ChatService): string => folders.get(service)!;
