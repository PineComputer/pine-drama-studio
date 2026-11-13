// When the agent stops to ask, Pine's result summary and its question are often the same text (2026-11-03: the intake's
// question showed twice in Chat, first as the turn's result, then as "The agent asks:"). The person should read it once.
// No vscode import.

/** The text with its surrounding whitespace gone; empty text says nothing. */
const trimmed = (text: string) => text.trim();

/** Whether `inner` is `outer`, or a part of it, ignoring surrounding whitespace. Empty text is part of nothing. */
export function within(inner: string, outer: string): boolean {
	const a = trimmed(inner);
	return a.length > 0 && trimmed(outer).includes(a);
}

/**
 * The messages of a Chat as its history shows them: where a turn's result and its question repeat each other the
 * person sees one. A result that is the question, or part of it, is dropped (the question, under "The agent asks:", says
 * it); a question that is part of a longer result is dropped (the result already says it). Different texts keep both.
 */
export function withoutRepeatedQuestion<M extends { kind: string; turn_id: string | null; text: string }>(messages: readonly M[]): M[] {
	return messages.filter(m => {
		if ((m.kind !== 'result' && m.kind !== 'question') || !m.turn_id) {
			return true;
		}
		const other = messages.find(o => o !== m && o.turn_id === m.turn_id && o.kind === (m.kind === 'result' ? 'question' : 'result'));
		if (!other) {
			return true;
		}
		return m.kind === 'result'
			? !within(m.text, other.text)
			: !(within(m.text, other.text) && !within(other.text, m.text));
	});
}
