import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROJECT_FILES, ProjectFinder } from '../core/projectFinder';

// A window opened on an empty folder: its session's first stop writes <folder>/drama/choices.json after the
// window activated, and the Production views must pick the project up without a reload. The person once saw drama/ in the Explorer while Production still said "No drama
// project is open", because the project was looked for once, at activation.

function setup(delayMs = 20) {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pine-finder-')));
	const seen: (string | undefined)[] = [];
	const errors: string[] = [];
	let notify: (() => void) | undefined;
	const finder = new ProjectFinder(() => [folder], root => { seen.push(root); notify?.(); }, error => errors.push(error.message), delayMs);
	const next = () => new Promise<void>(resolve => { notify = resolve; });
	return { folder, finder, seen, errors, next };
}
const arrive = (folder: string) => {
	writeFileSync(join(folder, 'choices.json'), 'project: x\n');
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the watched files are the two a folder\'s project can have, relative to the folder', () => {
	assert.equal(PROJECT_FILES, 'choices.json');
});

test('an empty folder has no project; one that arrives later is found, after the burst of events settles', async () => {
	const { folder, finder, seen, next } = setup();
	assert.equal(await finder.scan(), undefined);
	assert.deepEqual(seen, [], 'nothing changed: no project then, none now');
	arrive(folder);
	const found = next();
	finder.possibleChange(); // the directory's creation
	finder.possibleChange(); // the file's
	finder.possibleChange(); // settle's own refresh
	await found;
	await pause(60);
	assert.deepEqual(seen, [folder], 'one scan for the burst, and the project is the opened root');
	finder.dispose();
});

test('a project whose config file goes is no longer shown, and one that comes back is shown again', async () => {
	const { folder, finder, seen, next } = setup();
	arrive(folder);
	assert.equal(await finder.scan(), folder);
	rmSync(join(folder, 'choices.json'));
	let changed = next();
	finder.possibleChange();
	await changed;
	arrive(folder);
	changed = next();
	finder.possibleChange();
	await changed;
	assert.deepEqual(seen, [folder, undefined, folder]);
	finder.dispose();
});

test('an event that changes nothing reports nothing', async () => {
	const { folder, finder, seen } = setup();
	arrive(folder);
	await finder.scan();
	writeFileSync(join(folder, 'choices.json'), 'project: y\n');
	finder.possibleChange();
	await pause(80);
	assert.deepEqual(seen, [folder]);
	finder.dispose();
});

test('a scan that fails is reported, and the next event scans again', async () => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pine-finder-')));
	const errors: string[] = [];
	const seen: (string | undefined)[] = [];
	let fail = true;
	const finder = new ProjectFinder(() => [folder], root => {
		if (fail) {
			throw new Error('the views could not take it');
		}
		seen.push(root);
	}, error => errors.push(error.message), 10);
	arrive(folder);
	finder.possibleChange();
	await pause(50);
	assert.deepEqual(errors, ['the views could not take it']);
	fail = false;
	finder.possibleChange();
	await pause(50);
	assert.deepEqual(seen, [folder], 'the change that failed is reported again, not lost');
	finder.dispose();
});
