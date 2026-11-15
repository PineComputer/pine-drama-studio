// The files the agent names in its words, as Chat shows them. The agent writes Markdown links to files as they are on
// its Computer, relative to its working directory (`[line-by-line review](drama/screenplay/v2/review.md)`); Chat cannot
// resolve a path of another machine, so such a link is shown as its plain title, never the words or links around it.
// No vscode import.

const PROJECT_LINK = /\[([^\]]*)\]\(((?:\.\/)?drama\/[^)\s]*)\)/g;

/** `text` with its links to the Computer's project files as their plain titles. */
export function linkFiles(text: string): string {
	return text.replace(PROJECT_LINK, (_, title: string) => title);
}
