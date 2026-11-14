import { exec, IGitStringExecutionOptions, resolveEmbeddedGitDir } from 'dugite';

/**
 * Runs the git the Studio ships, and never another: dugite-native, which dugite's install step downloads and checks
 * into node_modules/dugite/git. dugite would otherwise take a git folder or exec path the environment names
 * (setupEnvironment in dugite's lib/git-environment.ts reads LOCAL_GIT_DIRECTORY and GIT_EXEC_PATH first), so this sets
 * the one and empties the other, which dugite then derives from the folder.
 */
export function git(args: string[], cwd: string, options: IGitStringExecutionOptions = {}) {
	return exec(args, cwd, { ...options, env: { ...options.env, LOCAL_GIT_DIRECTORY: resolveEmbeddedGitDir(), GIT_EXEC_PATH: '' } });
}
