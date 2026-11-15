import { strict as assert } from 'node:assert';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
	} finally {
		if (saved === undefined) {
			delete process.env.GIT_EXEC_PATH;
		} else {
			process.env.GIT_EXEC_PATH = saved;
		}
	}
});

