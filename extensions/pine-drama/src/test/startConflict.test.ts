// Two starts of one Computer: Portal fences an attach by the binding revision it read, and refuses one another start
// overtook (SDK BindingRevisionConflictError, 412). The SDK's
// model is to load the winner's saved binding and never to retry automatically.
// FakePine models the fence; SdkPort reports it as StartNotConfirmedError. Offline: no network, no paid call.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { StartTimeoutError } from '../core/pinePort';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const out: Update[] = [];
	for await (const update of updates) { out.push(update); }
	return out;
}
const said = (updates: readonly Update[]) => updates.map(u => u.text).join('\n');

async function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-start-conflict-')));
	const root = join(dir, 'project'); mkdirSync(root);
	const path = join(dir, 'studio.sqlite');
	const store = new Store(path);
	const pine = new FakePine(); const vault = new MemoryVault();
	const options = { holdsProject: () => true, store, port: pine, vault, pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
		files: { projectsRoot: join(dir, 'projects') } };
	const service = new ChatService(options);
	return { dir, root, path, store, pine, vault, options, service };
}

async function until(done: () => boolean): Promise<void> {
	for (let i = 0; !done() && i < 500; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
	assert.ok(done(), 'the awaited step was reached');
}

test('a first send whose start another start overtook gives the message back; sending it again starts the Computer', async () => {
	const f = await fixture();
	try {
		f.store.insertChat({ key: 'main', label: 'Project Chat', endpoint: 'https://offline.invalid', secret_ref: 'main' });
		const release = f.pine.hold('ensureComputer');
		const send = drain(f.service.submit('main', 'start the drama', 'Project Chat', [], f.root));
		await until(() => (f.pine.calls.ensureComputer ?? 0) > 0);
		// The winner creates the Computer under this Chat's own id, as a lost earlier attach would have.
		const id = f.store.chat('main')!.computer_id!;
		f.pine.computers.set(id, { id, state: 'running', binding: `bind-${id}-winner`, revision: 1, idleTimeout: 3600, sessions: new Map() });
		release();
		const out = await send;
		assert.match(said(out), /was not sent: Pine did not confirm the start of the Pine Computer[^]*```text\nstart the drama\n```/);
		assert.equal(f.pine.calls.run ?? 0, 0, 'nothing was sent');
		assert.equal(f.store.chat('main')!.computer_state, 'creating');
		await drain(f.service.submit('main', 'start the drama', 'Project Chat', [], f.root));
		assert.equal(f.pine.calls.run, 1, 'the person\'s send starts the Computer and is sent');
		assert.equal(f.store.chat('main')!.computer_state, 'running');
	} finally { f.store.close(); }
});

test('a start that timed out but committed later: the resend starts on the Computer Pine has, without a conflict', async () => {
	const f = await fixture();
	try {
		f.store.insertChat({ key: 'main', label: 'Project Chat', endpoint: 'https://offline.invalid', secret_ref: 'main' });
		f.pine.fail('ensureComputer', new StartTimeoutError('sandbox-late', 'starting'));
		const out = await drain(f.service.submit('main', 'start the drama', 'Project Chat', [], f.root));
		assert.match(said(out), /Pine had no Computer ready in time\. Try again in a minute/);
		// Pine finishes that start after the Studio stopped waiting.
		const id = f.store.chat('main')!.computer_id!;
		f.pine.computers.set(id, { id, state: 'running', binding: `bind-${id}-late`, revision: 1, idleTimeout: 3600, sessions: new Map() });
		await drain(f.service.submit('main', 'start the drama', 'Project Chat', [], f.root));
		assert.equal(f.pine.calls.run, 1);
		assert.equal(f.store.chat('main')!.computer_state, 'running');
	} finally { f.store.close(); }
});
