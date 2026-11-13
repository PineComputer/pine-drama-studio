import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CanvasPicks } from '../core/canvasPicks';

/** A canvas whose pick resolves when the test says so, with the workbench as a log. */
function setup() {
	const log: string[] = [];
	let active = true;
	const picks = new CanvasPicks<string>({
		isActive: () => active,
		showInVersions: async pick => void log.push(`versions:${pick}`),
		followActive: () => void log.push('follow'),
	});
	const slow = () => {
		let done!: () => void;
		const wait = new Promise<void>(resolve => (done = resolve));
		return { resolve: (name: string) => wait.then(() => name), done };
	};
	return { log, picks, slow, setActive: (value: boolean) => (active = value) };
}

test('a pick on the active canvas is cached and shown in Versions', async () => {
	const { log, picks } = setup();
	assert.equal(await picks.pick('EP001', async () => 'natalie'), true);
	assert.equal(picks.get('EP001'), 'natalie');
	assert.deepEqual(log, ['versions:natalie']);
});

test('unpick forgets the pick and empties Versions at once while the canvas is active', async () => {
	const { log, picks } = setup();
	await picks.pick('EP001', async () => 'natalie');
	picks.unpick('EP001');
	assert.equal(picks.get('EP001'), undefined);
	assert.deepEqual(log, ['versions:natalie', 'follow']);
});

test('unpick on a canvas that is not in front leaves Versions alone', () => {
	const { log, picks, setActive } = setup();
	setActive(false);
	picks.unpick('EP001');
	assert.deepEqual(log, []);
});

test('a late pick after an unpick does not bring the pick back', async () => {
	const { log, picks, slow } = setup();
	const late = slow();
	const pending = picks.pick('EP001', () => late.resolve('natalie'));
	picks.unpick('EP001');
	late.done();
	assert.equal(await pending, false);
	assert.equal(picks.get('EP001'), undefined);
	assert.deepEqual(log, ['follow']);
});

test('a late pick after a newer pick applies nothing', async () => {
	const { log, picks, slow } = setup();
	const late = slow();
	const first = picks.pick('EP001', () => late.resolve('cassie'));
	await picks.pick('EP001', async () => 'natalie');
	late.done();
	assert.equal(await first, false);
	assert.equal(picks.get('EP001'), 'natalie');
	assert.deepEqual(log, ['versions:natalie']);
});

test('a late pick after a tab switch is cached but does not touch Versions', async () => {
	const { log, picks, slow, setActive } = setup();
	const late = slow();
	const pending = picks.pick('EP001', () => late.resolve('natalie'));
	setActive(false); // the person went to Settings
	late.done();
	assert.equal(await pending, true);
	assert.equal(picks.get('EP001'), 'natalie'); // the canvas subject shows it when the person comes back
	assert.deepEqual(log, []);
});

test('canvases keep their own picks and sequences', async () => {
	const { picks, slow } = setup();
	const late = slow();
	const pending = picks.pick('EP001', () => late.resolve('natalie'));
	picks.unpick('EP002');
	late.done();
	assert.equal(await pending, true);
	assert.equal(picks.get('EP001'), 'natalie');
	picks.close('EP001');
	assert.equal(picks.get('EP001'), undefined);
});
