import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Throttled } from '../core/throttled';

/** A task whose runs the test ends one by one, counting how many run at once. */
function gate() {
	const ends: ((value: string) => void)[] = [];
	let running = 0;
	let most = 0;
	let started = 0;
	const task = () => {
		started += 1;
		running += 1;
		most = Math.max(most, running);
		const n = started;
		return new Promise<string>(resolve => ends.push(value => { running -= 1; resolve(`${value}${n}`); }));
	};
	return { task, ends, stats: () => ({ started, most }) };
}

test('calls while a run is in flight share one later run; runs never overlap or pile up', async () => {
	const g = gate();
	const t = new Throttled(g.task);
	const first = t.run();
	const during = [t.run(), t.run(), t.run()];
	assert.equal(during[0], during[1], 'the calls made meanwhile share one run');
	assert.deepEqual(g.stats(), { started: 1, most: 1 });
	g.ends[0]('run');
	assert.equal(await first, 'run1');
	await new Promise(setImmediate);
	assert.deepEqual(g.stats(), { started: 2, most: 1 }, 'the shared run starts only after the first ends');
	g.ends[1]('run');
	assert.deepEqual(await Promise.all(during), ['run2', 'run2', 'run2']);
	// Idle again: the next call starts its own run at once.
	const next = t.run();
	assert.equal(g.stats().started, 3);
	g.ends[2]('run');
	assert.equal(await next, 'run3');
});

test('a call made as the first run ends, before the queued run starts, joins the queued run (Codex on #388, round 5)', async () => {
	const g = gate();
	const t = new Throttled(g.task);
	const first = t.run();
	const second = t.run();
	g.ends[0]('run');
	await first;
	// Here the first run has ended and the queued one has not started yet.
	const third = t.run();
	assert.equal(third, second, 'it shares the queued run');
	await new Promise(setImmediate);
	assert.deepEqual(g.stats(), { started: 2, most: 1 }, 'never two at once');
	g.ends[1]('run');
	assert.deepEqual(await Promise.all([second, third]), ['run2', 'run2']);
});

test('a run that fails is reported to its callers and does not block the next one', async () => {
	let calls = 0;
	const t = new Throttled(async () => {
		calls += 1;
		if (calls === 1) {
			throw new Error('status timed out');
		}
		return 'ok';
	});
	const failed = t.run();
	const after = t.run();
	await assert.rejects(failed, /status timed out/);
	assert.equal(await after, 'ok');
	assert.equal(await t.run(), 'ok');
});
