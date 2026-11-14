// The messages between the extension and a gallery or detail page (AGENTS.md). No vscode import.


/**
 * The longest name and description a card's draft sends (Create New, + Variant): the draft fields stop there
 * (maxLength), so a message past them is never sent and dropped unanswered.
 */
export const NAME_MAX = 200;
export const TEXT_MAX = 4000;

export const GALLERY_PROTOCOL = 2;

export type Collection = 'characters' | 'scenes' | 'props';

/** A scene's setting (doc/protocol.md, section 3.1: an add's `setting`). */
export type Setting = 'interior' | 'exterior';

/** One tile: an object and the version it shows (doc/protocol.md, section 3.2). */
export interface GalleryTile {
	/** The object's id (an add's own id until a task makes it an object). */
	readonly stagePath: string;
	readonly name: string;
	readonly note: string | null;
	/** The version the tile shows: the current one. */
	readonly version: string | null;
	readonly accepted: string | null;
	/** The picture of the shown version, project-relative, or null. */
	readonly file: string | null;
	/** The text the card's actions change: the person's description where set, else the agent's. */
	readonly description: string;
	/** The person's choice the Computer has not seen yet: the mark's tooltip, or null. */
	readonly outgoing: string | null;
	/** An add a running task carries: its line, or null; its edit and remove wait. */
	readonly inFlight: string | null;
	/** The problem the scope's last return named for it, or null. */
	readonly problem: { readonly message: string; readonly action: string | null } | null;
	/** The asset grid: how many of the asset's objects have a version, and how many are still to be made or used (assetStatus.ts). */
	readonly visuals?: { readonly made: number; readonly needed: number };
	readonly actions: CardActions;
}

export interface GallerySection {
	readonly title: string;
	readonly tiles: readonly GalleryTile[];
	/** The asset grid: the type its last card, Create New, adds. */
	readonly add?: AddType;
}

/** What Create New makes on a grid (doc/protocol.md, section 3.1: an add's `type`). */
export type AddType = 'character' | 'scene' | 'prop';

/** A tile as the page shows it: the gallery's tile and a webview URI of its picture. */
export interface PageTile extends GalleryTile {
	readonly src: string | null;
}

export type ToGallery =
	/** A page; an asset grid's names its kind, which the cards' icon and the editor's state follow. */
	| { readonly v: typeof GALLERY_PROTOCOL; readonly type: 'page'; readonly title: string; readonly kind?: Collection; readonly note: string | null; readonly sections: readonly { readonly title: string; readonly tiles: readonly PageTile[]; readonly add?: AddType }[] }
	| { readonly v: typeof GALLERY_PROTOCOL; readonly type: 'error'; readonly message: string }
	/** A card action ended (C1): the card's busy line clears, and shows the failure, or `unchanged` when it wrote nothing (unchangedLine). */
	| { readonly v: typeof GALLERY_PROTOCOL; readonly type: 'actionEnded'; readonly key: string; readonly error: string | null; readonly unchanged: string | null };

/** A card action, by the protocol's object ids (project-relative paths); core/entryActions.ts runs it. */
export type CardRequest =
	| { readonly action: 'choose'; readonly object: string; readonly version: string }
	| { readonly action: 'discard'; readonly object: string; readonly version: string }
	/** `text`: the new description, written in place; absent to ask the person, starting from `description`. */
	| { readonly action: 'describe'; readonly object: string; readonly description: string; readonly text?: string }
	| { readonly action: 'prompt'; readonly object: string; readonly text: string }
	| { readonly action: 'remove'; readonly object: string }
	| { readonly action: 'add'; readonly type: 'character' | 'scene' | 'prop' | 'variant'; readonly name: string; readonly text: string; readonly from?: string; readonly setting?: Setting }
	/** An add no task has made yet (section 3.1): removing it deletes the entry. */
	| { readonly action: 'removeAdd'; readonly id: string }
	/** `file`: the person's picture on disk; null to ask for one. */
	| { readonly action: 'import'; readonly object: string; readonly file: string | null };

/** What a card, tile or row offers for its object (project.ts actionsOf): one rule for every view. */
export interface CardActions {
	/** Import, describe, + Variant and the prompt: an asset or variant a task has made. */
	readonly edit: boolean;
	/** Delete: removes an asset or variant, or withdraws an add; null while a task carries the add, and for any other object. */
	readonly delete: CardRequest | null;
	/** Reveal in Files and Copy Path: only an object with a version has a folder. */
	readonly reveal: boolean;
}

/**
 * A card action as a page sends it: the person's choice by object id (core/entryActions.ts,
 * CardRequest), or a picture dropped on a card, with its bytes. `key` names the card or section that shows its outcome.
 */
