import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CANVAS_PROTOCOL, readFromCanvas, type CanvasCard, type Point, type Size } from '../core/canvasProtocol';
import { assetCardSize, ASSET_FOOT_H, cardSize, CARD_W, FOOT_H, LABEL_H, layoutEpisode, layoutOf, onBoard, openingViewport, positionsFor } from '../core/canvasLayout';

/** A real episode's board, its cards as the extension sends them (test-fixtures/canvas/README.md). */
const BOARD = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test-fixtures', 'canvas', 'double-life-EP001.json'), 'utf8')) as { sections: string[]; cards: CanvasCard[] };
const slice = () => BOARD;
function cards(): CanvasCard[] {
	return BOARD.cards.map(c => ({ ...c }));
}
/** Pictures of the ratios a drama has: 9:16 takes and storyboards, wide character sheets, square props. */
function sizes(all: CanvasCard[]): Record<string, Size> {
	const ratio = (c: CanvasCard): Size => (c.kind === 'take' || c.kind === 'cut' || c.kind === 'storyboard' ? { w: 720, h: 1280 } : c.kind === 'look' ? { w: 2048, h: 1152 } : { w: 1024, h: 1024 });
	return Object.fromEntries(all.map(c => [c.id, cardSize(ratio(c))]));
}
type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A frame as the canvas draws it around its cards (canvas.tsx, nodesFor): from its place to its cards' far edge, plus 20. */
function frameBox(title: string, all: CanvasCard[], positions: Record<string, Point>, size: Record<string, Size>): Box {
	const at = positions[`frame:${title}`];
	const own = all.filter(c => c.section === title && positions[c.id]);
	return { ...at, w: Math.max(...own.map(c => positions[c.id].x + size[c.id].w)) + 20, h: Math.max(...own.map(c => positions[c.id].y + size[c.id].h)) + 20 };
}

test("a card is as tall as its own picture at drama-cli's width, plus its label and version line", () => {
	assert.deepEqual(cardSize({ w: 720, h: 1280 }), { w: CARD_W, h: LABEL_H + 533 + FOOT_H });
	assert.deepEqual(cardSize({ w: 2048, h: 1152 }), { w: CARD_W, h: LABEL_H + 169 + FOOT_H });
	assert.deepEqual(cardSize(undefined), { w: CARD_W, h: 340 }, "unknown size: drama-cli's HEIGHT");
	// An assets card has no label row and a taller footer; an episode's card is as above.
	assert.deepEqual(assetCardSize({ w: 720, h: 1280 }), { w: CARD_W, h: 533 + ASSET_FOOT_H });
	assert.deepEqual(assetCardSize(undefined), { w: CARD_W, h: 290 + ASSET_FOOT_H });
});

test("drama-cli's groups and order, four to a row; the references in a band on top, the segments side by side in order, the cut last; text off the board", () => {
	const all = cards();
	const size = sizes(all);
	const { positions } = layoutEpisode(slice().sections, all, size);
	assert.ok(!('frame:Text' in positions), 'text stages stay off the board');
	assert.ok(!all.filter(c => !onBoard(c)).some(c => positions[c.id]));
	const frame = (title: string) => frameBox(title, all, positions, size);
	const row = (title: string) => all.filter(c => c.section === title).sort((a, b) => positions[a.id].x - positions[b.id].x || positions[a.id].y - positions[b.id].y);
	assert.deepEqual(row('EP001 seg01').map(c => c.kind), ['keyframe', 'storyboard', 'take']);
	assert.equal(new Set(row('EP001 seg01').map(c => positions[c.id].y)).size, 1, 'one row');
	// Every reference frame stands above every segment frame.
	const segments = ['EP001 seg01', 'EP001 seg02', 'EP001 seg03'].map(frame);
	for (const ref of ['Characters', 'Locations', 'Props'].filter(t => positions[`frame:${t}`]).map(frame)) {
		assert.ok(segments.every(seg => ref.y + ref.h <= seg.y), 'the references are a band above the segments');
	}
	// 2a: the segments in reading order, left to right and then the next row, and the cut after the last.
	const after = (b: Box, a: Box) => b.y > a.y || (b.y === a.y && b.x > a.x + a.w);
	assert.ok(after(segments[1], segments[0]) && after(segments[2], segments[1]), 'side by side, in order');
	assert.ok(segments.some((seg, i) => i > 0 && seg.y === segments[0].y), 'at least two segments share a row');
	assert.ok(after(frame('EP001 cut'), segments[2]), 'the cut comes after the last segment');
});

