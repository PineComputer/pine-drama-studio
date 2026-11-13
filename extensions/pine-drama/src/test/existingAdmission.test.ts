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
function fixture(validateProject?: (root: string) => Promise<void>) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-existing-admission-')));
	const root = join(dir, 'existing'); mkdirSync(root);
	writeFileSync(join(root, 'choices.json'), `project: ${root}\n`);
	writeFileSync(join(root, 'accepted.json'), '{"fixture":"immutable"}\n');
	const store = new Store(join(dir, 'studio.sqlite'));
	const pine = new FakePine(); pine.plans = [{ state: 'completed', files: {} }, { state: 'completed', files: {} }];
	const options = { holdsProject: () => true, store, port: pine, vault: new MemoryVault(), pine: env, validateProject,
		files: { projectsRoot: join(dir, 'projects'), libraryRoot: join(dir, 'library') } };
	return { dir, root, store, pine, options, service: new ChatService(options) };
}

test('a reserved Project Chat entry is admitted by its first send, but one with orphaned execution history is not', async () => {
	for (const orphaned of [false, true]) {
		const f = fixture(async () => undefined);
		try {
			f.store.insertChat({ key: 'main', label: 'Project Chat', env: 'pine', endpoint: env.endpoint, secret_ref: 'offline' });
			if (orphaned) { f.store.updateChat('main', { computer_state: 'stopped', pine_session_state: 'ended', computer_id: 'old' }); }
			const result = await drain(f.service.submit('main', 'continue', 'Project Chat', f.root));
			assert.equal(f.store.chat('main')?.project_role, orphaned ? null : 'main');
			if (orphaned) { assert.match(result, /execution history/); assert.equal(f.pine.calls.createSession ?? 0, 0); }
		} finally { f.store.close(); }
	}
});