export interface EntryAction {
	readonly key: string;
	readonly request: CardRequest | { readonly action: 'importDropped'; readonly object: string; readonly name: string; readonly bytes: Uint8Array };
}

export type FromGallery =
	| { readonly v: typeof GALLERY_PROTOCOL; readonly type: 'ready' }
	/** An asset's card was clicked: the assets canvas opens on it (galleries.ts). */
	| { readonly v: typeof GALLERY_PROTOCOL; readonly type: 'open'; readonly stagePath: string }
	| { readonly v: typeof GALLERY_PROTOCOL; readonly type: 'failed'; readonly message: string }
	| ({ readonly v: typeof GALLERY_PROTOCOL; readonly type: 'entry' } & EntryAction);


/** A message from the page, checked: the webview is a separate page, so its messages are data. */
export function readFromGallery(value: unknown): FromGallery | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const m = value as Record<string, unknown>;
	if (m.v !== GALLERY_PROTOCOL) {
		return undefined;
	}
	if (m.type === 'ready') {
		return { v: GALLERY_PROTOCOL, type: 'ready' };
	}
	if (m.type === 'open' && isPath(m.stagePath)) {
		return { v: GALLERY_PROTOCOL, type: 'open', stagePath: m.stagePath };
	}
	if (m.type === 'entry') {
		const action = readEntryAction(m);
		return action && { v: GALLERY_PROTOCOL, type: 'entry', ...action };
	}
	if (m.type === 'failed' && typeof m.message === 'string') {
		return { v: GALLERY_PROTOCOL, type: 'failed', message: m.message.slice(0, 2000) };
	}
	return undefined;
}

/**
 * A grid card's line under its name, in Pippit's words ("2 visuals needed", 750.png): what is still to be set, or nothing
 * when none is, the same kind of line on every card (the person's 751.png).
 */
export function visualsLine(visuals: { readonly needed: number }): string | null {
	return visuals.needed ? `${visuals.needed} ${visuals.needed === 1 ? 'visual' : 'visuals'} needed` : null;
}

/** A project-relative path as the protocol writes one (doc/protocol.md, section 1): no empty, `.`-led or `..` segment. */
export function isPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.split('/').every(part => part !== '' && !part.startsWith('.') && !/[\\\u0000-\u001f]/.test(part));
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max;

/**
 * A card action from a page, checked: the asset grid's cards and the canvas's panels send the same actions
 * (cardActions.ts). The page is a separate page, so its message is data.
 */
export function readEntryAction(message: Record<string, unknown>): EntryAction | undefined {
	const m = message.request as Record<string, unknown> | null;
	if (typeof message.key !== 'string' || typeof m !== 'object' || m === null) {
		return undefined;
	}
	const request = readRequest(m);
	return request && { key: message.key, request };
}

function readRequest(m: Record<string, unknown>): EntryAction['request'] | undefined {
	switch (m.action) {
		case 'choose': case 'discard':
			return isPath(m.object) && isPath(m.version) && !m.version.includes('/') ? { action: m.action, object: m.object, version: m.version } : undefined;
		case 'describe':
			return isPath(m.object) && typeof m.description === 'string' && (m.text === undefined || typeof m.text === 'string')
				? { action: 'describe', object: m.object, description: m.description, ...(typeof m.text === 'string' ? { text: m.text } : {}) } : undefined;
		case 'prompt':
			return isPath(m.object) && text(m.text, TEXT_MAX) ? { action: 'prompt', object: m.object, text: m.text } : undefined;
		case 'remove':
			return isPath(m.object) ? { action: 'remove', object: m.object } : undefined;
		case 'add':
			return (m.type === 'character' || m.type === 'scene' || m.type === 'prop' || m.type === 'variant') && text(m.name, NAME_MAX) && text(m.text, TEXT_MAX)
				&& (m.from === undefined || isPath(m.from)) && (m.setting === undefined || m.setting === 'interior' || m.setting === 'exterior')
				? { action: 'add', type: m.type, name: m.name.trim(), text: m.text.trim(), ...(isPath(m.from) ? { from: m.from } : {}), ...(m.setting ? { setting: m.setting as Setting } : {}) } : undefined;
		case 'removeAdd':
			return typeof m.id === 'string' ? { action: 'removeAdd', id: m.id } : undefined;
		case 'import':
			return isPath(m.object) ? { action: 'import', object: m.object, file: null } : undefined;
		case 'importDropped':
			return isPath(m.object) && typeof m.name === 'string' && m.name !== '' && !/[\\/]/.test(m.name) && m.bytes instanceof Uint8Array
				? { action: 'importDropped', object: m.object, name: m.name, bytes: m.bytes } : undefined;
		default:
			return undefined;
	}
}
