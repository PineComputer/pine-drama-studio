// Where an episode's cards sit on its canvas. drama-cli owns which cards there are, their groups, the groups' order
// and the order inside a group (its `layout`, four to a row). Where the groups stand is the Studio's:
// the segments side by side, the references in a band above. The pixels are the Studio's too: a card
// is as tall as its own picture at a fixed width, and a row as tall as its tallest card (as open-pinedrama does), which
// drama-cli's fixed 300 x 340 cells cannot hold. The person's arrangement wins over all of it. No vscode import, no DOM.

import potpack from 'potpack';
import type { CanvasCard, CanvasLayout, Point, Size } from './canvasProtocol';

export const CARD_W = 300; // drama-cli's WIDTH (export.py:29)
const DEFAULT_MEDIA: Size = { w: 300, h: 290 }; // until the file's own size is known
const GAP = 60; // drama-cli's GAP
const PAD = 20; // drama-cli's PAD
const TITLE = 50; // drama-cli's TITLE
const SHARED = ['Characters', 'Locations', 'Props'];

/** A card's footer under its picture, the same on both canvases: its name, then its state, sized to be read zoomed out. */
export const FOOT_H = 84;

/** Sections on the board: drama-cli's text stages stay off it (canvas-scope #7). */
export const onBoard = (card: CanvasCard) => card.media !== 'text' && card.section !== 'Text';

/** A card's size, the same on both canvases: the fixed width, its picture's height at that width, and its footer. */
export function cardSize(media: Size | undefined): Size {
	const m = media && media.w > 0 && media.h > 0 ? media : DEFAULT_MEDIA;
	return { w: CARD_W, h: Math.round((CARD_W * m.h) / m.w) + FOOT_H };
}

const frameId = (title: string) => `frame:${title}`;
const order = (a: CanvasCard, b: CanvasCard) => a.column - b.column || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A group packed on the board: its frame's key and its size. */
interface Group { readonly key: string; readonly w: number; readonly h: number }

/**
 * Boxes packed in rows, region by region: in a region
 * the boxes go left to right in their order and wrap at the board's width, each row as tall as its tallest box, the
 * reading order of Eclipse ELK's rectangle packing ("The given order of the boxes is always preserved and the main
 * reading direction of the boxes is left to right"), without its compaction. The width is the one that makes the whole
 * board closest to square, so it fits the view when it opens: every width from the widest box up to all in one row is
 * tried. Returns each box's corner.
 */
function packClosestToSquare(regions: readonly (readonly Group[])[], gap: number): Map<string, Point> {
	const arrange = (limit: number) => {
		const at = new Map<string, Point>();
		let y = 0;
		let width = 0;
		for (const region of regions) {
			let x = 0;
			let rowHeight = 0;
			for (const box of region) {
				if (x > 0 && x + box.w > limit) {
					y += rowHeight + gap;
					x = 0;
					rowHeight = 0;
				}
				at.set(box.key, { x, y });
				width = Math.max(width, x + box.w);
				x += box.w + gap;
				rowHeight = Math.max(rowHeight, box.h);
			}
			y += rowHeight + GAP; // a wider gap between the regions
		}
		return { at, width, height: y - GAP };
	};
	const boxes = regions.flat();
	const widest = Math.max(0, ...boxes.map(b => b.w));
	const total = boxes.reduce((sum, b) => sum + b.w + gap, 0);
	let best = arrange(Math.max(widest, total));
	let bestScore = Infinity;
	for (let limit = widest; limit <= total; limit += Math.max(1, Math.round(widest / 2))) {
		const packed = arrange(limit);
		const score = Math.abs(Math.log(packed.width / packed.height));
		if (score < bestScore) { bestScore = score; best = packed; }
	}
	return best.at;
}

/** Cards' places in a frame, relative to its corner, and the frame's size. */
interface Grid { readonly at: Map<string, Point>; readonly w: number; readonly h: number }

