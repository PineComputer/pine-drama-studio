// A Chat's tasks end to end over the fake Pine (doc/protocol.md, section 4): the request and its message go up, the
// return is installed at the turn's end, and a scope's next task goes only after the last return is installed.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { readChoices } from '../core/choices';
import { REVIEW_APPROVAL_STATEMENT } from '../core/reviewCardProtocol';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';
import { reviewPlan, testProtocol } from './protocolFixture';

async function drain(updates: AsyncGenerator<Update>): Promise<Update[]> {
	const all: Update[] = []; for await (const update of updates) { all.push(update); } return all;
}

const version = JSON.stringify({ schema: 1, made_at: '2026-11-12T10:00:00Z', file: 'image-1.png', inputs: [], prompt: null, from_choice: null });
const made = (object: string, picture: string) => ({ [`drama/${object}/v1/version.json`]: version, [`drama/${object}/v1/image-1.png`]: picture });

function fixture(more: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-protocol-flow-')));
	const root = join(dir, 'drama'); mkdirSync(root);
	const store = new Store(join(dir, 'studio.sqlite'));
	const pine = new FakePine();
	// `failArtifacts`: the next read of a Computer's artifacts after this many more fails, as storage that is down.
	const control = { failArtifacts: -1 };
	const port = new Proxy(pine, { get: (target, name) => {
		if (name === 'artifacts') {
			return (...args: Parameters<FakePine['artifacts']>) => control.failArtifacts-- === 0 ? Promise.reject(new Error('storage unavailable')) : target.artifacts(...args);
		}
		const value = Reflect.get(target, name, target) as unknown;
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
	} });
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port, vault: new MemoryVault(), pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
		files: { libraryRoot: join(dir, 'library'), projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir), ...more });
	const send = (text: string, key = 'main') => drain(service.submit(key, text, key === 'main' ? 'Project Chat' : 'Session', root));
	const request = (n: number) => {
		// Every Computer's requests, in the order they were written there, the first Computer's first.
		const requests = [...pine.artifactFiles.values()].flatMap(files => [...files].filter(([k]) => k.endsWith('/request.json')).map(([, bytes]) => bytes));
		return JSON.parse(requests[n].toString('utf8')) as { turn: string; scope: string; versions: Record<string, string> };
	};
	const said = (updates: Update[]) => updates.map(u => u.text).join('\n');
	return { root, store, pine, service, send, request, said, control };
}

test('a task goes up with its message, and its return is installed at the turn\'s end', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/umbrella', 'umbrella') }];
		await f.send('draw the umbrella');
		const first = f.request(0);
		assert.equal(first.scope, 'project');
		assert.match(f.store.savedSend(first.turn)!.text, new RegExp(`^pine-drama-turn ${first.turn}\\ndraw the umbrella`));
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/v1/image-1.png'), 'utf8'), 'umbrella');
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		assert.deepEqual(Object.keys(f.request(1).versions), ['assets/props/umbrella/v1'], 'the next request carries the installed version');
	} finally { f.store.close(); }
});

test('a turn that ends with no return, or refused, is said to the person and installs nothing', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'cut off', files: made('assets/props/a', 'a'), noReturn: true }];
		assert.match(f.said(await f.send('draw a')), /brought nothing back[^]*may have spent money/);
		f.pine.plans = [{ state: 'completed', text: 'no', refused: 'the project has no screenplay' }];
		assert.match(f.said(await f.send('draw b')), /refused this task: the project has no screenplay/);
		assert.equal(existsSync(join(f.root, 'assets')), false);
	} finally { f.store.close(); }
});

test('a scope\'s next task waits until the last return is installed, and then starts from it', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failArtifacts = 1; // the send's own listing succeeds; the turn end's read fails
		const end = f.said(await f.send('draw a'));
		assert.match(end, /could not be installed[^]*tried again at your next message/);
		assert.equal(existsSync(join(f.root, 'assets/props/a/v1')), false);
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('next');
		assert.ok(existsSync(join(f.root, 'assets/props/a/v1/image-1.png')), 'the earlier return is installed first');
		assert.deepEqual(Object.keys(f.request(1).versions), ['assets/props/a/v1']);
	} finally { f.store.close(); }
});

