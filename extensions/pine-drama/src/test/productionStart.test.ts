import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('a project window starts on Production: the Project view opens without taking focus', async () => {
	const { runs, run } = recorder();
	await startOnProduction({ visible: false }, run);
	assert.deepEqual(runs, [{ command: 'pine.project.focus', options: { preserveFocus: true } }]);
});

// An initialized project with no stages yet has an empty tree; showing Production must not wait
// for a row to reveal.
test('a project with no stages yet still starts on Production', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pine-empty-project-'));
	try {
		writeFileSync(join(dir, 'choices.json'), JSON.stringify({ schema: 1, objects: {}, added: [], imports: [] }));
		const root = await DramaProject.rootIn(dir);
		assert.ok(root, 'the folder is a drama project');
		// The three steps show from the start, each empty; showing Production still does
		// not wait for a row to reveal.
		assert.deepEqual((await new DramaProject(root).children()).map(n => n.label), ['1. Script', '2. Assets', '3. Episodes'], 'its tree is the three steps');
		const { runs, run } = recorder();
		await startOnProduction({ visible: false }, run);
		assert.deepEqual(runs.map(r => r.command), ['pine.project.focus']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Production already showing is left as it is', async () => {
	const { runs, run } = recorder();
	await startOnProduction({ visible: true }, run);
	assert.deepEqual(runs, []);
});

// Opening a page keeps Chat where the person left it. The Script row once focused Review, a leftover from when Review
// held the script's details.
// A command link the person clicks in a Chat message is their own navigation and is not matched.
test('no code opens the Review tab on its own; only the person switches the right region to it', () => {
	const src = join(__dirname, '..', '..', 'src');
	const sources = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts') && !f.startsWith('test'));
	const opens = /executeCommand\(\s*[`'"](\$\{VIEW_ID\}\.focus|pine\.sessionReview\.focus|workbench\.view\.extension\.pine-review)/;
	const opening = sources.filter(f => opens.test(readFileSync(join(src, f), 'utf8')));
	assert.deepEqual(opening, []);
});