/** `cards` in order, left to right in rows of `columns` under the frame's title, each row as tall as its tallest card. */
function gridLayout(cards: readonly CanvasCard[], columns: number, size: (id: string) => Size): Grid {
	const at = new Map<string, Point>();
	let y = TITLE + PAD;
	for (let start = 0; start < cards.length; start += columns) {
		const row = cards.slice(start, start + columns);
		row.forEach((card, i) => at.set(card.id, { x: PAD + i * (CARD_W + GAP), y }));
		y += Math.max(...row.map(c => size(c.id).h)) + GAP;
	}
	return { at, w: 2 * PAD + Math.min(columns, cards.length) * (CARD_W + GAP) - GAP, h: y - GAP + PAD };
}

/**
 * The default arrangement (the first time, and on Lay out again): frames at absolute places, each card relative to its
 * frame. `sizes` are the cards' sizes (cardSize of each picture as loaded). A frame's size is not decided here: the
 * canvas draws it around its cards wherever they stand (canvas.tsx, nodesFor). Inside a frame nothing is ours:
 * drama-cli's order, four cards to a row (export.py `layout`). The frames are packed (packClosestToSquare, the
 * assets canvas's rule): the Characters, Locations and Props frames in a band on top, then each segment's frame as a
 * column, left to right in segment order, the order the episode plays (ShotGrid's Shots page, "sort by the Cut Order
 * field"), each cut's after the last segment (sections 2a and 2b).
 */
export function layoutEpisode(sections: readonly string[], cards: readonly CanvasCard[], sizes: Readonly<Record<string, Size>>): { positions: Record<string, Point> } {
	const positions: Record<string, Point> = {};
	const size = (id: string) => sizes[id] ?? cardSize(undefined);
	const frame = (title: string): Group | undefined => {
		const own = cards.filter(c => c.section === title && onBoard(c)).sort(order);
		if (!own.length) {
			return undefined;
		}
		const grid = gridLayout(own, 4, size);
		for (const [id, at] of grid.at) { positions[id] = at; }
		return { key: title, w: grid.w, h: grid.h };
	};
	const shared = SHARED.filter(t => sections.includes(t));
	const cuts = sections.filter(t => t.endsWith(' cut')).sort();
	const segments = sections.filter(t => !SHARED.includes(t) && t !== 'Text' && !t.endsWith(' cut')).sort();
	const regions = [shared, [...segments, ...cuts]].map(titles => titles.map(frame).filter((g): g is Group => !!g)).filter(r => r.length);
	const at = packClosestToSquare(regions, GAP);
	for (const [key, corner] of at) { positions[frameId(key)] = corner; }
	return { positions };
}

/** The assets canvas's key in place of an episode (lineage.ts ASSETS_CANVAS; this file imports nothing of lineage). */
const ASSETS_CANVAS_KEY = 'assets';

/** The height of a region's heading on the assets canvas: characters, scenes, props. */
const HEADING = 70;

/** An asset's own card, not a variant's: on the assets board a group is keyed by its asset's id (assetsCanvas.ts). */
const isRoot = (c: CanvasCard) => c.id === c.section;

/**
 * An asset group's places, relative to its frame's corner, and the frame's size (gridLayout): the asset's own card
 * first, then its variants in drama-cli's order, in as many columns as rows (the square root of the count, rounded up).
 * A group of many looks stays a block, not one tall column.
 */
function groupLayout(own: readonly CanvasCard[], size: (id: string) => Size): Grid {
	const sorted = [...own].sort((a, b) => Number(isRoot(b)) - Number(isRoot(a)) || order(a, b));
	return gridLayout(sorted, Math.ceil(Math.sqrt(sorted.length)), size);
}

/** The assets canvas's region of each asset kind (doc/protocol.md 5.1, `type`). */
const REGION: Readonly<Record<string, string>> = { character: 'characters', scene: 'scenes', prop: 'props' };

/** The gap between two groups on the assets canvas. */
const GROUP_GAP = 24;

/**
 * The assets canvas's default arrangement: one frame per asset group (assetsCanvas.ts) with its cards in a grid
 * (groupLayout); the characters', scenes' and props' groups are three regions stacked top to bottom, each under its
 * heading (`heading:<kind>`), each packed into a near-square block by potpack, mapbox's rectangle packer ("packs 2D
 * rectangles into a near-square container", https://github.com/mapbox/potpack). Every asset is a frame, one with no
 * variant too. Frames and headings absolute, a card relative to its frame.
 */
