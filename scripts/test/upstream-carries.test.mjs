import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// dev-launch.sh refuses a Code-OSS checkout that lacks the exported series: a Code-OSS checkout on pine/main with 10 of
// the 22 patches once passed the old symbol check.
// Offline: a throwaway studio layout and a throwaway Code-OSS repository.

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'pine-upstream-carries-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const studio = join(root, 'studio'), vscode = join(root, 'vscode');
	mkdirSync(join(studio, 'scripts'), { recursive: true });
	mkdirSync(join(studio, 'upstream', 'patches'), { recursive: true });
	for (const name of ['upstream-lib.sh', 'upstream-carries.sh']) { copyFileSync(join(scripts, name), join(studio, 'scripts', name)); }
	mkdirSync(vscode);
	const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: vscode, encoding: 'utf8' }).trim();
	git('init', '-q', '-b', 'main');
	const commit = (file, text, message) => { writeFileSync(join(vscode, file), text); git('add', file); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
	const base = commit('upstream.ts', 'upstream\n', 'upstream base');
	git('checkout', '-q', '-b', 'pine/chat-review');
	const first = commit('pine.ts', 'one\n', 'pine(L2): one');
	const second = commit('pine.ts', 'one\ntwo\n', 'pine(L2): two');
	writeFileSync(join(studio, 'upstream', 'vscode.lock'), `repository=https://github.com/microsoft/vscode\nbase=${base}\nbranch=pine/chat-review\n`);
	git('format-patch', '--quiet', '--zero-commit', '--no-signature', '--no-stat', '-o', join(studio, 'upstream', 'patches'), `${base}..HEAD`);
	const carries = () => spawnSync('bash', [join(studio, 'scripts', 'upstream-carries.sh')], { env: { ...process.env, VSCODE_DIR: vscode }, encoding: 'utf8' });
	return { git, commit, base, first, second, carries };
}

test('a checkout on the series, or with work after it, is accepted', t => {
	const f = fixture(t);
	assert.equal(f.carries().status, 0);
	f.commit('pine.ts', 'one\ntwo\nthree\n', 'pine(L2): not exported yet');
	const out = f.carries();
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /carries the 2 patch\(es\)/);
});

test('a checkout that lacks a patch of the series is refused, naming it and the branch to check out', t => {
	const f = fixture(t);
	f.git('checkout', '-q', '-b', 'pine/main', f.first);
	const out = f.carries();
	assert.equal(out.status, 1);
	assert.match(out.stderr, /0002-pine-L2-two\.patch is not its change number 2/);
	assert.match(out.stderr, /Check out pine\/chat-review/);
});

test('a checkout without the base is refused', t => {
	const f = fixture(t);
	f.git('checkout', '-q', '--orphan', 'elsewhere');
	f.commit('other.ts', 'other\n', 'unrelated');
	const out = f.carries();
	assert.equal(out.status, 1);
	assert.match(out.stderr, /does not contain the base/);
});

test('the same changes as other commits (a rebuilt branch) match by patch id', t => {
	const f = fixture(t);
	f.git('checkout', '-q', '-b', 'rebuilt', f.base);
	f.git('cherry-pick', '-x', f.first, f.second); // -x records the source, so the commits differ
	assert.notEqual(f.git('rev-parse', 'HEAD'), f.second, 'other commits');
	const out = f.carries();
	assert.equal(out.status, 0, out.stderr);
});
