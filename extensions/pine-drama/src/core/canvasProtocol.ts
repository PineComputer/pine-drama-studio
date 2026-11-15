// The messages between the extension and the episode canvas webview: one typed, versioned protocol, defined once
// here. No vscode import, no DOM.

import { isPath, readEntryAction, type EntryAction } from './galleryProtocol';
import { FAILED_MESSAGE_MAX } from './tuning';

export const CANVAS_PROTOCOL = 1;

/** Who a history commit is by, in the person's words (doc/protocol.md 2.1): the Versions view's and the strip's. */
export function madeBy(author: string): string {
	return author === 'pine-computer' ? 'by the Pine Computer' : author === 'person' ? 'by you' : author === 'client-found-changes-on-disk' ? 'found on disk' : author;
}

/** A commit's time as the Versions view and the strip show it: "2026-11-12 10:05". */
export const shortDate = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

/**
 * What an object with nothing shown yet says, the one wording for the canvas card, the seg editor's badge and the tree:
 * being made while a paid call for it is under way (project.ts makingNow), else not shot yet for a take or a cut, not
 * drawn yet for the rest.
 */
export function notMadeText(type: string, makingNow: boolean): string {
	return makingNow ? 'Being made' : type === 'take' || type === 'cut' ? 'Not shot yet' : 'Not drawn yet';
}

/** The global assets canvas's key, in place of an episode (the assets canvas). */
export const ASSETS_CANVAS = 'assets';

/** An assets card's names: its asset's and its node's own ("Base" for the asset's own card, a variant's record name otherwise). */
export interface NodeName {
	readonly asset: string;
	readonly node: string;
}

export interface CanvasCard {
	readonly id: string;
	/** Its object type (doc/protocol.md, section 5.1). */
	readonly kind: string;
	readonly label: string;
	readonly section: string;
	/** Its column in the pipeline's order (lineage.ts TYPES), which orders the cards in a group. */
	readonly column: number;
	/** Its shown file, project-relative (object.json `shown_file`), or null for a planned, empty card. */
	readonly file: string | null;
	/** What the file is: an image or video the webview loads, a text, or no file. */
	readonly media: 'image' | 'video' | 'text' | 'none';
	/** A webview URI of the file, for an image or video. */
	readonly src: string | null;
	/** Its object.json names the file, but it was not found when the canvas was sent. */
	readonly missing: boolean;
	/**
	 * On the assets canvas, the episodes its asset's record says it appears in (an empty list when it says none); null on
	 * an episode's canvas, whose cards show their version line instead (assetsCanvas.ts).
	 */
	readonly appearsIn: readonly string[] | null;
	/** Its segment within its episode, or null. */
	readonly segment: string | null;
	/** A paid call for it is under way (project.ts makingNow). */
	readonly makingNow: boolean;
	/** On the assets canvas, its asset's name and its node's own (assetsCanvas.ts), which its box names; null otherwise. */
	readonly name: NodeName | null;
}

export interface Point {
	readonly x: number;
	readonly y: number;
}

export interface Size {
	readonly w: number;
	readonly h: number;
}

/**
 * The person's arrangement of one episode's canvas, by node id: a stage's id for a card (relative to its frame),
 * `frame:<section>` for a frame. UI state, kept by the extension in workbench state (Semantic Views handoff,
 * 02-ENGINEERING-CONTRACT, "UI state"), never in the project.
 */
export type CanvasLayout = Readonly<Record<string, Point>>;

/**
 * Where the person last left a canvas: the board's point at the middle of the pane (x, y) and the zoom. Not React
 * Flow's transform, which holds for one pane size only: restored in a narrower split, a transform can leave every card
 * off screen, while what was in the middle stays in the middle. UI state per profile like CanvasLayout: a canvas opens
 * where it was left, as tldraw restores each page's camera and Code-OSS an editor's view state
 * (workbench.editor.restoreViewState).
 */
export interface CanvasViewport {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
}

export type ToCanvas =
	| {
		readonly v: typeof CANVAS_PROTOCOL; readonly type: 'lineage'; readonly episode: string;
		/** drama-cli's group titles in drama-cli's order (lineage `sections`), those with a card. */
		readonly sections: readonly string[];
		readonly cards: readonly CanvasCard[];
		readonly links: readonly { readonly from: string; readonly to: string }[];
		readonly layout: CanvasLayout;
		/** Each group's title by its section key, on the assets canvas (an asset's name); null where the key is the title. */
		readonly titles: Readonly<Record<string, string>> | null;
		/** A card to centre and select once the cards are drawn: the asset card the person clicked (the assets canvas). */
		readonly focus: string | null;
		/** The view the person last left this canvas at, or null: it then opens by openingViewport. */
		readonly viewport: CanvasViewport | null;
	}
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'error'; readonly episode: string; readonly message: string }
	/**
	 * A board command from a keybinding scoped to the focused canvas (package.json `keybindings`, when
	 * `activeWebviewPanelId == 'pineDrama.episodeCanvas'`): React Flow has no select-all, and the workbench's own zoom
	 * commands zoom the whole window (canvas-scope.md, review finding 1).
	 */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'command'; readonly name: CanvasCommand }
	/** What the clicked card's shown file was made with (its receipt, versionDetail.ts), for the detail panel; `error` when it could not be read. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'detail'; readonly stageId: string; readonly detail: CanvasDetail | null; readonly error: string | null;
		/** An asset's card: what the record panel edits; null elsewhere. */
		readonly record?: CanvasRecord | null;
		/** The box's prompt; null for an object with none to edit. */
		readonly prompt?: CanvasPrompt | null;
		/** Its shown file's earlier results and the one in use, for Use (versionDetail.ts pictureHistory); null with none. */
		readonly picture?: CanvasPicture | null;
		/** What its next draw request sends, Image 1..N (versionDetail.ts nextDrawRequest): the composer's references. */
		readonly nextDraw?: readonly MadeFrom[] }
	/** A record panel's action ended (cardActions.ts): its failure, or `unchanged` when it wrote nothing (unchangedLine). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'actionEnded'; readonly key: string; readonly error: string | null; readonly unchanged: string | null };

/** A card's picture history as the composer's strip shows it ("The record panel's picture versions"). */
export interface CanvasPicture {
	readonly object: string;
	/** Newest first, one per result of the shown file (projectHistory.ts listHistoryOfShownFile); Main is the one shown. */
	readonly versions: readonly {
		readonly commit: string;
		/** When and by whom (madeBy, shortDate). */
		readonly label: string;
		readonly main: boolean;
		readonly src: string;
		/** Each result's own (versionDetail.ts mediaOf): an object can turn from a picture into a video. */
		readonly media: 'image' | 'video' | 'text';
	}[];
}

