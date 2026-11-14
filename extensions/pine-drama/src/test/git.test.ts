import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveEmbeddedGitDir } from 'dugite';
import { git } from '../core/git';

const ok = async (args: string[], cwd: string) => {
	const result = await git(args, cwd);
	assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
};

test('the bundled git runs, even when the environment names another', async () => {
	const saved = process.env.GIT_EXEC_PATH;
	process.env.GIT_EXEC_PATH = '/nonexistent/git-core';
	try {
		assert.equal(realpathSync(await ok(['--exec-path'], tmpdir())).startsWith(realpathSync(resolveEmbeddedGitDir())), true);
		assert.match(await ok(['--version'], tmpdir()), /^git version 2\.56\.1/);
	} finally {
		if (saved === undefined) {
			delete process.env.GIT_EXEC_PATH;
		} else {
			process.env.GIT_EXEC_PATH = saved;
		}
	}
});

test('the commands the Studio needs work with the bundled git', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pine-git-'));
	const as = ['-c', 'user.name=agent', '-c', 'user.email=agent@localhost'];
	await ok(['init', '-q'], dir);
	writeFileSync(join(dir, 'a.txt'), 'one\n');
	writeFileSync(join(dir, 'b.txt'), 'other\n');
	await ok(['add', '--', 'a.txt', 'b.txt'], dir);
	await ok([...as, 'commit', '-q', '-m', 'first', '--only', '--', 'a.txt'], dir);
	// --only commits a.txt alone; b.txt stays staged.
	assert.equal(await ok(['show', '--name-only', '--format=', 'HEAD'], dir), 'a.txt');
	assert.equal(await ok(['diff', '--cached', '--name-only'], dir), 'b.txt');
	// revert needs an index that matches HEAD.
	await ok(['reset', '-q', '--', 'b.txt'], dir);
	writeFileSync(join(dir, 'a.txt'), 'two\n');
	await ok([...as, 'commit', '-q', '-m', 'second', '--only', '--', 'a.txt'], dir);
	assert.equal(await ok(['log', '--format=%s', '--', 'a.txt'], dir), 'second\nfirst');
	assert.equal(await ok(['cat-file', '-p', 'HEAD~1:a.txt'], dir), 'one');
	await ok([...as, 'revert', '--no-edit', 'HEAD'], dir);
	assert.equal(await ok(['show', 'HEAD:a.txt'], dir), 'one');
	await ok(['update-ref', 'refs/pine/conflict/1', 'HEAD~1'], dir);
	assert.equal(await ok(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/pine/'], dir),
		`refs/pine/conflict/1 ${await ok(['rev-parse', 'HEAD~1'], dir)}`);
});
