// Test set-up for the Store: a Chat placed in a project directly, as binding (Store.bindFolder) leaves it, without the
// send that binds it in the product.
import { projectIdentity } from '../core/projectPlace';
import type { Chat, Store } from '../core/store';

/** Binds `key` to `project`, as its first send would. */
export function associateProject(store: Store, key: string, project: string): Chat {
	store.db.prepare('update chats set folder = ? where key = ?').run(projectIdentity(project), key);
	return store.chat(key)!;
}
