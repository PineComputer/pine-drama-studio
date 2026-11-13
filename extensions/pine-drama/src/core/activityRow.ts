// How one step of the agent's work is drawn: as a tool-invocation row, which Code-OSS keeps in its tool chain,
// previews while it runs, folds to one summary row, and joins "Completed N steps" at the end.
// A later push with the same id updates the row (`enablePartialUpdate`), and only its
// completion message is used, so a step that did not complete says so in the words, not in an error flag. The words are the agent's own title and Pine's own state.

/** The states of an SDK `AgentActivity`; a step ends with exactly one of these. */
const ENDED = ['completed', 'failed', 'declined', 'interrupted'];

interface ActivityRow {
	readonly toolCallId: string;
	readonly isComplete: boolean;
	/** Shown while the step runs. */
	readonly invocationMessage: string;
	/** Shown when it has ended; a step that did not complete says how it ended. */
	readonly pastTenseMessage: string | undefined;
}

export function activityRow(update: { readonly id: string; readonly text: string; readonly state: string }): ActivityRow {
	const ended = ENDED.includes(update.state);
	return {
		toolCallId: update.id,
		isComplete: ended,
		invocationMessage: update.text,
		pastTenseMessage: ended ? (update.state === 'completed' ? update.text : `${update.text} (${update.state})`) : undefined,
	};
}
