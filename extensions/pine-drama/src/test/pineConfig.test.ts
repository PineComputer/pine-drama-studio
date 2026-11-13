import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { configLine, endpointHost, keyPrefix, notSetUpText, parseDotenv, pineConfig, pineFromDotenv, sendGate } from '../pineConfig';

// One Pine from one file, under the SDK's names, and its problems in
// fixed words. The values below stand for secrets: none may appear in any message.
const SECRET = 'pk_ab12cd_s3cretvalue';
const FILE = '/repo/.env';

test('parseDotenv: comments, export, quotes and trailing comments', () => {
	const values = parseDotenv([
		'# a comment',
		'#PINE_SANDBOX_API_KEY=pk_commented_out',
		'export A=1',
		'B="two words"',
		"C='3'",
		'D=4 # trailing',
		'not a line',
	].join('\n'));
	assert.deepEqual([...values], [['A', '1'], ['B', 'two words'], ['C', '3'], ['D', '4']]);
});

test('one Pine environment: the SDK\'s three names; other variables are ignored', () => {
	const config = pineConfig(FILE, { text: [
		'PINE_SANDBOX_ENDPOINT=http://lvh.me:18080/',
		`PINE_SANDBOX_API_KEY=${SECRET}`,
		'PINE_SANDBOX_CONTROL_HOST=api.lvh.me:18080',
		'OTHER=1',
	].join('\n') });
	assert.deepEqual(config, { kind: 'set', file: FILE, pine: { endpoint: 'http://lvh.me:18080', apiKey: SECRET, controlHost: 'api.lvh.me:18080' } });
	assert.equal(configLine(config), `Pine: http://lvh.me:18080 (key pk_ab12cd_…) from ${FILE}`);
	assert.doesNotMatch(configLine(config), /s3cret/);
});

test('each problem in its own words, joined with "; "', () => {
	assert.deepEqual(pineFromDotenv(''), { problems: ['PINE_SANDBOX_ENDPOINT is missing', 'PINE_SANDBOX_API_KEY is missing'] });
	assert.deepEqual(pineFromDotenv('PINE_SANDBOX_ENDPOINT=lvh.me:18080\nPINE_SANDBOX_API_KEY=sk-s3cret'), {
		problems: ['PINE_SANDBOX_ENDPOINT is not an http:// or https:// address', 'PINE_SANDBOX_API_KEY is not a pk_ project key'],
	});
	const config = pineConfig(FILE, { text: 'PINE_SANDBOX_ENDPOINT=https://pinesandbox.io' });
	assert.equal(configLine(config), `Pine environment not set up: ${FILE}: PINE_SANDBOX_API_KEY is missing`);
});

test('#101: the old two-environment file is refused whole, naming its PINE_ENV_* lines and no value', () => {
	const text = [
		'PINE_SANDBOX_ENDPOINT=https://pinesandbox.io',
		`PINE_SANDBOX_API_KEY=${SECRET}`,
		'PINE_ENV_DEV_ENDPOINT=http://lvh.me:18080',
		'PINE_ENV_DEV_API_KEY=pk_ef34gh_s3cretdev',
	].join('\n');
	const config = pineConfig(FILE, { text });
	assert.equal(config.kind, 'invalid');
	assert.deepEqual(config.kind === 'invalid' && config.problems, [
		'PINE_ENV_DEV_ENDPOINT, PINE_ENV_DEV_API_KEY are no longer read: the Studio uses one Pine environment, set with PINE_SANDBOX_ENDPOINT and PINE_SANDBOX_API_KEY',
	]);
	const said = [configLine(config), config.kind === 'invalid' ? notSetUpText(config) : ''].join('\n');
	assert.doesNotMatch(said, /s3cret|pinesandbox\.io|lvh\.me/);
});

test('a missing file and an unreadable one, as the chat and Output say them', () => {
	const missing = pineConfig(FILE, { error: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) });
	assert.deepEqual(missing, { kind: 'missing', file: FILE });
	assert.equal(configLine(missing), `Pine environment not set up: ${FILE} does not exist`);
	assert.equal(missing.kind === 'missing' && notSetUpText(missing),
		`**No Pine environment is set up, so nothing was sent.** The Studio connects to one Pine environment, set in \`${FILE}\`, and that file does not exist. Write it, then quit and reopen the Studio.`);
	const unreadable = pineConfig(FILE, { error: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) });
	assert.equal(unreadable.kind === 'invalid' && notSetUpText(unreadable),
		`**No Pine environment is set up, so nothing was sent.** \`${FILE}\` does not say which Pine environment to use: cannot be read (EACCES: permission denied). Fix the file, then quit and reopen the Studio.`);
});

test('a key is shown by its public prefix only; an endpoint by its host', () => {
	assert.equal(keyPrefix(SECRET), 'pk_ab12cd_…');
	assert.equal(keyPrefix('pk_nounderscore'), 'pk_…');
	assert.equal(endpointHost('http://lvh.me:18080/x'), 'lvh.me:18080');
});

test('#111: with no Pine environment set up, a send is told that first, whatever the window\'s folders', () => {
	const missing = pineConfig(FILE, { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
	for (const folders of [[], ['/a'], ['/a', '/b']]) {
		const gate = sendGate(missing, folders);
		assert.equal(gate.kind, 'pine', `${folders.length} folder(s)`);
		assert.match(gate.kind === 'pine' ? gate.text : '', /^\*\*No Pine environment is set up, so nothing was sent\.\*\*/);
		assert.match(gate.kind === 'pine' ? gate.text : '', /set in `[^`]+`, and that file does not exist\. Write it, then quit and reopen the Studio\.$/);
	}
	const set = pineConfig(FILE, { text: `PINE_SANDBOX_ENDPOINT=http://lvh.me:18080\nPINE_SANDBOX_API_KEY=${SECRET}` });
	assert.deepEqual(sendGate(set, []), { kind: 'folder', entry: { kind: 'none' } });
	assert.deepEqual(sendGate(set, ['/a']), { kind: 'folder', entry: { kind: 'one', folder: '/a' } });
});
