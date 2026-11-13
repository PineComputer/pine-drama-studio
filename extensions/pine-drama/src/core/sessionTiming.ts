// A session row's timing in the Sessions list. Code-OSS reads `timing.created ?? 0` (agentSessionsModel.ts:1315): a row with no
// timing is dated to 1970 and listed under "Older" as "57 yrs ago", which the row of a session whose first message was refused
// (a window with no folder) showed, as it was created before any turn. `created` is when the row was made; `lastRequestStarted`
// is "undefined if no requests have been made yet" (vscode.proposed.chatSessionsProvider.d.ts, ChatSessionItem.timing). No
// vscode import.

/** The row's timing from the store's ISO times; a missing or unreadable creation time is now, and a request that never started is left out. */
export function itemTiming(created: string | undefined, lastRequest: string | undefined, now: number): { created: number; lastRequestStarted?: number } {
	const at = (iso: string | undefined) => {
		const ms = iso ? Date.parse(iso) : NaN;
		return Number.isFinite(ms) ? ms : undefined;
	};
	const last = at(lastRequest);
	return { created: at(created) ?? now, ...(last === undefined ? {} : { lastRequestStarted: last }) };
}