export function layoutAssets(sections: readonly string[], cards: readonly CanvasCard[], sizes: Readonly<Record<string, Size>>): { positions: Record<string, Point> } {
	const size = (id: string) => sizes[id] ?? cardSize(undefined);
	const groups = sections.map(key => {
		const own = cards.filter(c => c.section === key && onBoard(c));
		// A group's region is its asset's kind, read from its cards, never from an id: an add's id is no folder path. A group
		// holding a place sits with the scenes, the prop it is inside included (assetsCanvas.ts).
		const region = REGION[own.some(c => c.kind === 'scene') ? 'scene' : own.find(c => c.id === key)?.kind ?? ''];
		return { key, region, own, grid: groupLayout(own, size) };
	}).filter(g => g.own.length);
	const positions: Record<string, Point> = {};
	let top = 0;
	for (const name of ['characters', 'scenes', 'props']) {
		const region = groups.filter(g => g.region === name);
		if (!region.length) { continue; }
		positions[`heading:${name}`] = { x: 0, y: top };
		// Each box carries the gap on its right and bottom, so packed boxes keep it between them.
		const boxes = region.map(g => ({ g, w: g.grid.w + GROUP_GAP, h: g.grid.h + GROUP_GAP, x: 0, y: 0 }));
		const packed = potpack(boxes);
		for (const { g, x, y } of boxes) {
			positions[frameId(g.key)] = { x, y: top + HEADING + y };
			for (const [id, at] of g.grid.at) { positions[id] = at; }
		}
		top += HEADING + packed.h + GAP;
	}
	return { positions };
}

/**
 * Where each node stands when the canvas draws a lineage (nothing on screen moves). A node on screen keeps its
 * place; one the person placed before keeps that; a node that is new to a board already arranged goes under the
 * lowest card of its own column in its frame (drama-cli's `column`, amended 2026-11-02), so it covers nothing; on a board
 * never arranged everything takes the default.
 */
export function positionsFor(defaults: CanvasLayout, saved: CanvasLayout, onScreen: CanvasLayout, cards: readonly CanvasCard[], sizes: Readonly<Record<string, Size>>, canvas?: string): Record<string, Point> {
	// The assets canvas is a drawing of the object model (DESIGN-2026-11-08): the board lays it out every time it is drawn
	// and keeps no arrangement. A kept one mixed two layouts once the model changed: places saved when every asset was a
	// lone card, read in the earlier groups as offsets in their frames.
	if (canvas === ASSETS_CANVAS_KEY) {
		return { ...defaults };
	}
	const known = { ...saved, ...onScreen };
	const arranged = Object.keys(known).length > 0;
	const out: Record<string, Point> = {};
	for (const [id, place] of Object.entries(defaults)) {
		if (known[id]) {
			out[id] = known[id];
		} else if (!arranged || id.startsWith('frame:') || id.startsWith('heading:')) {
			out[id] = place;
		}
	}
	for (const card of cards.filter(c => onBoard(c) && !out[c.id] && defaults[c.id])) {
		out[card.id] = newCardPlace(card, cards, out, sizes);
	}
	// A frame new to an arranged board covers nothing either: frames already there may have grown past their defaults (a
	// take goes right of its storyboards), so it steps right past any frame it would cover (2026-11-03: the cut's frame
	// covered seg01's take).
	if (arranged) {
		const frames = Object.keys(out).filter(id => id.startsWith('frame:'));
		for (const id of frames.filter(f => !known[f])) {
			for (let moved = true; moved;) {
				moved = false;
				const box = frameBox(id, cards, out, sizes);
				for (const other of frames.filter(f => f !== id)) {
					const at = frameBox(other, cards, out, sizes);
					if (box && at && box.x < at.x + at.w && at.x < box.x + box.w && box.y < at.y + at.h && at.y < box.y + box.h) {
						out[id] = { x: at.x + at.w + GAP, y: out[id].y };
						moved = true;
					}
				}
			}
		}
	}
	if (arranged) {
		stepAway(out, cards, sizes);
	}
	return out;
}