/** An episode of `n` segments, each a blocking, two keyframes, a storyboard and a take, and three characters. */
function longEpisode(n: number): { sections: string[]; all: CanvasCard[] } {
	const card = (id: string, kind: CanvasCard['kind'], section: string, column: number): CanvasCard => ({ id, kind, label: id, section, column, version: 'v1', accepted: 'v1',
		segment: null, file: `${id}/v1/a.png`, media: 'image', src: 'x', missing: false, notUsable: null, appearsIn: null, name: null, outgoing: null, inFlight: null, problem: null });
	const segs = Array.from({ length: n }, (_, i) => `EP001 seg${String(i + 1).padStart(2, '0')}`);
	const all = [
		...['a', 'b', 'c'].map(c => card(`assets/characters/${c}`, 'look', 'Characters', 1)),
		...segs.flatMap(seg => [card(`${seg}/k0`, 'keyframe', seg, 3), card(`${seg}/k1`, 'keyframe', seg, 3), card(`${seg}/k2`, 'keyframe', seg, 3),
			card(`${seg}/board`, 'storyboard', seg, 4), card(`${seg}/take`, 'take', seg, 6)]),
	];
	return { sections: ['Characters', ...segs], all };
}

test('a long episode wraps its segment frames into rows, in reading order, at the width closest to square (2a)', () => {
	const { sections, all } = longEpisode(8);
	const size = Object.fromEntries(all.map(c => [c.id, cardSize(undefined)]));
	const { positions } = layoutEpisode(sections, all, size);
	const frames = sections.slice(1).map(title => ({ title, ...frameBox(title, all, positions, size) }));
	const rows = [...new Set(frames.map(f => f.y))];
	assert.ok(rows.length >= 2 && rows.length < 8, `wrapped into ${rows.length} rows`);
	// Reading order: left to right, then the next row.
	frames.slice(1).forEach((f, i) => assert.ok(f.y > frames[i].y || (f.y === frames[i].y && f.x > frames[i].x), `${f.title} after ${frames[i].title}`));
	frames.forEach((a, i) => frames.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `${a.title} / ${b.title}`)));
	// Closest to square of every packing: the segments' frames are alike, so a packing is how many stand in a row, k, under
	// the band; the one chosen has the smallest |log(width / height)| of k = 1 … 8.
	const band = frameBox('Characters', all, positions, size);
	const [w, h] = [frames[0].w, frames[0].h];
	const score = (width: number, height: number) => Math.abs(Math.log(width / height));
	const best = Math.min(...Array.from({ length: 8 }, (_, i) => {
		const k = i + 1;
		const rowsOf = Math.ceil(8 / k);
		return score(Math.max(band.w, k * w + (k - 1) * 60), band.h + 60 + rowsOf * h + (rowsOf - 1) * 60);
	}));
	const right = Math.max(band.x + band.w, ...frames.map(f => f.x + f.w));
	const bottom = Math.max(...frames.map(f => f.y + f.h));
	assert.ok(Math.abs(score(right, bottom) - best) < 1e-9, `the squarest packing: ${right} × ${bottom}`);
});

