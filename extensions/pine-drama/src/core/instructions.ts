// The Studio's notes to Pine's agent with a message: the Studio's text, never the person's, so the history records them
// apart from the person's message. The workflow's own rules are the skill's (skills/drama-workflow), not the Studio's.
// No vscode import.

/**
 * What the agent is told with a message the person wrote for a question or turn that changed before it was sent (a
 * preceding send moved the Chat on): the message goes as written, to what the session is now, and the agent judges what
 * it means. Studio text, recorded apart from the person's words, as the other notes are.
 */
export const CHANGED_TARGET_NOTE = 'Pine Drama Studio: the person wrote this message for an earlier question or turn of yours, which changed before it was sent; it is sent now as written.';
