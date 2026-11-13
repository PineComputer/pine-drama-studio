// Test set-up for the Store: a Chat placed in a project directly, as binding (Store.bindFolder) leaves it, without the
// send that binds it in the product.
import { projectIdentity } from '../core/projectPlace';
import type { Chat, Store } from '../core/store';

/** Makes `key` the Project Chat of `project` (`{ kind: 'main' }`) or another session of it (null). */
export function associateProject(store: Store, key: string, project: string, role: { kind: 'main' } | null): Chat {
	store.db.prepare('update chats set folder = ?, project_role = ? where key = ?').run(projectIdentity(project), role?.kind ?? null, key);
	return store.chat(key)!;
}
