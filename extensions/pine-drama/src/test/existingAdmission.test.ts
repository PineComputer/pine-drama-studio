import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';

const env = { endpoint: 'https://offline.invalid', apiKey: 'offline' };
async function drain(updates: AsyncGenerator<Update>): Promise<string> {
	const lines: string[] = [];
	for await (const update of updates) { lines.push(update.text); }
	return lines.join('\n');
}
function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-existing-admission-')));
	const root = join(dir, 'existing'); mkdirSync(root);
	writeFileSync(join(root, 'pine-drama-project.json'), '{"schema":2}\n');
	writeFileSync(join(root, 'accepted.json'), '{"fixture":"immutable"}\n');
	const store = new Store(join(dir, 'studio.sqlite'));
	const pine = new FakePine(); pine.plans = [{ state: 'completed', files: {} }, { state: 'completed', files: {} }];
	const options = { holdsProject: () => true, store, port: pine, vault: new MemoryVault(), pine: env,
		files: { projectsRoot: join(dir, 'projects') } };
	return { dir, root, store, pine, options, service: new ChatService(options) };
}

test('an existing drama is joined by a Chat\'s first send, but a Chat with orphaned execution history is not bound to it', async () => {
	for (const orphaned of [false, true]) {
		const f = fixture();
		try {
			f.store.insertChat({ key: 'first', label: 'first', endpoint: env.endpoint, secret_ref: 'offline' });
			if (orphaned) { f.store.updateChat('first', { computer_state: 'stopped', pine_session_state: 'ended', computer_id: 'old' }); }
			const sent = drain(f.service.submit('first', 'continue', 'first', [], f.root));
			if (orphaned) { await assert.rejects(sent, /execution history/); } else { await sent; }
			assert.equal(f.store.chat('first')?.folder, orphaned ? null : f.root);
			if (orphaned) { assert.equal(f.pine.calls.createSession ?? 0, 0); }
		} finally { f.store.close(); }
	}
});