/**
 * On an arranged board, what a growing frame or card would cover steps away from it (the person's choice): a covered card steps down past the card above it in its frame; then a covered frame steps down past the frame
 * above it, keeping its x. Each is settled in the order it stands (top to bottom, then left to right) against those
 * already settled, so a frame that steps down and would cover the next one moves that one in turn: a reflow, as boxes
 * in normal flow follow one another down the page (CSS 2.1, section 9.4.1) and as drama-cli's own layout stacks its
 * groups by their heights (export.py:65-98). Nothing moves when nothing is covered.
 */
function stepAway(out: Record<string, Point>, cards: readonly CanvasCard[], sizes: Readonly<Record<string, Size>>): void {
	const of = (c: CanvasCard) => sizes[c.id] ?? cardSize(undefined);
	const inOrder = (a: Point, b: Point) => a.y - b.y || a.x - b.x;
	const frames = Object.keys(out).filter(id => id.startsWith('frame:'));
	for (const frame of frames) {
		const own = cards.filter(c => `frame:${c.section}` === frame && out[c.id]).sort((a, b) => inOrder(out[a.id], out[b.id]));
		const settled: CanvasCard[] = [];
		for (const card of own) {
			for (let moved = true; moved;) {
				moved = false;
				for (const above of settled) {
					if (covers({ ...out[card.id], ...of(card) }, { ...out[above.id], ...of(above) })) {
						out[card.id] = { x: out[card.id].x, y: out[above.id].y + of(above).h + GAP };
						moved = true;
					}
				}
			}
			settled.push(card);
		}
	}
	// A frame and its cards are what it draws: its own box and every card's, in board coordinates, a card dragged out past
	// the frame's edge included. A frame is covered when one of these meets one of a settled
	// frame's, never by the empty space between them, and steps down until none does.
	const settled: string[] = [];
	for (const frame of [...frames].sort((a, b) => inOrder(out[a], out[b]))) {
		for (let moved = true; moved;) {
			moved = false;
			const mine = groupBoxes(frame, cards, out, sizes);
			for (const above of settled) {
				const hit = groupBoxes(above, cards, out, sizes).flatMap(at => mine.filter(box => covers(box, at)).map(box => at.y + at.h + GAP - box.y));
				if (hit.length) {
					out[frame] = { x: out[frame].x, y: out[frame].y + Math.max(...hit) };
					moved = true;
					break;
				}
			}
		}
		settled.push(frame);
	}
}

type Box = { x: number; y: number; w: number; h: number };
const covers = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** What a frame draws on the board: its box (frameBox) and each of its cards' boxes at the frame's place plus their own. */
function groupBoxes(id: string, cards: readonly CanvasCard[], out: Readonly<Record<string, Point>>, sizes: Readonly<Record<string, Size>>): Box[] {
	const box = frameBox(id, cards, out, sizes);
	if (!box) { return []; }
	const own = cards.filter(c => `frame:${c.section}` === id && out[c.id]);
	return [box, ...own.map(c => ({ x: out[id].x + out[c.id].x, y: out[id].y + out[c.id].y, ...(sizes[c.id] ?? cardSize(undefined)) }))];
}

/**
 * Where a canvas's nodes stand, at full precision: rounding a frame's place and its cards' places each on its own could
 * move their sum by a pixel and make two things that touch look covered. React Flow takes
 * fractional positions as they are.
 */
export function layoutOf(nodes: readonly { id: string; position: Point }[]): Record<string, Point> {
	return Object.fromEntries(nodes.map(n => [n.id, { x: n.position.x, y: n.position.y }]));
}