test('pictures of different ratios never overlap: a row is as tall as its tallest card; frames, drawn around their cards, do not overlap', () => {
	const all = cards();
	const size = sizes(all);
	const { positions } = layoutEpisode(slice().sections, all, size);
	const titles = Object.keys(positions).filter(id => id.startsWith('frame:')).map(id => id.slice('frame:'.length));
	const frames = titles.map(title => ({ title, ...frameBox(title, all, positions, size) }));
	frames.forEach((a, i) => frames.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `${a.title} / ${b.title}`)));
	for (const title of titles) {
		const own = all.filter(c => c.section === title).map(c => ({ id: c.id, ...positions[c.id], ...size[c.id] }));
		own.forEach((a, i) => own.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `${a.id} / ${b.id}`)));
		for (const c of own) {
			assert.ok(c.x >= 0 && c.y >= 0, `${c.id} above or left of ${title}`);
		}
	}
});

test('an update never moves a node on screen or one the person placed; a new card on an arranged board covers nothing', () => {
	const all = cards();
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	// A board never arranged takes the defaults.
	assert.deepEqual(positionsFor(defaults, {}, {}, all, size), defaults);
	// The person moved one card; everything else is on screen where the defaults put it.
	const moved = 'assets/characters/cassie';
	const onScreen: Record<string, Point> = { ...defaults, [moved]: { x: 999, y: 999 } };
	const kept = positionsFor(defaults, {}, onScreen, all, size);
	assert.deepEqual(kept[moved], { x: 999, y: 999 });
	// A new take arrives in seg02 (not on screen, not saved): it goes under the lowest card of its frame.
	const fresh = 'episodes/EP001/segments/seg02';
	const without = Object.fromEntries(Object.entries(onScreen).filter(([id]) => id !== fresh));
	const placed = positionsFor(defaults, {}, without, all, size);
	for (const other of all.filter(c => c.section === 'EP001 seg02' && c.id !== fresh)) {
		assert.ok(!overlap({ ...placed[fresh], ...size[fresh] }, { ...placed[other.id], ...size[other.id] }), other.id);
		assert.deepEqual(placed[other.id], onScreen[other.id], 'others stay');
	}
	// A saved place comes back after a reload; a stage gone from the lineage is gone.
	assert.deepEqual(positionsFor(defaults, { [moved]: { x: 5, y: 6 } }, {}, all, size)[moved], { x: 5, y: 6 });
	assert.ok(!('gone/stage' in positionsFor(defaults, { 'gone/stage': { x: 1, y: 1 } }, {}, all, size)));
});

test("a take new to an arranged board goes right of the columns it is made from, and covers nothing, whatever the pictures' ratios (2026-11-02)", () => {
	const all = cards();
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	const takes = all.filter(c => c.kind === 'take');
	assert.ok(takes.length >= 2 && takes.every(c => c.column === 6));
	const onScreen = Object.fromEntries(Object.entries(defaults).filter(([id]) => !takes.some(t => t.id === id)));
	const placed = positionsFor(defaults, {}, onScreen, all, size);
	for (const take of takes) {
		const others = all.filter(c => c.section === take.section && c.id !== take.id && placed[c.id]);
		const earlier = others.filter(c => c.column < take.column);
		assert.ok(earlier.length > 0);
		assert.ok(placed[take.id].x >= Math.max(...earlier.map(c => placed[c.id].x + CARD_W)), `${take.id} is right of columns 1-5`);
		others.forEach(c => assert.ok(!overlap({ ...placed[take.id], ...size[take.id] }, { ...placed[c.id], ...size[c.id] }), `${take.id} / ${c.id}`));
	}
	// A second card of the column goes under the first; a card the person left in its way is stepped over.
	const [one, two] = takes.filter(t => t.section === takes[0].section).concat(takes[0]);
	const twin = { ...takes[0], id: 'twin', column: 6 };
	const both = positionsFor({ ...defaults, twin: { x: 0, y: 0 } }, {}, { ...onScreen, [one.id]: placed[one.id] }, [...all, twin], { ...size, twin: size[takes[0].id] });
	assert.ok(!overlap({ ...both.twin, ...size[takes[0].id] }, { ...both[one.id], ...size[one.id] }));
	assert.equal(both.twin.x, both[one.id].x);
	void two;
	// Wide plates and tall videos in one column never overlap either.
	const mixed = all.filter(c => c.section === 'Locations');
	const tall = Object.fromEntries(mixed.map((c, i) => [c.id, cardSize(i % 2 ? { w: 720, h: 1280 } : { w: 2048, h: 1152 })]));
	const lay = layoutEpisode(slice().sections, mixed, tall).positions;
	mixed.forEach((a, i) => mixed.slice(i + 1).forEach(b => assert.ok(!overlap({ ...lay[a.id], ...tall[a.id] }, { ...lay[b.id], ...tall[b.id] }), `${a.id} / ${b.id}`)));
});

