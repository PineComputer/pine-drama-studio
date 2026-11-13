// The messages between the extension and the episode canvas webview: one typed, versioned protocol, defined once
// here. No vscode import, no DOM.

import { isPath, readEntryAction, type EntryAction } from './galleryProtocol';

export const CANVAS_PROTOCOL = 1;

/** The global assets canvas's key, in place of an episode (the assets canvas). */
export const ASSETS_CANVAS = 'assets';

/**
 * When the canvas's readiness and edges were observed: the newest snapshot it read, or null before
 * its scope's first return. Versions and choices are always current; only the snapshot's fields can be old (protocol 5.3).
 */
export type CanvasOrigin = { readonly kind: 'snapshot'; readonly observedAt: string | null };

/** One stage of the episode as its card shows it: drama-cli's facts and the file of the version it shows. */
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
	/** The working version the card shows, or null when drama-cli has none (not generated). */
	readonly version: string | null;
	readonly accepted: string | null;
	/** Why the next steps cannot use it yet, in the snapshot's words (`why`), else null. */
	readonly notUsable: string | null;
	/** Project-relative file of `version` the card shows (lineage `shows`), or null. */
	readonly file: string | null;
	/** What the file is: an image or video the webview loads, a text, or no file. */
	readonly media: 'image' | 'video' | 'text' | 'none';
	/** A webview URI of the file, for an image or video. */
	readonly src: string | null;
	/** The file is named by drama-cli but was not found when the canvas was sent. */
	readonly missing: boolean;
	/**
	 * On the assets canvas, the episodes its asset's record says it appears in (an empty list when it says none); null on
	 * an episode's canvas, whose cards show their version line instead (assetsCanvas.ts).
	 */
	readonly appearsIn: readonly string[] | null;
	/** Its segment within its episode, or null. */
	readonly segment: string | null;
	/** On the assets canvas, its asset's name and its node's own (assetsCanvas.ts), which its box names; null otherwise. */
	readonly name: NodeName | null;
	/** The person's choice the Computer has not seen yet: the mark's tooltip, or null. */
	readonly outgoing: string | null;
	/** An add a running task carries: its line, or null; its edit and remove wait. */
	readonly inFlight: string | null;
	/** The problem the scope's last return named for it, or null. */
	readonly problem: { readonly message: string; readonly action: string | null } | null;
	/** A stage its episode plans and has not made yet (lineage `planned`): its card stands in its final place, says Planned. */
	readonly planned?: boolean;
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

export type ToCanvas =
	| {
		readonly v: typeof CANVAS_PROTOCOL; readonly type: 'lineage'; readonly episode: string; readonly origin: CanvasOrigin;
		/** drama-cli's group titles in drama-cli's order (lineage `sections`), those with a card. */
		readonly sections: readonly string[];
		readonly cards: readonly CanvasCard[];
		readonly links: readonly { readonly from: string; readonly to: string }[];
		readonly layout: CanvasLayout;
		/** Each group's title by its section key, on the assets canvas (an asset's name); null where the key is the title. */
		readonly titles: Readonly<Record<string, string>> | null;
		/** A card to centre and select once the cards are drawn: the asset card the person clicked (the assets canvas). */
		readonly focus: string | null;
	}
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'error'; readonly episode: string; readonly message: string; readonly code: string | null; readonly action: string | null }
	/**
	 * A board command from a keybinding scoped to the focused canvas (package.json `keybindings`, when
	 * `activeWebviewPanelId == 'pineDrama.episodeCanvas'`): React Flow has no select-all, and the workbench's own zoom
	 * commands zoom the whole window (canvas-scope.md, review finding 1).
	 */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'command'; readonly name: CanvasCommand }
	/** What the clicked card's version was made with (versionDetail.ts), for the read-only detail panel; `error` when its records could not be read. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'detail'; readonly stageId: string; readonly version: string | null; readonly detail: CanvasDetail | null; readonly error: string | null;
		/** An asset's card: what the record panel edits; null elsewhere. */
		readonly record?: CanvasRecord | null;
		/** An asset card's picture versions; null with none. */
		readonly picture?: CanvasPicture | null;
		/** The box's prompt; null for an object with none to edit. */
		readonly prompt?: CanvasPrompt | null }
	/** A record panel's action ended (cardActions.ts): its failure, or `unchanged` when it wrote nothing (unchangedLine). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'actionEnded'; readonly key: string; readonly error: string | null; readonly unchanged: string | null };

/** An asset card's picture versions as the record panel shows them ("The record panel's picture versions"). */
export interface CanvasPicture {
	readonly object: string;
	readonly current: string | null;
	readonly accepted: string | null;
	readonly usable: boolean;
	readonly why: string | null;
	/** The strip: the versions the person has not discarded, oldest first, each with its picture for the thumbnail. */
	readonly versions: readonly { readonly version: string; /** The person's own import (protocol 2.1). */ readonly own: boolean; readonly accepted: boolean; readonly src: string | null }[];
}

