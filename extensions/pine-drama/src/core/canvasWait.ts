// What the episode canvas says while it waits for its first message (the person's report of 2026-11-08: a blank canvas
// with nothing in the log, AGENTS.md coding rule 1), and when nothing has come. No DOM.

/** After this long with no message, the canvas says nothing has come. */
export const CANVAS_WAIT_LIMIT_S = 120;

/** The canvas's line while it waits, by the seconds since it asked. */
export function waitingText(episode: string, seconds: number): string {
	return seconds < CANVAS_WAIT_LIMIT_S
		? `Reading ${episode}… ${seconds} s`
		: `Nothing of ${episode} has come after ${CANVAS_WAIT_LIMIT_S} s. The Output panel (Pine Drama Studio) says why; close and open the canvas to ask again.`;
}
