// The files the agent names in its words, as Chat shows them. The agent writes Markdown links to files as they are on
// its Computer, relative to its working directory (`[line-by-line review](drama/screenplay/v2/review.md)`); Chat cannot
// resolve a path of another machine, so such a link is shown as its plain title, and the Studio's own plumbing links
// (handoff/…) are removed with the separators next to them, never the person-facing words or links around them. No vscode import.

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

/** `text` with its links to the Computer's project files as their plain titles, and without the plumbing links. */
export function linkFiles(text: string): string {
	if (!text.includes('](')) {
		return text;
	}
	const lines = text.split('\n').flatMap(line => {
		const kept = withoutPlumbing(line);
		return kept === undefined ? [] : [kept];
	});
	return lines.join('\n').replace(PROJECT_LINK, (_, title: string) => title).replace(/\n{3,}/g, '\n\n').trimEnd();
}
