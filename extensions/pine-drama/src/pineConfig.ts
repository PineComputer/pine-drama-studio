// The one Pine environment the Studio connects to, from one file: an endpoint and a pk_ project key, like an OpenAI-compatible base
// URL and API key, under the Pine SDK's own names (PINE_SANDBOX_*, read by Client.fromEnv), and no others
// (section 1; amended 2026-11-02). Pure: no I/O, so it is tested without the workbench.
// Values are never put in a message: the endpoint is shown by its host and the key by its prefix (AGENTS coding rule 7).

import type { PineConnection } from './core/pinePort';

const ENDPOINT = 'PINE_SANDBOX_ENDPOINT';
const API_KEY = 'PINE_SANDBOX_API_KEY';
const CONTROL_HOST = 'PINE_SANDBOX_CONTROL_HOST';

/** What the file says: the Pine environment to use, or why it says none. */
export type PineConfig =
	| { readonly kind: 'set'; readonly file: string; readonly pine: PineConnection; readonly saved?: boolean }
	| { readonly kind: 'disconnected' }
	| { readonly kind: 'missing'; readonly file: string }
	| { readonly kind: 'invalid'; readonly file: string; readonly problems: readonly string[] };

/** Parses dotenv text: KEY=VALUE, optional `export `, `#` comments, single or double quotes. */
export function parseDotenv(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		let value = match[2];
		const quoted = /^(['"])(.*)\1$/.exec(value);
		if (quoted) {
			value = quoted[2];
		} else {
			value = value.replace(/\s+#.*$/, '').trim();
		}
		values.set(match[1], value);
	}
	return values;
}

/**
 * The Pine a file's text names, or its problems, each in the Studio's words. A file that still has
 * `PINE_ENV_<NAME>_*` lines is the old two-environment file, whose PINE_SANDBOX_* was production: reading only
 * those would connect to production without a word, so it is refused whole, with the names found (never the values).
 */
export function pineFromDotenv(text: string): { pine: PineConnection } | { problems: string[] } {
	const values = parseDotenv(text);
	const problems: string[] = [];
	const endpoint = values.get(ENDPOINT) ?? '';
	const apiKey = values.get(API_KEY) ?? '';
	if (!endpoint) {
		problems.push(`${ENDPOINT} is missing`);
	} else if (!/^https?:\/\/[^/\s]+/.test(endpoint)) {
		problems.push(`${ENDPOINT} is not an http:// or https:// address`);
	}
	if (!apiKey) {
		problems.push(`${API_KEY} is missing`);
	} else if (!apiKey.startsWith('pk_')) {
		problems.push(`${API_KEY} is not a pk_ project key`);
	}
	const old = [...values.keys()].filter(name => name.startsWith('PINE_ENV_'));
	if (old.length > 0) {
		problems.push(`${old.join(', ')} ${old.length === 1 ? 'is' : 'are'} no longer read: the Studio uses one Pine environment, set with ${ENDPOINT} and ${API_KEY}`);
	}
	if (problems.length > 0) {
		return { problems };
	}
	const controlHost = values.get(CONTROL_HOST);
	return { pine: { endpoint: endpoint.replace(/\/+$/, ''), apiKey, ...(controlHost ? { controlHost } : {}) } };
}

/** The file's outcome from what reading it gave: its text, or the error (ENOENT is a missing file). */
export function pineConfig(file: string, read: { text: string } | { error: NodeJS.ErrnoException }): PineConfig {
	if ('error' in read) {
		return read.error.code === 'ENOENT'
			? { kind: 'missing', file }
			: { kind: 'invalid', file, problems: [`cannot be read (${read.error.message})`] };
	}
	const parsed = pineFromDotenv(read.text);
	return 'pine' in parsed ? { kind: 'set', file, pine: parsed.pine } : { kind: 'invalid', file, problems: parsed.problems };
}

export function endpointHost(endpoint: string): string {
	return endpoint.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
}

/** A key as it may be shown: its public prefix, `pk_<key id>_…` (AGENTS coding rule 7). */
export function keyPrefix(apiKey: string): string {
	const match = /^(pk_[^_]+_)/.exec(apiKey);
	return match ? `${match[1]}…` : 'pk_…';
}

/** The reply to a message sent while no Pine environment is set up: nothing was sent. */
export function notSetUpText(config: Exclude<PineConfig, { kind: 'set' }>): string {
	if (config.kind === 'disconnected') { return '**No Pine connection is set up, so nothing was sent.** Open Accounts (bottom left) → Pine Computer… to connect with your project key.'; }
	return config.kind === 'missing'
		? `**No Pine environment is set up, so nothing was sent.** The Studio connects to one Pine environment, set in \`${config.file}\`, and that file does not exist. Write it, then quit and reopen the Studio.`
		: `**No Pine environment is set up, so nothing was sent.** \`${config.file}\` does not say which Pine environment to use: ${config.problems.join('; ')}. Fix the file, then quit and reopen the Studio.`;
}

/** Output › Pine Drama Studio, at start: the file and the Pine environment's endpoint, or what is wrong. */
export function configLine(config: PineConfig): string {
	switch (config.kind) {
		case 'disconnected':
			return 'Pine Computer: not connected. Open Accounts → Pine Computer…';
		case 'set':
			return `Pine: ${config.pine.endpoint} (key ${keyPrefix(config.pine.apiKey)}) from ${config.file}`;
		case 'missing':
			return `Pine environment not set up: ${config.file} does not exist`;
		case 'invalid':
			return `Pine environment not set up: ${config.file}: ${config.problems.join('; ')}`;
	}
}

/** The chat's one "model" (spike S10: upstream needs a model to send). It is not a language model and has no window. */
export const PINE_MODEL = { id: 'pine', name: 'Pine', maxInputTokens: 0, maxOutputTokens: 0 } as const;

/** What the window's folders allow: a session needs exactly one, on this computer. */
export type FolderEntry =
	| { readonly kind: 'one'; readonly folder: string }
	| { readonly kind: 'none' }
	| { readonly kind: 'several'; readonly count: number };

function folderEntry(fileFolders: readonly string[]): FolderEntry {
	if (fileFolders.length === 1) {
		return { kind: 'one', folder: fileFolders[0] };
	}
	return fileFolders.length === 0 ? { kind: 'none' } : { kind: 'several', count: fileFolders.length };
}

/**
 * What a send meets first. No Pine environment set up is said before any folder problem: until one is set up nothing
 * can be sent from any folder, and a window with neither would otherwise be sent to open a folder first and refused
 * again after. Otherwise the window's folders decide (folderEntry; 4.1).
 */
export function sendGate(config: PineConfig, fileFolders: readonly string[]): { kind: 'pine'; text: string } | { kind: 'folder'; entry: FolderEntry } {
	return config.kind !== 'set' ? { kind: 'pine', text: notSetUpText(config) } : { kind: 'folder', entry: folderEntry(fileFolders) };
}