/** The box's one text: the object's prompt.md, which the person and the agent edit; null while there is none. */
export interface CanvasPrompt {
	readonly object: string;
	readonly text: string | null;
}

/** An asset or variant as the record panel shows and edits it. */
export interface CanvasRecord {
	/** Its description.md, which the person and the agent edit (doc/protocol.md 2.2). */
	readonly description: string;
}

/** A file the shown file was made from: its object's name, its picture when it is one, and its card when on the board. */
export interface MadeFrom {
	readonly label: string;
	readonly src: string | null;
	readonly stageId: string | null;
	/** Its "Image N" in the prompt, by the order its receipt says it was sent (versionDetail.ts receiptDetail). */
	readonly n?: number;
}

/**
 * What a shown file was made with, as the panel shows it (core/versionDetail.ts): its receipt's prompt, when it was
 * finished, and the files it was sent, in their order: the pictures, then the text ones by name.
 */
export interface CanvasDetail {
	readonly prompt: string | null;
	readonly madeAt: string;
	readonly pictures: readonly MadeFrom[];
	readonly madeFrom: readonly MadeFrom[];
}

export const CANVAS_COMMANDS = ['zoomIn', 'zoomOut', 'fit', 'selectAll'] as const;
export type CanvasCommand = typeof CANVAS_COMMANDS[number];

export type FromCanvas =
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'ready' }
	/** One card was clicked: the Versions view follows it; nothing opens. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'inspect'; readonly stageId: string }
	/** No card is picked any more: going back to this canvas leaves Versions empty (auto-reveal.md, section 7). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'unpick' }
	/** The person moved cards or frames, laid the board out again, or undid or redid one of those: every node's position. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'layout'; readonly episode: string; readonly positions: CanvasLayout }
	/** The board stopped moving (React Flow's onMoveEnd): the view to open at next time. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'viewport'; readonly episode: string; readonly viewport: CanvasViewport }
	/** The episode's seg editor, at a seg when a seg's card asked for it (production-assets.md, section 12c: the episode's two views). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'segEditor'; readonly seg: string | null }
	/** Something failed inside the webview (a script error, a blocked load): logged, never hidden (coding rule 1). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'failed'; readonly message: string }
	/** A panel's card action (cardActions.ts), the asset grid's own. */
	| ({ readonly v: typeof CANVAS_PROTOCOL; readonly type: 'entry'; readonly stageId: string } & EntryAction)
	/** A box's Generate: a request for its picture or take, put in the open chat's input for the person to send. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'generate'; readonly stageId: string };

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** A message from the webview, checked: the webview is a separate page, so its messages are data. */
export function readFromCanvas(value: unknown): FromCanvas | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const message = value as Record<string, unknown>;
	if (message.v !== CANVAS_PROTOCOL) {
		return undefined;
	}
	if (message.type === 'ready' || message.type === 'unpick') {
		return { v: CANVAS_PROTOCOL, type: message.type };
	}
	if (message.type === 'inspect' && typeof message.stageId === 'string') {
		return { v: CANVAS_PROTOCOL, type: 'inspect', stageId: message.stageId };
	}
	if (message.type === 'layout' && typeof message.episode === 'string' && isLayout(message.positions)) {
		return { v: CANVAS_PROTOCOL, type: 'layout', episode: message.episode, positions: message.positions };
	}
	if (message.type === 'viewport' && typeof message.episode === 'string' && isViewport(message.viewport)) {
		return { v: CANVAS_PROTOCOL, type: 'viewport', episode: message.episode, viewport: { x: message.viewport.x, y: message.viewport.y, zoom: message.viewport.zoom } };
	}
	if (message.type === 'segEditor' && nullableString(message.seg)) {
		return { v: CANVAS_PROTOCOL, type: 'segEditor', seg: message.seg };
	}
	if (message.type === 'failed' && typeof message.message === 'string') {
		return { v: CANVAS_PROTOCOL, type: 'failed', message: message.message.slice(0, FAILED_MESSAGE_MAX) };
	}
	if (message.type === 'generate' && isPath(message.stageId)) {
		return { v: CANVAS_PROTOCOL, type: 'generate', stageId: message.stageId };
	}
	if (message.type === 'entry' && isPath(message.stageId)) {
		const action = readEntryAction(message);
		return action && { v: CANVAS_PROTOCOL, type: 'entry', stageId: message.stageId, ...action };
	}
	return undefined;
}

function isViewport(value: unknown): value is CanvasViewport {
	const v = value as CanvasViewport | null;
	return typeof v === 'object' && v !== null && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0;
}

function isLayout(value: unknown): value is CanvasLayout {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every(p => typeof p === 'object' && p !== null && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y));
}
