// The seg editor's messages between the extension (segEditor.ts) and its webview (canvas/seg.tsx), versioned.
// No vscode import.

import type { CanvasDetail } from './canvasProtocol';

export const SEG_PROTOCOL = 7;

/** One seg of the episode. */
export interface Seg {
	readonly id: string;
	/** Its take object's id, or null when the episode holds none for the seg. */
	readonly take: string | null;
	/** Its take's video (a webview address), or null before one is shot. */
	readonly src: string | null;
	/** What the take was made with (its receipt, versionDetail.ts), or null. */
	readonly request: CanvasDetail | null;
	/** The take's prompt.md, which the person and the agent edit, or null without one. */
	readonly prompt: string | null;
	/** Its badge in the strip: what a take not shot yet says (canvasProtocol.ts notMadeText), empty once shot. */
	readonly badge: string;
	/** Its tile's picture: the take's video, else its first keyframe's picture (webview addresses), else null. */
	readonly poster: Poster | null;
}

export interface Poster {
	readonly media: 'video' | 'image';
	readonly src: string;
}

export interface SegEditorModel {
	readonly episode: string;
	readonly segs: readonly Seg[];
	/** The episode's cut, its video (a webview address), or null before one is made. */
	readonly cut: { readonly src: string } | null;
}

export type ToSegEditor =
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'model'; readonly model: SegEditorModel }
	/** Choose this seg: the canvas's "Open in Seg Editor" on one of its cards. */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'show'; readonly seg: string }
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'error'; readonly episode: string; readonly message: string };

export type FromSegEditor =
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'ready' }
	/** Generate (`again` false) or Regenerate (true): put the seg's shoot request in its episode's session's input for the person to send. */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'generate'; readonly seg: string; readonly again: boolean }
	/** The toggle: show this episode's canvas (section 12c, the episode's two views of one model). */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'canvas' }
	/** A reference of the request was clicked: show the card of the stage its file is. */
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'go'; readonly stageId: string }
	| { readonly v: typeof SEG_PROTOCOL; readonly type: 'failed'; readonly message: string };

/** A message from the webview, or undefined when it is not one of ours. */
export function readFromSegEditor(value: unknown): FromSegEditor | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const message = value as { v?: unknown; type?: unknown; message?: unknown; stageId?: unknown; seg?: unknown; again?: unknown };
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
	if (message.type === 'failed' && typeof message.message === 'string') {
		return { v: SEG_PROTOCOL, type: 'failed', message: message.message };
	}
	return undefined;
}
