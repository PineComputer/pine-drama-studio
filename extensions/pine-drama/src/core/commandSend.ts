// A message that runs a command as the turn instead of going to the agent: one that starts with `$ ` (a shell
// prompt's sign), as a card's Regenerate writes it, and as the person may type it. Pine runs it as a command turn
// (PineSandbox PublicCommandRun): a turn like the agent's, billed and stopped as one, of a program the Computer lists.
// No vscode import.

import { parse, quote } from 'shell-quote';

const PROMPT = '$ ';

/**
 * The argv of a command message, or null for a message to the agent. Words are read as a POSIX shell reads them
 * (shell-quote); anything a shell would do beyond words (an operator, a glob, a comment) refuses the message, since Pine
 * runs the program without a shell.
 */
export function commandOf(text: string): string[] | null {
	if (!text.startsWith(PROMPT)) { return null; }
	const words = parse(text.slice(PROMPT.length).trim(), name => `$${name}`);
	if (!words.length || words.some(word => typeof word !== 'string')) {
		throw new Error('A message that starts with "$ " runs one program with its arguments: no pipes, redirections, globs or comments.');
	}
	return words as string[];
}

/** The message that runs `argv`, its words quoted so commandOf reads them back. */
export function commandMessage(argv: readonly string[]): string {
	return PROMPT + quote([...argv]);
}
