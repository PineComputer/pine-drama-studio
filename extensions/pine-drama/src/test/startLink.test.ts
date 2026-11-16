import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readStartLink, startRequest } from '../core/startLink';

// A partner's "Open in Pine Drama Studio" link (core/startLink.ts): it names a preset or the connection, carries no
// key, and anything else is no link.
test('a start link names a preset by its drama-cli name, a connect link opens the connection, and nothing else is a link', () => {
	assert.deepEqual(readStartLink('/start', 'preset=customer-xxcited'), { kind: 'start', preset: 'customer-xxcited' });
	assert.equal(startRequest('customer-xxcited'), 'Make this drama with the customer-xxcited preset.');
	assert.deepEqual(readStartLink('/connect', ''), { kind: 'connect' });
	assert.deepEqual(readStartLink('/connect', 'key=pk_secret'), { kind: 'connect' }, 'a key in a link is never read');
	for (const [path, query] of [['/start', ''], ['/start', 'preset=Customer XXcited'], ['/start', 'preset=../x'], ['/start', `preset=${'a'.repeat(65)}`], ['/run', 'preset=x'], ['/', '']]) {
		assert.equal(readStartLink(path, query), undefined, `${path}?${query}`);
	}
});