test('a frame new to an arranged board covers no frame: the cut after takes that went right of their storyboards (2026-11-03)', () => {
	// Three cards before the take: the first frame (column 3), line-art and photoreal storyboards (column 4). The fixture's
	// seg01 has one storyboard; a second style is added. (The blocking stage is gone)
	const base = cards();
	const board = base.find(c => c.section === 'EP001 seg01' && c.kind === 'storyboard')!;
	const all = [...base, { ...board, id: `${board.id}-photoreal`, label: 'EP001 seg01 photoreal' }];
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	const takes = all.filter(c => c.kind === 'take');
	const cut = all.filter(c => c.kind === 'cut');
	assert.ok(takes.length >= 2 && cut.length >= 1);
	assert.equal(all.filter(c => c.section === 'EP001 seg01' && c.column < 6).length, 3);
	// The board was arranged before the takes and the cut came back (e2e on pine-dev, 2026-11-03: the cut's frame covered
	// seg01's take). First the takes arrive and go right of their storyboards; then the cut arrives with its frame.
	const late = new Set([...takes, ...cut].map(c => c.id));
	const cutFrames = [...new Set(cut.map(c => `frame:${c.section}`))];
	const before = Object.fromEntries(Object.entries(defaults).filter(([id]) => !late.has(id) && !cutFrames.includes(id)));
	// What is on screen after the takes: the canvas draws no frame without cards (canvas.tsx, nodesFor), so not the cut's.
	const withTakes = Object.fromEntries(Object.entries(positionsFor(defaults, {}, before, all.filter(c => c.kind !== 'cut'), size)).filter(([id]) => !cutFrames.includes(id)));
	const placed = positionsFor(defaults, {}, withTakes, all, size);
	const titles = Object.keys(placed).filter(id => id.startsWith('frame:')).map(id => id.slice('frame:'.length));
	const frames = titles.map(title => ({ title, ...frameBox(title, all, placed, size) }));
	frames.forEach((a, i) => frames.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `${a.title} / ${b.title}`)));
	// Nothing already on screen moved.
	for (const [id, at] of Object.entries(withTakes)) {
		assert.deepEqual(placed[id], at, id);
	}
});

/** Every card and frame of a board, and the assertion that none overlaps another, and each frame holds its cards. */
function assertNoOverlap(all: CanvasCard[], positions: Record<string, Point>, size: Record<string, Size>) {
	const board = all.filter(c => onBoard(c) && positions[c.id]);
	const titles = [...new Set(board.map(c => c.section))].filter(t => positions[`frame:${t}`]);
	const frames = titles.map(title => ({ title, ...frameBox(title, board, positions, size) }));
	frames.forEach((a, i) => frames.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `frames ${a.title} / ${b.title}`)));
	// A card's box on the board: its frame's place plus its own (React Flow's parentId).
	const abs = board.map(c => ({ id: c.id, x: positions[`frame:${c.section}`].x + positions[c.id].x, y: positions[`frame:${c.section}`].y + positions[c.id].y, ...size[c.id] }));
	abs.forEach((a, i) => abs.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `cards ${a.id} / ${b.id}`)));
}

