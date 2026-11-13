// Pine account problems (the person, via master): each is one line in Chat, in product words, that says what happened and
// where to fix it, and nothing is retried. The errors are the SDK's own classes, built with the fields Pine sends
// (PineSandbox 567ed28ec apps/portal/app/controllers/api/base_controller.rb:19-31, attach_credentials_controller.rb:85-95,
// attach_credential_mint.rb:48-54; sdks/pine-computer/typescript/src/internal/lifecycle.ts:215-216); only the network is fake.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService, type Update } from '../core/chats';
import { AccountError, PINE_ACCOUNT_URL, type AccountProblem } from '../core/pinePort';
import { Store } from '../core/store';
import { accountProblem, SdkPort } from '../sdkPort';
import { FakePine, MemoryVault } from './fakePine';
import { testProtocol } from './protocolFixture';

const portal = (status: number, code: string, reason = '') => ({ status, code, reason, requestId: 'req-1', host: 'pinecomputer.io', operation: 'POST /v1/attach-credentials', retryAfterSeconds: 0 });
const lifecycle = (status: number, code: string) => ({ status, code, body: '', host: 'api.pinecomputer.io', operation: 'POST /v1/computers', requestId: 'req-2', retryAfterSeconds: 60 });

test('each Pine account refusal is the one problem it says, from the SDK error Pine\'s answer becomes', async () => {
	const s = await import('@pinesandbox/computer');
	const cases: [Error, AccountProblem][] = [
		[new s.InvalidClientKeyError('unknown or revoked project client key', portal(401, 'INVALID_API_KEY')), 'key'],
		[new s.AttachCredentialsError('Invalid or missing API key.', portal(401, 'INVALID_API_KEY')), 'key'],
		[new s.InsufficientScopeError('this key may not mint control-plane tokens', portal(403, 'INSUFFICIENT_SCOPE')), 'permission'],
		[new s.ProjectAccessDeniedError('Project API access is unavailable.', portal(403, 'PROJECT_ACCESS_DENIED')), 'permission'],
		[new s.AttachCredentialsError('API access is disabled for this project.', portal(403, 'API_ACCESS_DISABLED', 'api_access_disabled')), 'permission'],
		[new s.AttachCredentialsError('This project\'s organization is out of credits.', portal(403, 'SPEND_LIMIT_REACHED', 'spend_limit_reached')), 'credits'],
		[new s.AttachCredentialsError('This project has reached its monthly spend limit.', portal(403, 'SPEND_LIMIT_REACHED', 'spend_limit_reached')), 'spendLimit'],
		[new s.AttachCredentialsError('This project is suspended.', portal(403, 'PROJECT_SUSPENDED', 'project_suspended')), 'suspended'],
		[new s.RateLimitedError('portal rate-limited the control-token mint', portal(429, 'RATE_LIMITED')), 'rateLimited'],
		[new s.CreateRateLimitedError('too many Computers started this minute', lifecycle(429, 'COMPUTER_CREATE_RATE_LIMITED')), 'rateLimited'],
		[new s.CapacityExceededError('the project is at its concurrent Computer limit', lifecycle(429, 'COMPUTER_CAPACITY_EXCEEDED')), 'capacity'],
	];
	for (const [error, problem] of cases) {
		assert.equal(accountProblem(error, s)?.problem, problem, error.message);
	}
	assert.equal(accountProblem(new Error('something else'), s), undefined, 'any other error stays itself');
});

test('every account line says what happened in product words; those the person fixes in the console link it, a rate limit says to wait', () => {
	for (const problem of ['key', 'permission', 'noMedia', 'credits', 'spendLimit', 'suspended'] as const) {
		const line = new AccountError(problem).message;
		assert.ok(line.endsWith(`your Pine account at ${PINE_ACCOUNT_URL}`), line);
		assert.doesNotMatch(line, /[A-Z]{2,}_[A-Z]+|\b(40\d|429)\b|Error/, 'no raw code, status or class name');
	}
	assert.match(new AccountError('rateLimited').message, /Try again in a minute$/);
	assert.match(new AccountError('capacity').message, /Try again in a minute/);
});

test('a message that meets an account problem is given back once with its line, and nothing is retried', async () => {
	for (const [op, problem] of [['ensureComputer', 'credits'], ['createSession', 'noMedia'], ['ensureComputer', 'key']] as const) {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-account-')));
		const root = join(dir, 'drama'); mkdirSync(root);
		const store = new Store(join(dir, 'studio.sqlite'));
		const pine = new FakePine();
		const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store, port: pine, vault: new MemoryVault(), pine: { endpoint: 'https://offline.invalid', apiKey: 'offline' },
			files: { libraryRoot: join(dir, 'library'), projectsRoot: join(dir, 'projects') }, protocol: testProtocol(dir) });
		try {
			pine.fail(op, new AccountError(problem));
			const said: Update[] = [];
			for await (const update of service.submit('main', 'make the drama', 'Project Chat', root)) { said.push(update); }
			const given = said.filter(u => u.kind === 'unsent');
			assert.equal(given.length, 1, `${op} ${problem}: ${said.map(u => u.text).join(' | ')}`);
			assert.ok(given[0].text.includes(new AccountError(problem).message), given[0].text);
			assert.equal(pine.calls[op], 1, `${op} ${problem}: asked once, not retried`);
			assert.equal(pine.calls.run ?? 0, 0, 'nothing was sent');
		} finally { store.close(); }
	}
});

test('a new session starts only where the Computer offers the drama skill, which comes with media generation', async () => {
	const port = new SdkPort();
	let skills: Record<string, unknown>[] = [];
	const created: string[] = [];
	port['computer'] = async () => ({
		skills: { list: async () => skills },
		createSession: async ({ label }: { label: string }) => { created.push(label); return { name: 's-1', token: 'ps_1' }; },
	}) as never;
	const env = { endpoint: 'https://offline.invalid', apiKey: 'offline' };
	await assert.rejects(port.createSession(env, 'credentials', 'binding', 'Pine Drama'), (e: Error) => e instanceof AccountError && e.problem === 'noMedia');
	skills = [{ name: 'drama-workflow', enabled: false }];
	await assert.rejects(port.createSession(env, 'credentials', 'binding', 'Pine Drama'), (e: Error) => e instanceof AccountError && e.problem === 'noMedia');
	assert.deepEqual(created, [], 'no session was started');
	skills = [{ name: 'drama-workflow', enabled: true }];
	assert.deepEqual(await port.createSession(env, 'credentials', 'binding', 'Pine Drama'), { name: 's-1', token: 'ps_1' });
});
