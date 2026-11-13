// The files the agent names in its words, as Chat shows them. The agent writes
// Markdown links to files as they are on its Computer, relative to its working directory (`[line-by-line review](drama/screenplay/v2/review.md)`);
// Chat cannot resolve a path of another machine, so they showed as plain text and the person thought the files never came
// back. Only where a link points changes, in the same Markdown text: this reply's own file, arrived
// in the drama's mirror, becomes a `file:` link (allowed in Chat's Markdown, vscode markdownRenderer.ts:773-780); any other
// is its plain name; and the Studio's own plumbing links (handoff/…) are removed with the separators next to them, never
// the person-facing words or links around them. Where a file is comes from the one resolver (core/resolve.ts). No vscode import.

import { pathToFileURL } from 'node:url';
import { resolveReturned, type ResolveSources } from './resolve';

const PROJECT_LINK = /\[([^\]]*)\]\(((?:\.\/)?drama\/[^)\s]*)\)/g;
const PLUMBING = String.raw`\[[^\]]*\]\((?:\.\/)?handoff\/[^)\s]*\)`;
const SEPARATOR = String.raw`[ \t]*[·|,;][ \t]*`;
/** A plumbing link and one separator beside it: the one before it, else the one after it. */
const BEFORE = new RegExp(`${SEPARATOR}${PLUMBING}`, 'g');
const AFTER = new RegExp(`${PLUMBING}(?:${SEPARATOR})?`, 'g');

/** A line without its plumbing links; a line that held nothing else goes (undefined). */
function withoutPlumbing(line: string): string | undefined {
	const bare = line.replace(BEFORE, '').replace(AFTER, '');
	if (bare === line) {
		return line;
	}
	return bare.trim() === '' ? undefined : bare.replace(/[ \t]+$/, '');
}

/**
 * The place on this computer of a file the agent names as `drama/x` in the reply of `turnId`, when this stop's own file has
 * arrived there. Evidence, not existence: a reply is drawn before its files are downloaded, and a later
 * turn that names an existing path may be replacing it, so the old file would show as the new one, and stay so if the
 * download fails. So this turn's stop must have kept that path (a library row of this turn, which a failed download never
 * gets), and the resolver must find exactly those bytes in the mirror (state arrived, SHA-256 matching), with its
 * containment. Undefined otherwise: the name stays unlinked. Without a turn (a reply drawn while its turn runs) there is
 * no evidence yet; the history links it once the stop is saved.
 */
export function localProjectFile(src: ResolveSources, turnId: string | undefined, relPath: string): string | undefined {
	if (!turnId || !relPath.startsWith('drama/')) {
		return undefined;
	}
	const kept = src.store.libraryFile(turnId, relPath);
	if (!kept) {
		return undefined;
	}
	const found = resolveReturned(src, relPath, kept.sha, true);
	return found.state === 'arrived' && found.where === 'folder' ? found.path : undefined;
}

/**
 * `text` with its links to project files made for Chat: `resolve` gives a file's place on this computer (undefined when it
 * is not here, or may not be linked); such a link is its plain title.
 */
export function linkFiles(text: string, resolve: (relPath: string) => string | undefined): string {
	if (!text.includes('](')) {
		return text;
	}
	const lines = text.split('\n').flatMap(line => {
		const kept = withoutPlumbing(line);
		return kept === undefined ? [] : [kept];
	});
	return lines.join('\n').replace(PROJECT_LINK, (_, title: string, target: string) => {
		const place = resolve(target.replace(/^\.\//, ''));
		return place ? `[${title}](${pathToFileURL(place).href})` : title;
	}).replace(/\n{3,}/g, '\n\n').trimEnd();
}