// The person's EP002 canvas: on a board already arranged, a frame grew (a new card under its column, a
// picture taller than when it was placed) while the frames below it kept their places, so it covered them: seg04's
// blocking drawn over seg03's first-frame reference, a prop over a location.
test('on an arranged board, a frame that grows covers no frame and no card: a new card under its column', () => {
	const all = cards();
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	// Everything is on screen where the defaults put it, except a new card of seg01, the first segment, in a column of its own.
	const seg = 'EP001 seg01';
	const extra: CanvasCard = { ...all.find(c => c.section === seg)!, id: 'episodes/EP001/keyframe/seg01/shot99', kind: 'keyframe', column: 0, label: 'seg01 shot 99 keyframe (new)' };
	const grown = [...all, extra];
	const withExtra = { ...size, [extra.id]: cardSize({ w: 1152, h: 2048 }) };
	const placed = positionsFor({ ...defaults, [extra.id]: defaults[all.find(c => c.section === seg)!.id] }, {}, defaults, grown, withExtra);
	assertNoOverlap(grown, placed, withExtra);
});

test('on an arranged board, a picture that became taller covers no frame and no card', () => {
	const all = cards();
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	// A segment's square picture is redrawn as a tall strip: its card grows on screen past the gap to the next frame.
	const tall = all.find(c => c.kind !== 'take' && c.kind !== 'cut' && c.section.startsWith('EP001 seg') && c.media === 'image')!;
	const bigger = { ...size, [tall.id]: cardSize({ w: 512, h: 2048 }) };
	assertNoOverlap(all, positionsFor(defaults, {}, defaults, all, bigger), bigger);
});

test('on an arranged board, nothing covered, nothing moves: the person\'s places and the defaults stay as they are', () => {
	const all = cards();
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	// The person moved a card and a frame to free space; nothing grew.
	const card = all.find(c => c.section === 'EP001 seg01')!.id;
	const arranged = { ...defaults, [card]: { x: defaults[card].x, y: defaults[card].y }, 'frame:EP001 seg02': { x: defaults['frame:EP001 seg02'].x + 5000, y: defaults['frame:EP001 seg02'].y } };
	assert.deepEqual(positionsFor(defaults, {}, arranged, all, size), arranged);
	assert.deepEqual(positionsFor(defaults, arranged, {}, all, size), arranged, 'a saved arrangement too');
});

test('a frame that steps down and would cover the next one moves it in turn: the reflow cascades, each frame keeping its x', () => {
	const all = cards();
	const size = sizes(all);
	const { positions: defaults } = layoutEpisode(slice().sections, all, size);
	const segs = [...new Set(all.filter(c => onBoard(c) && c.section.startsWith('EP001 seg')).map(c => c.section))].sort();
	assert.ok(segs.length >= 3, 'the fixture has three segments');
	// A board the person arranged with the segments stacked in one column, as the default stood before they went side by
	// side (section 4: a saved arrangement keeps its places).
	const arranged = { ...defaults };
	let y = 0;
	for (const seg of segs) {
		arranged[`frame:${seg}`] = { x: 2000, y };
		y += frameBox(seg, all, arranged, size).h + 60;
	}
	// seg01's picture becomes a very tall strip: its frame grows far past seg02 and seg03.
	const tall = all.find(c => c.section === segs[0] && onBoard(c) && c.media === 'image')!;
	const bigger = { ...size, [tall.id]: cardSize({ w: 256, h: 4096 }) };
	const out = positionsFor(defaults, {}, arranged, all, bigger);
	assertNoOverlap(all, out, bigger);
	for (const seg of segs.slice(1)) {
		assert.equal(out[`frame:${seg}`].x, arranged[`frame:${seg}`].x, `${seg} keeps its x`);
		assert.ok(out[`frame:${seg}`].y > arranged[`frame:${seg}`].y, `${seg} stepped down`);
	}
	// The order down the column is kept.
	for (let i = 1; i < segs.length; i++) { assert.ok(out[`frame:${segs[i]}`].y > out[`frame:${segs[i - 1]}`].y); }
});