test('Review Submit writes the chosen versions with the person\'s words into choices.json', async () => {
	const f = fixture();
	try {
		f.pine.plans = [reviewPlan([{ object: 'assets/props/umbrella', version: 'v1', files: { 'image-1.png': 'umbrella' } }])];
		await f.send('draw the umbrella');
		const review = f.service.openReview('main')!.review;
		f.service.approveAll('main', review.id);
		await f.service.recordReviewDecisionsLocally('main', review.id);
		assert.deepEqual((await readChoices(f.root))!.objects['assets/props/umbrella'], { chosen: { version: 'v1', words: REVIEW_APPROVAL_STATEMENT } });
	} finally { f.store.close(); }
});

test('a session other than the Project Chat adds under episodes/, and a shared object only when it is new (D51, protocol section 1): a new version of a shared one is refused whole', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'ok', files: made('assets/props/cup', 'cup') }];
		await f.send('start the project');
		const session = 'pine-computer:/session-2';
		f.pine.plans = [{ state: 'completed', text: 'broken down', files: made('episodes/EP001/breakdown', 'shots') }];
		await f.send('break down EP001 and EP002', session);
		assert.equal(f.request(1).scope, 'episodes');
		assert.equal(readFileSync(join(f.root, 'episodes/EP001/breakdown/v1/image-1.png'), 'utf8'), 'shots');
		const cup2 = { 'drama/assets/props/cup/v2/version.json': version, 'drama/assets/props/cup/v2/image-1.png': 'cup again' };
		f.pine.plans = [{ state: 'completed', text: 'redrew the cup', files: { ...cup2, ...made('episodes/EP002/breakdown', 'more') } }];
		assert.match(f.said(await f.send('and redraw the cup', session)), /not installed: assets\/props\/cup\/v2 is outside the task's scope, episodes/);
		assert.equal(existsSync(join(f.root, 'episodes/EP002')), false, 'nothing of the refused return is installed');
	} finally { f.store.close(); }
});

// Before the fix the follower retried for ever and never collected a turn that ended while its stream was lost.
test('a turn that ended is collected and its return installed even though its event stream never recovers', async () => {
	const f = fixture({ reconnectWaitsMs: [0, 20] });
	try {
		f.pine.plans = [{ state: 'running' }];
		const said: Update[] = [];
		const reply = f.service.submit('main', 'draw the umbrella', 'Project Chat', f.root);
		const end = Date.now() + 20_000;
		while (f.store.chat('main')?.state !== 'running') {
			assert.ok(Date.now() < end, 'the turn runs');
			const next = await reply.next();
			assert.ok(!next.done);
			said.push(next.value);
		}
		const turnId = f.store.chat('main')!.current_turn_id!;
		// The network drops while the turn ends on the Computer; then turn reads answer again, but every stream reconnect runs out.
		f.pine.streamDown = true;
		f.pine.offline = true;
		while (!/Connection to Pine lost/.test(f.said(said))) {
			assert.ok(Date.now() < end, `the loss is said; said: ${f.said(said)}`);
			const next = await reply.next();
			assert.ok(!next.done, f.said(said));
			said.push(next.value);
		}
		f.pine.finish(turnId, { state: 'completed', text: 'drawn', files: made('assets/props/umbrella', 'umbrella') });
		f.pine.offline = false;
		const rest = (async () => { for await (const update of reply) { said.push(update); } })();
		let timer: NodeJS.Timeout | undefined;
		let done: boolean;
		try {
			done = await Promise.race([rest.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 15_000); })]);
		} finally {
			clearTimeout(timer);
			f.pine.streamDown = false;
			await rest;
		}
		assert.equal(done, true, `the reply ends; said: ${f.said(said)}`);
		assert.equal(readFileSync(join(f.root, 'assets/props/umbrella/v1/image-1.png'), 'utf8'), 'umbrella', 'the return is installed');
		assert.equal(f.service.hasUnfinishedTurnFollowUp('main'), false);
		assert.equal(f.pine.calls.run, 1, 'nothing is sent again');
	} finally { f.store.close(); }
});