/** A frame as the canvas draws it around its cards (canvas.tsx, nodesFor): from its place to its cards' far edge, plus 20. */
function frameBox(id: string, cards: readonly CanvasCard[], out: Readonly<Record<string, Point>>, sizes: Readonly<Record<string, Size>>): { x: number; y: number; w: number; h: number } | undefined {
	const own = cards.filter(c => `frame:${c.section}` === id && out[c.id]);
	if (!own.length || !out[id]) {
		return undefined;
	}
	const of = (c: CanvasCard) => sizes[c.id] ?? cardSize(undefined);
	return { ...out[id], w: Math.max(...own.map(c => out[c.id].x + of(c).w)) + 20, h: Math.max(...own.map(c => out[c.id].y + of(c).h)) + 20 };
}

/**
 * A card new to an arranged board stands in its own column: under the lowest card already in that column of its frame, or,
 * when it opens the column, right of the cards of the columns before it (a take lands after the storyboards it is made
 * from). Whatever the person has moved, it is then pushed down past any card it would cover.
 */
function newCardPlace(card: CanvasCard, cards: readonly CanvasCard[], out: Readonly<Record<string, Point>>, sizes: Readonly<Record<string, Size>>): Point {
	const of = (c: CanvasCard) => sizes[c.id] ?? cardSize(undefined);
	const siblings = cards.filter(c => c.section === card.section && c.id !== card.id && out[c.id]);
	const same = siblings.filter(c => c.column === card.column);
	const before = siblings.filter(c => c.column < card.column);
	const x = same.length ? out[same[0].id].x : before.length ? Math.max(...before.map(c => out[c.id].x + CARD_W)) + GAP : PAD;
	let y = same.length ? Math.max(...same.map(c => out[c.id].y + of(c).h)) + GAP : TITLE + PAD;
	const h = of(card).h;
	for (let moved = true; moved;) {
		moved = false;
		for (const c of siblings) {
			const at = out[c.id];
			if (x < at.x + CARD_W && at.x < x + CARD_W && y < at.y + of(c).h && at.y < y + h) {
				y = at.y + of(c).h + GAP;
				moved = true;
			}
		}
	}
	return { x, y };
}

/** The opening zoom's floor and cap (section 2c; 2026-11-10: 25 %). */
const OPEN_ZOOM = { floor: 0.25, cap: 0.55 } as const;
/** The pane's margin around a fitted board, and a board too large to fit's corner from the pane's (as before 2c). */
const FIT_MARGIN = 40;
const CORNER = { x: 40, y: 56 };

/**
 * The viewport a board opens at, from its top-level nodes' boxes (its frames, and each card with no frame) and the
 * pane's size: fitted when that takes 25 % or more, but never above 55 % (React Flow's fitView, which "will be zoomed and
 * panned to fit all the nodes"; tldraw's zoomToBounds, whose "targetZoom" caps it, and zoomSteps, whose "first value is
 * the minimum zoom"); a board that fits only below 25 % opens at 25 % at its top-left corner. A board with nothing on it
 * has no box to open at, and Math.min of nothing is Infinity, which React Flow's pan/zoom turns into NaN and stops
 * answering, and the canvas no longer pans or zooms; so it is an error, not a guess. Asking only for frames left the
 * assets canvas of single cards, which has none, blank.
 */
export function openingViewport(boxes: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[], pane: Size): { x: number; y: number; zoom: number } {
	if (!boxes.length) {
		throw new Error('openingViewport: the board has nothing on it');
	}
	const left = Math.min(...boxes.map(b => b.x));
	const top = Math.min(...boxes.map(b => b.y));
	const width = Math.max(...boxes.map(b => b.x + b.w)) - left;
	const height = Math.max(...boxes.map(b => b.y + b.h)) - top;
	const fit = Math.min((pane.w - 2 * FIT_MARGIN) / Math.max(1, width), (pane.h - 2 * FIT_MARGIN) / Math.max(1, height));
	if (!(fit >= OPEN_ZOOM.floor)) {
		return { x: CORNER.x - left * OPEN_ZOOM.floor, y: CORNER.y - top * OPEN_ZOOM.floor, zoom: OPEN_ZOOM.floor };
	}
	const zoom = Math.min(fit, OPEN_ZOOM.cap);
	return { x: (pane.w - width * zoom) / 2 - left * zoom, y: (pane.h - height * zoom) / 2 - top * zoom, zoom };
}
