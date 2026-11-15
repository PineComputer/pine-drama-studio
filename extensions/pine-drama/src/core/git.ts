import { exec, IGitStringExecutionOptions, resolveEmbeddedGitDir, spawn } from 'dugite';

/**
 * The git the Studio ships, and never another: dugite-native, which dugite's install step downloads and checks into
 * node_modules/dugite/git. dugite would otherwise take a git folder or exec path the environment names (setupEnvironment
 * in dugite's lib/git-environment.ts reads LOCAL_GIT_DIRECTORY and GIT_EXEC_PATH first), so this sets the one and
 * empties the other, which dugite then derives from the folder.
 */
const shipped = (env: Record<string, string | undefined> = {}) => ({ ...env, LOCAL_GIT_DIRECTORY: resolveEmbeddedGitDir(), GIT_EXEC_PATH: '' });

/** Runs the shipped git to its end. */
export function git(args: string[], cwd: string, options: IGitStringExecutionOptions = {}) {
	return exec(args, cwd, { ...options, env: shipped(options.env) });
}

/** Starts the shipped git, its output read as it comes (a blob's bytes, hashed without holding them). */
export function gitStream(args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
	return spawn(args, cwd, { env: shipped(env) });
}
