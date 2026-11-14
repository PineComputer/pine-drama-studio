// The seg editor's messages between the extension (segEditor.ts) and its webview (canvas/seg.tsx), versioned.
// No vscode import.

import type { CanvasDetail } from './canvasProtocol';

export const SEG_PROTOCOL = 7;

/** One seg of the episode. */
export interface Seg {
	readonly id: string;
	/** Its take object's id, or null when the episode lists none for the seg. */
	readonly take: string | null;
	/** Its take's versions the person has not discarded, in version order: the editor plays the chosen one. */
	readonly takes: readonly SegTake[];
	/** The version the editor plays first: the accepted take, else the current one (segTakes.ts `shownTake`); null with none. */
	readonly shown: string | null;
	/** Before a take is made, its planned prompt, or null when none is. */
	readonly planned: PlannedPrompt | null;
	/** Its badge in the strip (segTakes.ts `takeBadge`). */
	readonly badge: string;
	/** Its tile's picture: the shown take's video, else its first keyframe's picture (webview addresses), else null. */
	readonly poster: Poster | null;
}

/** One take of a seg. */
export interface SegTake {
	readonly version: string;
	/** Its standing (doc/protocol.md, section 3.2): Accepted, Waiting for review, or Earlier take. */
	readonly label: string;
	/** Its video's webview address, or null when the version shows no file. */
	readonly src: string | null;
}

/** An object's prompt for its next version (doc/protocol.md, section 5.1): the person's where set, else the agent's. */
export interface PlannedPrompt {
	readonly by: 'agent' | 'person';
	readonly text: string;
}

export interface Poster {
	readonly media: 'video' | 'image';
	readonly src: string;
}

export interface SegEditorModel {
	readonly episode: string;
	readonly segs: readonly Seg[];
	/** The accepted cut's version and its video (a webview address, null when the file is missing), or null when none is accepted. */
	readonly cut: { readonly version: string; readonly src: string | null } | null;
	/** When the episode's snapshot was observed, or null before its first return: the badges are as of then. */
	readonly observedAt: string | null;
}

export type ToSegEditor =
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'model'; readonly model: SegEditorModel }
	/** Choose this seg: the canvas's "Open in Seg Editor" on one of its cards. */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'show'; readonly seg: string }
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'error'; readonly episode: string; readonly message: string }
	/** What a take was made with, read when the page shows it, by the canvas panel's reader (versionDetail.ts requestDetail). */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'request'; readonly key: string; readonly request: CanvasDetail | null };

export type FromSegEditor =
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'ready' }
	/** Generate (`again` false) or Regenerate (true): put the seg's shoot request in its episode's session's input for the person to send. */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'generate'; readonly seg: string; readonly again: boolean }
	/** The toggle: show this episode's canvas (section 12c, the episode's two views of one model). */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'canvas' }
	/** A reference of the request was clicked: show the card of the stage its file is. */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'go'; readonly stageId: string }
	/**
	 * The take on screen: what it was made with is asked for when shown, as the canvas asks for a picked card's. `key` comes
	 * back with the answer: the page names each ask by the model it was drawn from, so an answer to an older one is never shown.
	 */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'request'; readonly take: string; readonly version: string; readonly key: string }
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'failed'; readonly message: string };

/** A message from the webview, or undefined when it is not one of ours. */
export function readFromSegEditor(value: unknown): FromSegEditor | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const message = value as { v?: unknown; type?: unknown; message?: unknown; stageId?: unknown; seg?: unknown; again?: unknown; take?: unknown; version?: unknown; key?: unknown };
	if (message.v !== SEG_PROTOCOL) {
		return undefined;
	}
	if (message.type === 'ready' || message.type === 'canvas') {
		return { v: SEG_PROTOCOL, type: message.type };
	}
	if (message.type === 'generate' && typeof message.seg === 'string' && typeof message.again === 'boolean') {
		return { v: SEG_PROTOCOL, type: 'generate', seg: message.seg, again: message.again };
	}
	if (message.type === 'go' && typeof message.stageId === 'string') {
		return { v: SEG_PROTOCOL, type: 'go', stageId: message.stageId };
	}
	if (message.type === 'request' && typeof message.take === 'string' && typeof message.version === 'string' && typeof message.key === 'string') {
		return { v: SEG_PROTOCOL, type: 'request', take: message.take, version: message.version, key: message.key };
	}
	if (message.type === 'failed' && typeof message.message === 'string') {
		return { v: SEG_PROTOCOL, type: 'failed', message: message.message };
	}
	return undefined;
}
