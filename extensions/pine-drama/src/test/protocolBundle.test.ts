import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

// A release ships the extension as one esbuild bundle, out/extension.js (scripts/package-macos.sh, stage_extension), so
// a path the code finds from its own compiled location does not exist there. The bundle here sits where protocol/ is not
// two folders up, as in the app, and must still check documents.
const ROOT = join(__dirname, '..', '..');

test('the protocol schema travels inside a one-file bundle, as a release ships the extension', () => {
	mkdirSync(join(ROOT, 'out', 'bundle-test'), { recursive: true });
	const dir = mkdtempSync(join(ROOT, 'out', 'bundle-test', 'b-'));
	try {
		const outfile = join(dir, 'extension.js');
		assert.equal(existsSync(join(dir, '..', '..', 'protocol')), false, 'the bundle must not find protocol/ by a path');
		buildSync({ entryPoints: [join(ROOT, 'src', 'core', 'protocol.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
			packages: 'external', outfile, logLevel: 'silent' });
		// A require of the bundle esbuild just wrote: its exports are the module's, typed by that module.
		const bundled = require(outfile) as typeof import('../core/protocol');
		assert.deepEqual(bundled.check('choices', { schema: 1, objects: {}, added: [], imports: [] }, 'choices.json'), { schema: 1, objects: {}, added: [], imports: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
