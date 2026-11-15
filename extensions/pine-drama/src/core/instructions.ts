// The Studio's standing instructions to Pine's agent, sent once with the first run of a session. They are the Studio's
// text, never the person's: the history records them apart from the person's message. No vscode import.

/**
 * The budget: the person runs no budget, and on Pine the skill
 * sets a new project's budget_usd to null right after init. It is the budget
 * delegation the skill reads ("Use an existing or explicitly delegated brief and budget", "Your role and content
 * scope"); a number the person put in a config stays theirs.
 */
export const BUDGET =
	"Spending needs no cap: make every paid call without asking me about cost (on Pine a new project's budget_usd in drama/drama-cli.cfg.yaml is null, as the skill sets it). If the config has a number and drama-cli refuses a call for it, stop and tell me.";

/**
 * A paid call `gen get` leaves unknown: it is made again under the go that covered it, with no second question;
 * the agent never sends a creator to support. Since drama-cli v0.7.15, --retry first asks Pine about the earlier request under its own id, so it is never made
 * twice, finishes an image whose answer was saved, keeps a saved text reply from being lost (`_answer_saved`), and
 * records it lost at Pine's charge only when it can never be settled; v0.7.17's stage commands do so for a call of a session that is gone.
 * How a text call's saved reply is recovered is the skill's to say (the rules on jobs, --retry and gen get), not
 * this instruction's: since v0.7.70 some commands finish it when run again and others leave the stage held, and running a
 * whole batch again can pay for what already finished. A call made in another Pine session
 * cannot be observed from this one (pine_connection.py:63-67, ExecutionScopeChanged), so "check first" is never the
 * answer for it. The person's explicit word to redraw is their yes (an agent once declined a "use --retry" the person
 * had sent). A command with no --retry (a take, whose provider task is reconciled) or a --retry drama-cli refuses leaves the call held, said plainly.
 * Nothing paid starts without the person's yes.
 */
export const UNKNOWN_CALL =
	"If drama-cli gen get leaves a paid call unknown, or says the call belongs to another Pine session (then it can never be checked), say so plainly; the go that covered the call covers making it again, so run the command that made it again with --retry: drama-cli first asks about the earlier request under its own id, so it is never made twice, and a new one is made only when the earlier one can never be settled; an image whose answer was saved is finished from it instead. If that command has no --retry, or drama-cli refuses it, do what the refusal's action says, or tell the person in one line what stays held and why. Never ask the person to contact support or to look up a request.";

/** The instructions in the order they are sent, one per line. */
export const STANDING_INSTRUCTIONS: readonly string[] = [BUDGET, UNKNOWN_CALL];

/** The paragraph appended to a run's message; the person's own text comes before it, unchanged. */
export const STANDING_PARAGRAPH = STANDING_INSTRUCTIONS.join('\n');

export function withStandingInstructions(personText: string): string {
	return `${personText}\n\n${STANDING_PARAGRAPH}`;
}

/**
 * What the agent is told with a message the person wrote for a question or turn that changed before it was sent (a
 * preceding send moved the Chat on): the message goes as written, to what the session is now, and the agent judges what
 * it means. Studio text, recorded apart from the person's words, as the other notes are.
 */
export const CHANGED_TARGET_NOTE = 'Pine Drama Studio: the person wrote this message for an earlier question or turn of yours, which changed before it was sent; it is sent now as written.';
