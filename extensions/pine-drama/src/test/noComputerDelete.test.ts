import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SdkPort } from '../sdkPort';

// A Computer's artifacts outlive a stop but not a deletion (worker-04's live smoke on pine-dev, 2026-11-03: after
// delete_computer the artifacts token is UnknownComputerError 404). A task's result is read from them, so the Studio
// must never delete a Computer while one of its tasks is unpublished (local first, 11.1). It has no way to delete one
// at all: Stop All, Mark as Done and a session's end only stop. This pins that no code path can.

test('the Studio\'s Pine port has no way to delete a Computer, and no source file calls the SDK\'s deletion', () => {
	const methods = Object.getOwnPropertyNames(SdkPort.prototype);
	assert.deepEqual(methods.filter(name => /delete|destroy|remove/i.test(name)), [], 'SdkPort offers no deletion');
	const src = join(__dirname, '..', '..', 'src');
	for (const file of ['sdkPort.ts', 'core/pinePort.ts', 'core/chats.ts', 'pineSessions.ts', 'extension.ts']) {
		assert.doesNotMatch(readFileSync(join(src, file), 'utf8'), /deleteComputer\s*\(|\.delete_computer\b/, `${file} deletes no Computer`);
	}
});