/** The box's one text: the person's prompt where they set one, else the agent's next one; null while there is none. */
export interface CanvasPrompt {
	readonly object: string;
	readonly text: string | null;
	readonly byPerson: boolean;
}

/** An asset or variant as the record panel shows and edits it. */
export interface CanvasRecord {
	readonly object: string;
	readonly type: string;
	/** The person's description where set, else the agent's. */
	readonly description: string;
	/** What a variant derives from (`variant_of`), as an object id the canvas centres; null for an asset. */
	readonly from: string | null;
}

/**
 * What a version was made with, as the panel shows it (core/versionDetail.ts): its prompt, when it was finished, and each
 * version it was made from, numbered in order, with its picture and its card when on the board.
 */
export interface CanvasDetail {
	readonly prompt: string | null;
	readonly madeAt: string;
	readonly references: readonly { readonly n: number; readonly file: string | null; readonly raw: string; readonly src: string | null; readonly stageId: string | null }[];
}

export const CANVAS_COMMANDS = ['zoomIn', 'zoomOut', 'fit', 'selectAll'] as const;
export type CanvasCommand = typeof CANVAS_COMMANDS[number];

/** A card's identity as shown: the stage, the version on screen and its file, so an action never lands on another version. */
export interface Shown {
	readonly stageId: string;
	readonly version: string | null;
	readonly file: string | null;
}

export type FromCanvas =
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'ready' }
	/** One card was clicked: the Versions view follows it; nothing opens. */
	| ({ readonly v: typeof CANVAS_PROTOCOL; readonly type: 'inspect' } & Shown)
	/** No card is picked any more: going back to this canvas leaves Versions empty (auto-reveal.md, section 7). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'unpick' }
	/** A card was double-clicked: open exactly the file it shows. */
	| ({ readonly v: typeof CANVAS_PROTOCOL; readonly type: 'open' } & Shown)
	/** The person moved cards or frames, laid the board out again, or undid or redid one of those: every node's position. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'layout'; readonly episode: string; readonly positions: CanvasLayout }
	/** The episode's seg editor, at a seg when a seg's card asked for it (production-assets.md, section 12c: the episode's two views). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'segEditor'; readonly seg: string | null }
	/** Something failed inside the webview (a script error, a blocked load): logged, never hidden (coding rule 1). */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'failed'; readonly message: string }
	/** A panel's card action (cardActions.ts), the asset grid's own. */
	| ({ readonly v: typeof CANVAS_PROTOCOL; readonly type: 'entry'; readonly stageId: string } & EntryAction)
	/** A box's Generate: a request for its picture or take, put in the Chat's input for the person to send. */
	| { readonly v: typeof CANVAS_PROTOCOL; readonly type: 'generate'; readonly stageId: string };

/** Whether a double-click on a card opens its file: a planned card is not made yet. */
export function opensFile(card: Pick<CanvasCard, 'planned'>): boolean {
	return !card.planned;
}

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
	if ((message.type === 'open' || message.type === 'inspect') && typeof message.stageId === 'string' && nullableString(message.version) && nullableString(message.file)) {
		return { v: CANVAS_PROTOCOL, type: message.type, stageId: message.stageId, version: message.version, file: message.file };
	}
	if (message.type === 'layout' && typeof message.episode === 'string' && isLayout(message.positions)) {
		return { v: CANVAS_PROTOCOL, type: 'layout', episode: message.episode, positions: message.positions };
	}
	if (message.type === 'segEditor' && nullableString(message.seg)) {
		return { v: CANVAS_PROTOCOL, type: 'segEditor', seg: message.seg };
	}
	if (message.type === 'failed' && typeof message.message === 'string') {
		return { v: CANVAS_PROTOCOL, type: 'failed', message: message.message.slice(0, 2000) };
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

function isLayout(value: unknown): value is CanvasLayout {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every(p => typeof p === 'object' && p !== null && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y));
}