// The person, 2026-11-07: on the canvas a segment's keyframes are expanded, each shot its own card in shot order.
test("each shot's keyframe is its own card in its segment's row, in shot order", () => {
	const kf = (shot: number): CanvasCard => ({ id: `episodes/EP001/keyframe/seg01/shot${String(shot).padStart(2, '0')}`, kind: 'keyframe', label: `EP001 seg01 shot ${shot} keyframe`, section: 'EP001 seg01', column: 3, version: 'v1', accepted: null, segment: null, file: 'k.png', media: 'image', src: 'k.png', missing: false, notUsable: null, appearsIn: null, name: null, outgoing: null, inFlight: null, problem: null });
	const all = [kf(3), kf(1), kf(2)];
	const size = Object.fromEntries(all.map(c => [c.id, cardSize({ w: 1920, h: 1080 })]));
	const { positions } = layoutEpisode(['EP001 seg01'], all, size);
	const xs = [kf(1), kf(2), kf(3)].map(c => positions[c.id].x);
	assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'shots 1, 2, 3');
	assert.equal(new Set(all.map(c => positions[c.id].y)).size, 1, 'one row of three');
});

/** A small board of two frames, as the person arranged it: cards of any section, sizes given. */
const card = (id: string, section: string): CanvasCard => ({ id, kind: 'storyboard', label: id, section, column: 0, version: 'v1', accepted: 'v1', segment: null, file: `${id}.png`, media: 'image', src: `${id}.png`, missing: false, notUsable: null, appearsIn: null, name: null, outgoing: null, inFlight: null, problem: null });

// A card the person dragged out above its frame was not part of the frame's box, so the frame
// stepped down past the frame above and carried that card onto the other frame's card.
test('a frame steps down with every card it draws, a card dragged out past its edge included, and lands on nothing', () => {
	const all = [card('a', 'EP001 seg01'), card('b1', 'EP001 seg02'), card('b2', 'EP001 seg02')];
	const arranged: Record<string, Point> = { 'frame:EP001 seg01': { x: 0, y: 0 }, a: { x: 20, y: 70 }, 'frame:EP001 seg02': { x: 0, y: 350 }, b1: { x: 20, y: 70 }, b2: { x: 20, y: -500 } };
	const small = { a: { w: 300, h: 100 }, b1: { w: 300, h: 100 }, b2: { w: 300, h: 100 } };
	assert.deepEqual(positionsFor(arranged, {}, arranged, all, small), arranged, 'nothing covered, nothing moves');
	const grown = { ...small, a: { w: 300, h: 500 } };
	const out = positionsFor(arranged, {}, arranged, all, grown);
	assertNoOverlap(all, out, grown);
	assert.equal(out['frame:EP001 seg02'].x, 0, 'it keeps its x');
});

// The canvas rounded a frame's place and its cards' places each on its own, so two frames that
// touched at fractional places could look covered and one would move about 60 px. Places keep full precision.
test('places keep full precision: frames that touch at fractional places are not covered, and nothing moves', () => {
	const all = [card('a', 'EP001 seg01'), card('b', 'EP001 seg02')];
	// seg01's frame is drawn to 0.5 + 70.5 + 100 + 20 = 191; seg02's starts exactly there.
	const nodes = [{ id: 'frame:EP001 seg01', position: { x: 0, y: 0.5 } }, { id: 'a', position: { x: 20, y: 70.5 } },
		{ id: 'frame:EP001 seg02', position: { x: 0, y: 191 } }, { id: 'b', position: { x: 20, y: 70 } }];
	const onScreen = layoutOf(nodes);
	assert.deepEqual(onScreen.a, { x: 20, y: 70.5 }, 'not rounded');
	const size = { a: { w: 300, h: 100 }, b: { w: 300, h: 100 } };
	assert.deepEqual(positionsFor(onScreen, {}, onScreen, all, size), onScreen);
});

