// A message the Studio does not send, as the person sees it: one line in the
// chat, with the actions that go on as command links. No modal on top of it, since the line already says why and offers the
// same actions, and a second display prevents nothing; no paragraph and no stream
// buttons. The message itself comes back in the line, quoted, for the person to send again. No vscode import.

/** The commands a refusal's actions run. */
export interface RefusalCommands {
	readonly openFolder: string;
	readonly newFolder: string;
	readonly openGivenFolder: string;
}

export type Situation =
	/** `text`: pineConfig.ts's notSetUpText, chat Markdown already. */
	| { readonly kind: 'pine'; readonly text: string }
	| { readonly kind: 'none' }
	| { readonly kind: 'rootChanged' }
	| { readonly kind: 'several'; readonly count: number }
	| { readonly kind: 'unassigned' }
	| { readonly kind: 'elsewhere'; readonly folder: string }
	| { readonly kind: 'inside'; readonly folder: string; readonly project: string };

export interface Action {
	readonly label: string;
	readonly command: string;
	readonly args: readonly unknown[];
}

export interface Refusal {
	/** The chat's one line, plain Markdown, without the actions. */
	readonly line: string;
	/** The actions, in order, drawn as links after the line. */
	readonly actions: readonly Action[];
	/** The person's message, given back under the line to send again; absent when there is none to give. */
	readonly message?: string;
}

const BELOW = 'Your message is below, to send again.';

/**
 * A path or a file name as a code span, as notSetUpText shows its file (pineConfig.ts), so Markdown in it stays literal:
 * a backtick string longer than any run in it, padded with a space when it starts or ends with one (CommonMark 0.31,
 * section 6.1), and on one line. A name can then never close the span and add a link to a trusted line.
 */
export function codeSpan(value: string): string {
	const flat = value.replace(/[\r\n]+/g, ' ');
	const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longest + 1);
	const pad = /^`|`$/.test(flat) ? ' ' : '';
	return `${fence}${pad}${flat}${pad}${fence}`;
}
const code = codeSpan;

/**
 * Why a message is not sent, in one line, with the actions that go on, and the message given back under it. With no
 * message (the refusal found again at the send, refusalLine) the line says nothing of one. `attached`: the names of the
 * files the message carried, which need adding again.
 */
export function refusalOf(situation: Situation, commands: RefusalCommands, message = '', attached: readonly string[] = []): Refusal {
	const again = attached.length ? ` These attachments need adding again: ${attached.map(code).join(', ')}.` : '';
	const kept = (sentence: string) => message ? ` ${sentence}${again}` : again;
	const given = message ? { message } : {};
	const folderActions: Action[] = [
		{ label: 'Open Folder…', command: commands.openFolder, args: [] },
		{ label: 'New Folder…', command: commands.newFolder, args: [] },
	];
	switch (situation.kind) {
		case 'pine':
			return { line: situation.text, actions: [] };
		case 'none':
			return { line: `Not sent: this window has no folder.${kept(BELOW)}`, actions: folderActions, ...given };
		case 'rootChanged':
			return { line: `Not sent: the opened project folder changed. Open the intended project explicitly.${kept(BELOW)}`, actions: folderActions, ...given };
		case 'several':
			return { line: `Not sent: this window has ${situation.count} folders; open one.${kept(BELOW)}`, actions: folderActions, ...given };
		case 'unassigned':
			return { line: `Not sent: this project has no admitted executor. Its files remain available for inspection.${kept(BELOW)}`, actions: [], ...given };
		case 'elsewhere':
			return {
				line: `Not sent: this session's drama is in another folder, ${code(situation.folder)}.${kept(BELOW)}`,
				actions: [{ label: 'Open Its Folder', command: commands.openGivenFolder, args: [situation.folder] }, ...folderActions], ...given,
			};
		case 'inside':
			return {
				line: `Not sent: this folder holds a drama-cli project, ${code(situation.project)}; open it to continue it, or choose another folder for this drama. Nothing is touched.${kept(BELOW)}`,
				actions: [{ label: 'Open That Project', command: commands.openGivenFolder, args: [situation.project] }, ...folderActions], ...given,
			};
	}
}

/** A command as a Markdown link, with its arguments as VS Code's command URIs take them (a JSON array, encoded). */
export function commandLink(action: Action): string {
	const args = action.args.length ? `?${encodeURIComponent(JSON.stringify(action.args))}` : '';
	return `[${action.label}](command:${action.command}${args})`;
}

/**
 * The person's own text, verbatim, as a fenced code block (CommonMark 0.31, section 4.5): a fence longer than any run of
 * backticks in it, so the block shows the text as typed and copies back exactly.
 */
export function quoted(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}

/**
 * A message given back under a refusal: the files it carried, named to add again, then its text as typed. It ends
 * with a blank line, so Markdown streamed after it in the same reply starts a block of its own and never runs into the fence.
 */
export function givenBack(text: string, attached: readonly string[] = []): string {
	const again = attached.length ? `_These attachments need adding again: ${attached.map(code).join(', ')}._\n\n` : '';
	return `${again}${quoted(text)}\n\n`;
}

/** The chat's one line: the reason in italics, then the actions as links on the same line; the message given back under it. */
export function chatLine(refusal: Refusal): string {
	const line = refusal.actions.length ? `_${refusal.line}_ ${refusal.actions.map(commandLink).join(' · ')}` : `_${refusal.line}_`;
	return refusal.message ? `${line}\n\n${givenBack(refusal.message)}` : line;
}

/** The command ids the line's links run: the only ones a trusted Markdown for it enables. */
export function enabledCommands(refusal: Refusal): string[] {
	return [...new Set(refusal.actions.map(action => action.command))];
}

/** The chat line alone, for a refusal found again at the send itself (the window's check and the send are not one step). */
export function refusalLine(situation: Situation): string {
	return refusalOf(situation, { openFolder: '', newFolder: '', openGivenFolder: '' }).line;
}
