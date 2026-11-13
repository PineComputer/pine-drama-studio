// The slots, supervision and version gate of scripts/pine-dev-lock.sh, and the heartbeat of scripts/test-on-pine-dev.sh,
// driven in a temporary root: no host, no network.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// flock and setpriv are Linux's (the host's, and CI's): this Mac has neither, so these tests run on pine-dev and in CI.
const has = cmd => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
const skip = !(has('flock') && has('setpriv')) && 'flock or setpriv is not installed here';
const lib = fileURLToPath(new URL('../pine-dev-lock.sh', import.meta.url));
const root = () => mkdtempSync(join(tmpdir(), 'ptd-lock-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Every child gets its own process group, and all of them are ended after the tests, so that a test which fails (or a
// mutation that breaks a guard) leaves no process holding this file's pipes open, and the file still ends.
const children = [];
const spawnGroup = (cmd, args, opts) => { const child = spawn(cmd, args, { ...opts, detached: true }); children.push(child); return child; };
after(() => {
	for (const c of children) {
		try { process.kill(-c.pid, 'SIGKILL'); } catch { /* the group has already ended */ }
		for (const s of [c.stdin, c.stdout, c.stderr]) { s?.destroy(); }
	}
});
/** A bash script as a child: its output as a promise made at once (a late listener would miss the close), and the child. */
const start = (script, stdin = 'ignore') => {
	const child = spawnGroup('bash', ['-c', script], { stdio: [stdin, 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', d => { out += d; });
	child.stderr.on('data', d => { out += d; });
	const done = new Promise(resolve => child.on('close', () => resolve(out)));
	return { child, done, out: () => out };
};
const run = script => start(script).done;
/** A shell that takes a slot, prints it, then holds it for `holdSeconds`. */
const holder = (dir, id, holdSeconds, wait = 5) => run(`source ${lib}; PTD_POLL=0.2 ptd_acquire "${dir}" ${wait} studio ${id} && { echo "slot $SLOT"; sleep ${holdSeconds}; }; echo "exit $?"`);
const slotFree = (dir, slot) => spawnSync('bash', ['-c', `exec 9>"${dir}/.slot-${slot}"; flock -n 9`]).status === 0;
const alive = pid => spawnSync('kill', ['-0', String(pid)]).status === 0;
/** Polls `check` every 100 ms; the time it took, or null after `ms`. */
const within = async (ms, check) => { const t = Date.now(); while (Date.now() - t < ms) { if (check()) { return Date.now() - t; } await sleep(100); } return null; };
const until = async (ms, check) => { assert.notEqual(await within(ms, check), null); };
/** A run under supervision as the host runs it: a slot, then `timeout` around a bash that writes its pid (its process group's leader is `timeout`). */
const supervised = (dir, body, { beat = 90, stdin = 'pipe', stdinFrom } = {}) => start(
	`${stdinFrom ? `exec < "${stdinFrom}"; ` : ''}source ${lib}; PTD_BEAT=${beat}; ptd_acquire "${dir}" 5 studio r1 || exit 3; echo "slot $SLOT"; ` +
	`ptd_supervise timeout -k 2 60 bash -c 'echo $PPID > "${dir}/group"; ${body}'; echo "exit $?"`, stdin);
/**
 * A caller's heartbeat, as test-on-pine-dev.sh sends it: a line every `ms` on the run's stdin, until the run is done
 * reading it. Then the pipe's write fails (EPIPE) and the beat ends, as the real caller's `echo` ends on SIGPIPE; the
 * write is never retried. `ended` holds that error's code and the run's output at that moment, so a test can check the
 * beat ended only once the run no longer needed it. (Seen in CI: a beat written after the run had exited was an
 * unhandled EPIPE.)
 */
/** A write into a pipe whose reader is gone: EPIPE, or, once Node has closed the child's stdin, a destroyed stream. */
const PIPE_GONE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);
const heartbeat = (r, ms = 500) => {
	const beat = { ended: null, stop: () => clearInterval(timer) };
	r.child.stdin.on('error', error => { beat.stop(); beat.ended = { code: error.code, out: r.out() }; });
	const timer = setInterval(() => {
		if (beat.ended) { return; }
		// A stream Node has already destroyed (the child closed) raises no error on a write: that is the run's end too.
		if (r.child.stdin.destroyed || r.child.stdin.writableEnded) { beat.stop(); beat.ended = { code: 'ERR_STREAM_DESTROYED', out: r.out() }; return; }
		r.child.stdin.write('\n');
	}, ms);
	return beat;
};
const groupGone = dir => { const g = readFileSync(join(dir, 'group'), 'utf8').trim(); return spawnSync('bash', ['-c', `pgrep -g ${g}`]).status !== 0; };

test('eight runs hold the eight slots, and a ninth waits, says so, and gives up', { skip }, async () => {
	const dir = root();
	const held = Array.from({ length: 8 }, (_, i) => holder(dir, `run${i}`, 4));
	await sleep(1200);
	assert.equal(readdirSync(dir).filter(f => f.endsWith('.holder')).length, 8);
	const ninth = spawnSync('bash', ['-c', `source ${lib}; PTD_POLL=0.2 ptd_acquire "${dir}" 1 studio ninth; echo "exit $?"`], { encoding: 'utf8' });
	assert.match(ninth.stdout, /all 8 slots taken \((studio run\d pid \d+ since [^;]+;){8}\)/);
	assert.match(ninth.stdout, /exit 1/);
	const outs = await Promise.all(held);
	assert.deepEqual(outs.map(o => /slot (\d)/.exec(o)?.[1]).sort(), ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('a waiting run takes the slot a finished run frees', { skip }, async () => {
	const dir = root();
	const first = Array.from({ length: 8 }, (_, i) => holder(dir, `run${i}`, i === 0 ? 1 : 6));
	await sleep(800);
	const waiting = await holder(dir, 'waiter', 0, 6);
	assert.match(waiting, /slot \d/);
	await Promise.all(first);
});

test('a holder whose shell is gone is not counted as active', { skip }, () => {
	const dir = root();
	const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
	writeFileSync(join(dir, '.slot-1.holder'), `studio gone pid ${dead} since 05:00:00Z\n`);
	writeFileSync(join(dir, '.slot-2.holder'), `studio live pid ${process.pid} since 05:01:00Z\n`);
	const out = spawnSync('bash', ['-c', `source ${lib}; ptd_holders "${dir}"`], { encoding: 'utf8' }).stdout;
	assert.equal(out, `studio live pid ${process.pid} since 05:01:00Z\n`);
});

test('kill -9 of the slot holder frees its slot, stops its run, and ends the connection of a caller still beating', { skip }, async () => {
	const dir = root();
	// The heartbeat comes from a writer of its own through a FIFO, as sshd keeps a connection's stdin open: node closes a
	// child's stdin pipe when the child exits, which would end the watcher however it was written.
	spawnSync('mkfifo', [join(dir, 'beat')]);
	const writer = spawnGroup('bash', ['-c', `while :; do echo; sleep 0.3; done > "${dir}/beat"`], { stdio: 'ignore' });
	const r = supervised(dir, 'sleep 50', { stdin: 'ignore', stdinFrom: join(dir, 'beat') });
	await until(3000, () => /slot 1/.test(r.out()) && existsSync(join(dir, 'group')));
	assert.equal(slotFree(dir, 1), false);
	const reaped = new Promise(resolve => r.child.once('exit', resolve));   // a zombie still answers kill -0
	r.child.kill('SIGKILL');
	await until(3000, () => slotFree(dir, 1));
	await until(3000, () => groupGone(dir));
	await reaped;
	assert.equal(spawnSync('bash', ['-c', `source ${lib}; ptd_holders "${dir}"`]).stdout.toString(), '', 'the dead holder is not counted');
	// The caller's side of the connection (here the child's stdout) closes although its heartbeat goes on.
	const closed = await Promise.race([r.done.then(() => true), sleep(3000).then(() => false)]);
	process.kill(-writer.pid, 'SIGKILL');
	assert.equal(closed, true, 'the connection was still open 3 s after the holder died');
});

test('when the caller\'s connection closes, the run stops at once and its slot frees', { skip }, async () => {
	const dir = root();
	const r = supervised(dir, 'sleep 50');
	await until(3000, () => existsSync(join(dir, 'group')));
	r.child.stdin.end();
	const out = await r.done;
	assert.match(out, /exit 5/);
	assert.equal(slotFree(dir, 1), true);
	await until(3000, () => groupGone(dir));
});

test('when the heartbeat stops (the Mac sleeps), the run stops after the beat limit', { skip }, async () => {
	const dir = root();
	const t = Date.now();
	const r = supervised(dir, 'sleep 50', { beat: 2 });
	const out = await r.done;   // stdin stays open and silent
	assert.match(out, /exit 5/);
	assert.ok(Date.now() - t < 6000, `stopped after ${Date.now() - t} ms`);
	assert.equal(slotFree(dir, 1), true);
	await until(3000, () => groupGone(dir));
	r.child.stdin.end();
});

// 2026-11-09: nothing read the heartbeat while a run waited for a slot or cores, so runs whose callers had gone held their
// slot through a ~25 min wait and stopped "the caller went away" only once they had claimed. The wait reads it too.
/** A run waiting for a slot, as pine-dev-test-remote.sh waits: its caller's heartbeat read meanwhile (ptd_watch_wait). */
const waiter = (dir, beat = 90) => start(`source ${lib}; PTD_BEAT=${beat}; PTD_POLL=0.2; ptd_watch_wait; ` +
	`ptd_acquire "${dir}" 30 studio w && { ptd_unwatch_wait; echo "slot $SLOT"; sleep 3; }; echo "exit $?"`, 'pipe');

test('a waiting run whose caller goes away stops waiting at once and never takes the slot that frees', { skip }, async () => {
	const dir = root();
	const held = Array.from({ length: 8 }, (_, n) => holder(dir, `h${n}`, 3));
	await until(3000, () => Array.from({ length: 8 }, (_, n) => !slotFree(dir, n + 1)).every(Boolean));
	const w = waiter(dir);
	await until(3000, () => /all 8 slots taken/.test(w.out()));
	const t = Date.now();
	w.child.stdin.end();
	await w.done;
	assert.ok(Date.now() - t < 2000, `stopped ${Date.now() - t} ms after its caller went`);
	assert.doesNotMatch(w.out(), /slot \d/);
	await Promise.all(held);
	assert.ok(!readdirSync(dir).some(f => f.endsWith('.holder') && /studio w pid/.test(readFileSync(join(dir, f), 'utf8'))), 'it holds no slot');
});

test('a waiting run whose heartbeat goes silent stops after the beat limit; with a heartbeat it waits on and takes the slot', { skip }, async () => {
	const dir = root();
	const held = Array.from({ length: 8 }, (_, n) => holder(dir, `s${n}`, 4));
	await until(3000, () => Array.from({ length: 8 }, (_, n) => !slotFree(dir, n + 1)).every(Boolean));
	const t = Date.now();
	const silent = waiter(dir, 2);   // stdin open, no line
	const beating = waiter(dir, 2);
	const beat = heartbeat(beating);
	await silent.done;
	assert.ok(Date.now() - t < 3500, `the silent one stopped ${Date.now() - t} ms after it started, by its 2 s beat limit, before any slot frees at 4 s`);
	assert.doesNotMatch(silent.out(), /slot \d/, 'the silent one stopped waiting');
	await Promise.all(held);
	assert.match(await beating.done, /slot \d/, 'the beating one took a slot once one was free');
	beat.stop();
	// The caller's pipe may only fail once the run is done with the heartbeat: after it took its slot, never while it waits.
	assert.ok(beat.ended === null || (PIPE_GONE.has(beat.ended.code) && /slot \d/.test(beat.ended.out)), `the heartbeat ended early: ${JSON.stringify(beat.ended)}`);
	silent.child.stdin.end(); beating.child.stdin.end();
});

// The fake caller's own check (seen in CI): a beat written into a run that was done with its stdin ended in an
// unhandled EPIPE. Here the run closes its stdin at once and stays alive, so the caller's next beat meets the closed pipe
// (EPIPE, every time); the beat must end quietly on it, as the real caller's `echo` ends on SIGPIPE.
test('the fake caller\'s heartbeat ends on the run\'s closed pipe, as the real caller\'s does, never as an error', async () => {
	const r = start('exec 0<&-; sleep 2', 'pipe');
	const beat = heartbeat(r, 20);
	try {
		await until(1500, () => beat.ended !== null);
		assert.equal(beat.ended.code, 'EPIPE');
	} finally {
		beat.stop();
	}
	await r.done;
});

test('with a heartbeat the run goes to its end, and its own exit code comes back at once', { skip }, async () => {
	const dir = root();
	const r = supervised(dir, 'sleep 3; exit 7', { beat: 2 });
	const beat = heartbeat(r);
	const out = await r.done;
	beat.stop();
	r.child.stdin.end();
	assert.match(out, /exit 7/);
	assert.equal(slotFree(dir, 1), true);
});

test('a run with a never-ending sampler and two shards ends within 2 s of its last shard, and its slot frees', { skip }, async () => {
	// The shape of a pine-dev-test-remote.sh run: a memory sampler in the background for the whole run, then
	// the shards in parallel. A bare `wait` waited for the sampler too, so every run held its slot to the time limit.
	const dir = root();
	const body = `source ${lib}; ( while :; do sleep 0.5; done ) & SAMPLER=$!; trap "kill $SAMPLER" EXIT; ` +
		`shard() { sleep $(($1 + 1)); date +%s%3N > "${dir}/shard-$1.end"; }; ptd_parallel 2 shard`;
	const r = supervised(dir, body);
	const beat = heartbeat(r);
	const freedAfter = await within(15000, () => existsSync(join(dir, 'shard-1.end')) && slotFree(dir, 1));
	beat.stop();
	if (freedAfter === null) { r.child.kill('SIGKILL'); }
	r.child.stdin.end();
	assert.notEqual(freedAfter, null, 'the slot was still held 15 s after the run started');
	const lastShard = Number(readFileSync(join(dir, 'shard-1.end'), 'utf8'));
	const freedAt = Date.now();
	assert.ok(freedAt - lastShard < 2000, `slot freed ${freedAt - lastShard} ms after the last shard`);
	assert.match(await r.done, /exit 0/);
});

test('the gate refuses a runner older than the host has seen, and records a newer one', { skip }, () => {
	const dir = root();
	const gate = version => spawnSync('bash', ['-c', `source ${lib}; PTD_RUNNER=${version}; ptd_gate "${dir}"; echo "exit $?"`], { encoding: 'utf8' }).stdout;
	assert.match(gate(5), /exit 0/);
	assert.equal(readFileSync(join(dir, '.runner-version'), 'utf8').trim(), '5');
	assert.match(gate(5), /exit 0/);
	assert.equal(gate(4), 'rebase onto main; this runner is older than the host\'s (runner 4, host 5)\nexit 1\n');
	assert.match(gate(6), /exit 0/);
	assert.equal(readFileSync(join(dir, '.runner-version'), 'utf8').trim(), '6');
});

test('two gates at once: an older runner that read first never writes over a newer one', { skip }, async () => {
	const dir = root();
	writeFileSync(join(dir, '.runner-version'), '1\n');
	// The older runner pauses right after it read the version (its `cat` is wrapped) while a newer one comes to the gate.
	const older = start(`source ${lib}; PTD_RUNNER=2; cat() { command cat "$@"; touch "${dir}/read"; sleep 1; }; ptd_gate "${dir}"; echo "exit $?"`);
	await until(3000, () => existsSync(join(dir, 'read')));
	const newer = start(`source ${lib}; PTD_RUNNER=3; ptd_gate "${dir}"; echo "exit $?"`);
	assert.match(await older.done, /exit 0/);
	assert.match(await newer.done, /exit 0/);
	assert.equal(readFileSync(join(dir, '.runner-version'), 'utf8').trim(), '3');
});

test('runners from before the gate stop at once and say why', { skip }, () => {
	const dir = root();
	writeFileSync(join(dir, '.lock'), ''); writeFileSync(join(dir, '.lock-3'), '');
	assert.equal(spawnSync('bash', ['-c', `source ${lib}; ptd_gate "${dir}"`]).status, 0);
	// The lines of the first runner (one run at a time) that take its lock, verbatim with ROOT and WAIT set.
	const v448 = `ROOT="${dir}"; WAIT=30; exec 9>"$ROOT/.lock"
	if ! flock -n 9; then
		echo "pine-dev is busy ($(cat "$ROOT/.holder" 2>/dev/null || echo 'another run')); waiting up to $WAIT min for it"
		flock -w "$((WAIT * 60))" 9 || { echo "still busy after $WAIT min; nothing was run"; exit 3; }
	fi
	echo RAN`;
	// The second runner's ptd_acquire, verbatim, given a one-second wait.
	const v468 = `ptd_acquire() {
	local root="$1" wait="$2" repo="$3" id="$4" end said=0 s
	end=$(( $(date +%s) + wait ))
	mkdir -p "$root"
	while :; do
		for s in $(seq 1 8); do
			exec 9>"$root/.lock-$s"
			if flock -n 9; then
				echo RAN; return 0
			fi
			exec 9>&-
		done
		if [ "$said" = 0 ]; then
			echo "pine-dev has all 8 slots taken ($(cat "$root"/.holder-* 2>/dev/null | tr '\\n' ';')); waiting up to $((wait / 60)) min for one"
			said=1
		fi
		[ "$(date +%s)" -ge "$end" ] && return 1
		sleep 0.2
	done
}; ptd_acquire "${dir}" 1 studio old || exit 3`;
	for (const [name, script] of [['#448', v448], ['#468', v468]]) {
		const t = Date.now();
		const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
		assert.equal(r.status, 3, `${name}: ${r.stdout}${r.stderr}`);
		assert.doesNotMatch(r.stdout, /RAN/, name);
		assert.match(r.stdout, /rebase onto main; this runner is older than the host's/, name);
		assert.ok(Date.now() - t < 3000, `${name} took ${Date.now() - t} ms`);
	}
});

test('a run removes its own folders when it ends, keeps its logs, and touches no other run', { skip: false }, () => {
	const dir = root();
	const mine = join(dir, 'studio', 'mine'); const other = join(dir, 'studio', 'other');
	for (const d of [mine, other]) { mkdirSync(join(d, 'src', 'deep'), { recursive: true }); mkdirSync(join(d, 'venv')); writeFileSync(join(d, 'run.log'), 'log'); }
	assert.equal(spawnSync('bash', ['-c', `source ${lib}; ptd_finish "${mine}"`]).status, 0);
	assert.deepEqual(readdirSync(mine), ['run.log']);
	assert.deepEqual(readdirSync(other).sort(), ['run.log', 'src', 'venv']);
	assert.ok(statSync(join(other, 'src', 'deep')).isDirectory());
});

test('a TERM to the local script alone ends its ssh and its heartbeat at once', { skip: !has('git') && 'git is not installed here' }, async () => {
	// The script itself, with ssh and scp replaced: the host holds everything already, and the run's ssh reads its stdin.
	const dir = root();
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\ncase "\${@: -1}" in *pine-dev-test-remote.sh*) echo $$ > "${dir}/ssh.pid"; cat > /dev/null;; esac\nexit 0\n`, { mode: 0o755 });
	writeFileSync(join(bin, 'scp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const script = fileURLToPath(new URL('../test-on-pine-dev.sh', import.meta.url));
	const child = spawnGroup('bash', [script, 'studio', 'HEAD'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PINE_DEV_HOST: 'fake' }, stdio: 'ignore' });
	const exited = new Promise(resolve => child.on('exit', resolve));
	await until(10000, () => existsSync(join(dir, 'ssh.pid')));
	const ssh = Number(readFileSync(join(dir, 'ssh.pid'), 'utf8'));
	await sleep(300);
	child.kill('SIGTERM');
	const t = Date.now();
	await Promise.race([exited, sleep(3000)]);
	assert.notEqual(child.exitCode ?? child.signalCode, null, 'the script was still running 3 s after TERM');
	assert.ok(Date.now() - t < 3000);
	await until(3000, () => !alive(ssh));
});

/** The claims of the live runs in `dir`, summed. */
const claimed = dir => spawnSync('bash', ['-c', `source ${lib}; ptd_holders "${dir}" | awk '{for (i = 1; i < NF; i++) if ($i == "cores") n += $(i + 1)} END {print n + 0}'`], { encoding: 'utf8' }).stdout.trim();
/** A shell that takes a slot and claims its cores of 16, prints the claim, and holds both for `hold` seconds. */
const claimer = (dir, id, hold, wait = 5, before = '') => start(`source ${lib}; PTD_CORES=16; PTD_POLL=0.2; ${before} ptd_acquire "${dir}" 5 studio ${id} || exit 3; ` +
	`ptd_cores "${dir}" $SLOT ${wait} && echo "share $SHARE"; echo "exit $?"; sleep ${hold}`);

test('a run alone claims half the cores, so a second run can start at once, and the claim is on its holder line', { skip }, async () => {
	const dir = root();
	const first = claimer(dir, 'a', 3);
	await until(3000, () => /share/.test(first.out()));
	assert.match(first.out(), /share 8/);
	assert.match(readFileSync(join(dir, '.slot-1.holder'), 'utf8'), /^studio a pid \d+ since \S+ cores 8\n$/);
	const second = claimer(dir, 'b', 0);
	assert.match(await second.done, /share 8/);
	await first.done;
});

test('a run takes only the cores the live runs have not claimed, and a dead run\'s claim is free', { skip }, async () => {
	const dir = root();
	const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
	writeFileSync(join(dir, '.slot-7.holder'), `studio gone pid ${dead} since 05:00:00Z cores 8\n`);
	writeFileSync(join(dir, '.slot-8.holder'), `studio live pid ${process.pid} since 05:01:00Z cores 6\n`);
	// Two live runs with this one: at most 16 / 2 = 8, and 16 - 6 = 10 are free (the dead run's 8 count for nothing).
	assert.match(await claimer(dir, 'c', 0).done, /share 8/);
	writeFileSync(join(dir, '.slot-8.holder'), `studio live pid ${process.pid} since 05:01:00Z cores 13\n`);
	assert.match(await claimer(dir, 'd', 0).done, /share 3/, 'only 3 are free');
});

test('when the live runs have claimed every core, a run waits, says so, and gives up', { skip }, async () => {
	const dir = root();
	writeFileSync(join(dir, '.slot-8.holder'), `studio live pid ${process.pid} since 05:01:00Z cores 16\n`);
	const out = await claimer(dir, 'e', 0, 1).done;
	assert.match(out, /the active runs have claimed all 16 cores \([^)]*studio live pid \d+ since 05:01:00Z cores 16;/);   // every live holder, in any order
	assert.match(out, /exit 1/);
	assert.doesNotMatch(readFileSync(join(dir, '.slot-1.holder'), 'utf8'), /cores/);
});

test('two runs claiming at once never claim more than the cores between them', { skip }, async () => {
	const dir = root();
	writeFileSync(join(dir, '.slot-8.holder'), `studio live pid ${process.pid} since 05:01:00Z cores 12\n`);
	// The first pauses between counting the free cores and writing its claim (its `sed` is wrapped); the second counts then.
	const first = claimer(dir, 'f', 2, 1, `sed() { touch "${dir}/counted"; sleep 1; command sed "$@"; };`);
	await until(3000, () => existsSync(join(dir, 'counted')));
	const second = claimer(dir, 'g', 2, 1);
	const [a, b] = await Promise.all([first.done, second.done]);
	assert.match(a, /share 4/);
	assert.match(b, /claimed all 16 cores/);
	assert.ok(Number(claimed(dir)) <= 16, `claims add up to ${claimed(dir)}`);
});

test('a live run that has not claimed yet has taken no core', { skip }, async () => {
	const dir = root();
	writeFileSync(join(dir, '.slot-7.holder'), `studio claimed pid ${process.pid} since 05:00:00Z cores 10\n`);
	writeFileSync(join(dir, '.slot-8.holder'), `studio unclaimed pid ${process.pid} since 05:01:00Z\n`);
	// Only the 10 claimed count, so 6 are free; at most 16 / 3 active = 5.
	assert.match(await claimer(dir, 'h', 0).done, /share 5/);
});

// The deadlock of 2026-11-09: eight runs took the eight slots together, none had claimed yet, and each counted
// the seven others' unclaimed holders as 4 cores each, 28 > 16, so every one waited out its wait with the cores free.
// Runs arriving together all claim, at once, and never more than the cores between them.
test('eight runs arriving together all claim at once, within the cores', { skip }, async () => {
	const dir = root();
	// The claims' lock is held until all eight hold their slots, so all eight count each other before any claims
	// (worker-07: unheld, they could claim one after another and pass even under the old rule).
	const lock = start(`exec 7>"${dir}/.cores"; flock 7; touch "${dir}/locked"; sleep 30`);
	await until(3000, () => existsSync(join(dir, 'locked')));
	const runs = Array.from({ length: 8 }, (_, n) => claimer(dir, `p${n}`, 3, 2));
	await until(4000, () => Array.from({ length: 8 }, (_, n) => existsSync(join(dir, `.slot-${n + 1}.holder`))).every(Boolean));
	process.kill(-lock.child.pid, 'SIGKILL');
	await until(4000, () => runs.every(r => /share \d+|exit 1/.test(r.out())));
	assert.ok(runs.every(r => /share \d+/.test(r.out())), `every run claimed: ${runs.map(r => r.out()).join(' | ')}`);
	const shares = runs.map(r => Number(/share (\d+)/.exec(r.out())[1]));
	assert.ok(shares.every(s => s >= 1), `every run claimed: ${shares}`);
	assert.ok(Number(claimed(dir)) <= 16, `claims add up to ${claimed(dir)}`);
	await Promise.all(runs.map(r => r.done));
});

test('with fewer cores than runs, every free core is claimed and only then do runs wait', { skip }, async () => {
	const dir = root();
	const runs = Array.from({ length: 6 }, (_, n) => start(`source ${lib}; PTD_CORES=4; PTD_POLL=0.2; ptd_acquire "${dir}" 5 studio q${n} || exit 3; ` +
		`ptd_cores "${dir}" $SLOT 1 && echo "share $SHARE"; echo "exit $?"; sleep 2`));
	const outs = await Promise.all(runs.map(r => r.done));
	const shares = outs.map(o => /share (\d+)/.exec(o)?.[1]).filter(Boolean).map(Number);
	assert.deepEqual([shares.length, shares.reduce((a, b) => a + b, 0)], [4, 4], `four runs claimed one core each: ${outs.join(' | ')}`);
	assert.equal(outs.filter(o => /claimed all 4 cores/.test(o)).length, 2, 'the other two waited, saying why');
});
