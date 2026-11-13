// Explicit UI decisions only. Identities and files come from the host, never from page text.
// The one message protocol between the review card's host (reviewCard.ts) and its webview (media/reviewCard.js, which
// imports these types with // @ts-check), as Code-OSS's markdown preview shares one message-type file between its
// extension and preview script (extensions/markdown-language-features/types/previewMessaging.d.ts).
import type { ReviewView } from './reviews';

const REVIEW_CARD_VERSION = 1;
/** Visible consent statement adopted by the explicit Submit action, never represented as typed words. */
export const REVIEW_APPROVAL_STATEMENT = 'I approve the versions marked Approve.';
/** Why a `pine-review` fence renders no card: one text per cause (fix plan item 12). */
export const REVIEW_CARD_NOT_ISSUED = 'This is not a review card issued by Pine Drama Studio.';
export const REVIEW_CARD_OTHER_PROJECT = 'This review card does not belong to the current project.';
/** Shown on a rendered card once the window no longer has its project open. */
export const REVIEW_CARD_OPEN_PROJECT = 'Open the owning project to review these items.';

/** Host to webview: the card's state, or why it cannot act. Every host `postMessage` is one of these. */
export type ReviewCardUpdate =
	/** `continuing`: the review's continuation is being sent from this window (reviewView.ts, the submit guard). */
	| { version: 1; review: ReviewView | undefined; thumbnails: Record<string, (string | undefined)[]>; approvalStatement: string; ready: boolean; locked: boolean; continuing: boolean }
	| { version: 1; error: string };

/** Webview to host: one explicit action. */
export type ReviewCardAction =
	| { version: 1; action: 'ready' | 'approveAll' }
	/** `words`: the card's Anything else field, sent as the person's own words, never an approval (right-region.md). */
	| { version: 1; action: 'submit'; notes: Record<string, string>; words: string }
	| { version: 1; action: 'decide'; item: string; verdict: 'approve' | 'revise'; reason?: string }
	| { version: 1; action: 'open'; item: string; file: number }
	/** The card's own failure or empty paint, for the Output channel: a webview has no log of its own (AGENTS coding rule 1). */
	| { version: 1; action: 'report'; message: string };

export function reviewCardAction(value: unknown): ReviewCardAction {
	if (!value || typeof value !== 'object') { throw new Error('Invalid review action.'); }
	const v = value as Record<string, unknown>;
	if (v.version !== REVIEW_CARD_VERSION) { throw new Error('Unsupported review card version. Reload the window.'); }
	if (v.action === 'ready' || v.action === 'approveAll') { return { version: 1, action: v.action }; }
	if (v.action === 'submit' && v.notes && typeof v.notes === 'object' && !Array.isArray(v.notes)
		&& Object.values(v.notes).every(note => typeof note === 'string') && typeof v.words === 'string') {
		return { version: 1, action: 'submit', notes: v.notes as Record<string, string>, words: v.words };
	}
	if (v.action === 'decide' && typeof v.item === 'string' && (v.verdict === 'approve' || v.verdict === 'revise')
		&& (v.reason === undefined || typeof v.reason === 'string')) {
		return { version: 1, action: v.action, item: v.item, verdict: v.verdict, reason: v.reason as string | undefined };
	}
	if (v.action === 'open' && typeof v.item === 'string' && Number.isInteger(v.file) && (v.file as number) >= 0) {
		return { version: 1, action: v.action, item: v.item, file: v.file as number };
	}
	if (v.action === 'report' && typeof v.message === 'string') { return { version: 1, action: 'report', message: v.message.slice(0, 500) }; }
	throw new Error('Invalid review action.');
}
