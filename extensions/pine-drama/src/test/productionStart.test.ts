import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DramaProject } from '../core/project';
import { startOnProduction } from '../productionStart';

type Run = { command: string; options: unknown };
const recorder = () => {
	const runs: Run[] = [];
	return { runs, run: async (command: string, options: unknown) => { runs.push({ command, options }); } };
};

// An initialized project with no stages yet has an empty tree; showing Production must not wait
// for a row to reveal, and opens the Project view without taking focus.
test('a project window starts on Production without taking focus, a project with no stages yet too', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pine-empty-project-'));
	try {
		writeFileSync(join(dir, 'pine-drama-project.json'), '{"schema":2}\n');
		const root = await DramaProject.rootIn(dir);
		assert.ok(root, 'the folder is a drama project');
		// The three steps show from the start, each empty; showing Production still does
		// not wait for a row to reveal.
		assert.deepEqual((await new DramaProject(root).children()).map(n => n.label), ['1. Script', '2. Assets', '3. Episodes'], 'its tree is the three steps');
		const { runs, run } = recorder();
		await startOnProduction({ visible: false }, run);
		assert.deepEqual(runs, [{ command: 'pine.project.focus', options: { preserveFocus: true } }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Production already showing is left as it is', async () => {
	const { runs, run } = recorder();
	await startOnProduction({ visible: true }, run);
	assert.deepEqual(runs, []);
});