test('files added in the chat input go into the drama\'s folder and travel in the request: a picture to imports/, a document to inputs/', async () => {
	const f = fixture();
	try {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pine-added-')));
		const picture = join(outside, 'office.JPG'); writeFileSync(picture, 'jpeg');
		const brief = join(outside, 'brief.md'); writeFileSync(brief, 'BRIEF');
		mkdirSync(join(outside, 'a folder'));
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		const said = await drain(f.service.submitWithFiles('main', 'use these', 'Project Chat', [
			{ kind: 'file', path: picture }, { kind: 'file', path: brief }, { kind: 'file', path: join(outside, 'a folder') }], f.root));
		assert.match(f.said(said), /Not sent to the agent: a folder \(a folder\)/);
		assert.equal(readFileSync(join(f.root, 'inputs/brief.md'), 'utf8'), 'BRIEF');
		const imported = readdirSync(join(f.root, 'imports'));
		assert.equal(imported.length, 1);
		assert.match(imported[0], /^[0-9a-f-]{36}\.jpg$/, 'a picture is imports/<client id>.<ext>');
		const sent = f.request(0) as unknown as { files: Record<string, string> };
		assert.deepEqual(Object.keys(sent.files).sort(), [`imports/${imported[0]}`, 'inputs/brief.md']);
		assert.ok(f.store.messages('main').some(m => m.kind === 'instructions' && m.text === `Pine Drama Studio: the person added to the drama's folder: imports/${imported[0]}, inputs/brief.md.`));
		assert.equal((await readChoices(f.root))?.imports.length ?? 0, 0, 'a picture for the agent to look at is no import of an object');
	} finally { f.store.close(); }
});

test('at start, a turn whose return was not installed is installed with no message sent', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		f.control.failArtifacts = 1; // the send's own listing succeeds; the turn end's read fails
		assert.match(f.said(await f.send('draw a')), /could not be installed/);
		const runs = f.pine.calls.run;
		await f.service.resumeUnfinishedTurnFollowUps();
		assert.equal(readFileSync(join(f.root, 'assets/props/a/v1/image-1.png'), 'utf8'), 'a');
		assert.equal(f.pine.calls.run, runs, 'no run was sent');
		assert.equal(f.service.hasUnfinishedTurnFollowUp('main'), false);
	} finally { f.store.close(); }
});

test('a task that broke off installs what it finished and says why', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'stopped early', files: made('assets/props/a', 'a'), failed: 'the image model refused a picture' }];
		assert.match(f.said(await f.send('draw a and b')), /The task broke off: the image model refused a picture[^]*What it finished is in your project/);
		assert.equal(readFileSync(join(f.root, 'assets/props/a/v1/image-1.png'), 'utf8'), 'a');
	} finally { f.store.close(); }
});

test('a session on another Computer gets the project\'s versions by Pine\'s copy from the Computer that returned them, not by upload', async () => {
	const f = fixture();
	try {
		f.pine.plans = [{ state: 'completed', text: 'drawn', files: made('assets/props/a', 'a') }];
		await f.send('draw a');
		f.pine.plans = [{ state: 'completed', text: 'ok' }];
		await f.send('break down EP001', 'pine-computer:/session-2');
		const computers = [...f.pine.artifactFiles.keys()];
		assert.equal(computers.length, 2, 'the session runs on its own Computer');
		const hash = f.request(1).versions['assets/props/a/v1'];
		assert.ok(f.pine.artifactFiles.get(computers[1])!.get(`versions/${hash}.tar`), 'the archive is on the second Computer');
		assert.equal(f.pine.calls.copy, 1, 'copied inside Pine\'s storage');
	} finally { f.store.close(); }
});