test('messages from the webview are checked; open and inspect carry the version and file on screen', () => {
	const shown = { stageId: 'assets/characters/cassie', version: 'v4', file: 'assets/characters/cassie/v4/image-1.jpg' };
	assert.deepEqual(readFromCanvas({ v: CANVAS_PROTOCOL, type: 'open', ...shown }), { v: 1, type: 'open', ...shown });
	assert.deepEqual(readFromCanvas({ v: CANVAS_PROTOCOL, type: 'inspect', ...shown, version: null, file: null }), { v: 1, type: 'inspect', ...shown, version: null, file: null });
	assert.equal(readFromCanvas({ v: 1, type: 'open', stageId: 'x' }), undefined, 'no version or file named');
	assert.equal(readFromCanvas({ v: 2, type: 'ready' }), undefined);
	assert.deepEqual(readFromCanvas({ v: 1, type: 'unpick', stageId: 'ignored' }), { v: 1, type: 'unpick' }, 'no card picked any more');
	assert.equal(readFromCanvas('ready'), undefined);
	assert.deepEqual(readFromCanvas({ v: 1, type: 'failed', message: 'x' }), { v: 1, type: 'failed', message: 'x' });
	assert.deepEqual(readFromCanvas({ v: 1, type: 'segEditor', seg: null }), { v: 1, type: 'segEditor', seg: null }, 'the canvas\'s Seg Editor button');
	assert.deepEqual(readFromCanvas({ v: 1, type: 'segEditor', seg: 'seg02' }), { v: 1, type: 'segEditor', seg: 'seg02' }, 'Open in Seg Editor on a seg\'s card');
	assert.equal(readFromCanvas({ v: 1, type: 'segEditor' }), undefined);
	const positions = { 'episodes/EP001/edit': { x: 1, y: 2 }, 'frame:EP001 cut': { x: -5, y: 0 } };
	assert.deepEqual(readFromCanvas({ v: 1, type: 'layout', episode: 'EP001', positions }), { v: 1, type: 'layout', episode: 'EP001', positions });
	assert.equal(readFromCanvas({ v: 1, type: 'layout', episode: 'EP001', positions: { a: { x: '1', y: 2 } } }), undefined);
	assert.equal(readFromCanvas({ v: 1, type: 'layout', episode: 'EP001', positions: { a: { x: Infinity, y: 2 } } }), undefined);
});

test('a board opens fitted between 25 % and 55 %; one that fits only below 25 % opens at 25 % at its top-left (2c)', () => {
	const pane = { w: 1400, h: 1000 };
	const at = (zoom: number) => [{ x: 100, y: 200, w: (pane.w - 80) / zoom, h: 100 }];
	// Fits at 30 %: opened fitted, centred.
	const fitted = openingViewport(at(0.3), pane);
	assert.ok(Math.abs(fitted.zoom - 0.3) < 1e-9, JSON.stringify(fitted));
	assert.ok(Math.abs(fitted.x + 100 * fitted.zoom - 40) < 1e-6, 'its left edge at the margin');
	// Fits at 80 %: opened at the cap.
	assert.equal(openingViewport(at(0.8), pane).zoom, 0.55);
	// Fits only at 10 %: opened at the floor, at its top-left corner.
	assert.deepEqual(openingViewport(at(0.1), pane), { x: 40 - 100 * 0.25, y: 56 - 200 * 0.25, zoom: 0.25 });
	for (const zoom of [0.3, 0.8, 0.1]) { assert.ok(Object.values(openingViewport(at(zoom), pane)).every(Number.isFinite)); }
});

test('a board with nothing on it has no opening viewport: an error, not Infinity (the canvas that stopped panning, 2026-11-03)', () => {
	assert.throws(() => openingViewport([], { w: 1400, h: 1000 }), /nothing on it/);
});

