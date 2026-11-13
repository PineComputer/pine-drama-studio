// A session's title in the sessions list: the work's name once its project has come back, else its first message.
// The name is the brief's `Title:` line, which drama-cli requires
// of a brief (the brief's checks; section 2), read from the person's
// brief in the drama's folder (doc/protocol.md, section 3.3: `inputs/`). No vscode import.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat } from './store';

/**
 * The value of a brief's `Title:` line, if it has one, as the brief states it in the common Markdown forms: `Title:`,
 * `- Title:`, `* Title:` and `**Title:**`. The brief of 2026-11-02's drama is a list, `- Title: Never Divorce a Secret
 * Billionaire Heiress`, and a `Title:` read only at line start left its session row on the first message.
 */
export function briefTitle(brief: string): string | undefined {
	return /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?Title(?:\*\*)?:(?:\*\*)?[ \t]*(\S.*?)[ \t]*$/m.exec(brief)?.[1];
}

/** The person's brief, a client file (doc/protocol.md, section 3.3). */
export const BRIEF = 'inputs/brief.md';

/** The title of the drama in `folder`: its brief's `Title:`, or undefined while it has no brief. */
export function projectTitle(folder: string): string | undefined {
	const brief = join(folder, ...BRIEF.split('/'));
	return existsSync(brief) ? briefTitle(readFileSync(brief, 'utf8')) : undefined;
}

/** A session's title by its key, for the sessions list and the pickers; a brief that does not read is logged, not hidden. */
export function sessionTitles(rootOf: (key: string) => string | undefined, log: (line: string) => void, chat?: (key: string) => Chat | undefined): (key: string) => string | undefined {
	return key => {
		const conv = chat?.(key);
		if (conv?.folder) { return conv.label; }
		const root = rootOf(key);
		if (!root) {
			return undefined;
		}
		try {
			return projectTitle(root);
		} catch (error) {
			log(`title of ${key}: its project's brief does not read: ${(error as Error).message}`);
			return undefined;
		}
	};
}
