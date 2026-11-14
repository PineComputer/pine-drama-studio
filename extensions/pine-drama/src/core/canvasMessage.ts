// The canvas's lineage message, built from the drama (lineage.ts, assetsCanvas.ts): what the episode canvas posts
// (episodeCanvas.ts) and what the render smoke test posts, one builder for both. No vscode import: a webview address
// comes from `src`.
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assetsBoard, type AssetsBoard } from './assetsCanvas';
import { CANVAS_PROTOCOL, type CanvasCard, type CanvasLayout, type CanvasViewport, type ToCanvas } from './canvasProtocol';
import { ASSETS_CANVAS, assetFocus, episodeLineage, type LineageStage } from './lineage';
import { actionsOf, marksOf, type ChatTitle, type Drama } from './project';
import { mediaOf } from './versionDetail';

export interface CanvasRead {
	readonly root: string;
	/** The episode's folder name (`EP001`), or ASSETS_CANVAS. */
	readonly episode: string;
	readonly drama: Drama;
	/** A Chat's title by its key, for the marks' words (project.ts marksOf). */
	readonly chatTitle?: ChatTitle;
	readonly layout: CanvasLayout;
	/** The object the canvas centres on (the asset the person clicked), if any. */
	readonly focus: string | undefined;
	/** The view the person last left this canvas at, if any. */
	readonly viewport: CanvasViewport | undefined;
	/** The webview's address of a project file. */
	src(rel: string): string;
}

const exists = (root: string, rel: string) => stat(isAbsolute(rel) ? rel : join(root, ...rel.split('/'))).then(() => true, () => false);

async function card(read: CanvasRead, s: LineageStage, board: AssetsBoard | undefined): Promise<CanvasCard> {
	const media = s.shows ? mediaOf(s.shows) : 'none';
	const missing = s.shows !== null && !(await exists(read.root, s.shows));
	// Every stage is one of the drama's objects (lineage.ts).
	const object = read.drama.objects.get(s.id)!;
	return {
		id: s.id, kind: s.kind, label: s.label, section: s.section, column: s.column, version: s.version, accepted: s.accepted, segment: s.segment,
		notUsable: object.usable ? null : object.why ?? 'not usable yet',
		file: s.shows, media, missing,
		src: s.shows && !missing && (media === 'image' || media === 'video') ? read.src(s.shows) : null,
		appearsIn: board ? board.appearsIn[s.id] ?? [] : null,
		name: board?.names[s.id] ?? null,
		...marksOf(read.chatTitle ?? (() => undefined), object), actions: actionsOf(object),
		...(s.planned ? { planned: true } : {}),
		...(s.parts ? { parts: s.parts } : {}),
	};
}

/** The newest snapshot time among the cards' objects: what the canvas's readiness and edges are as of. */
function observedAt(drama: Drama, ids: readonly string[]): string | null {
	return ids.map(id => drama.objects.get(id)?.observedAt).filter((t): t is string => !!t).sort().at(-1) ?? null;
}

/** The lineage message of one canvas: an episode's, or the assets board (ASSETS_CANVAS). */
export async function lineageMessage(read: CanvasRead): Promise<Extract<ToCanvas, { type: 'lineage' }>> {
	const board = read.episode === ASSETS_CANVAS ? assetsBoard(read.drama) : undefined;
	const slice = board ?? episodeLineage(read.drama, read.episode);
	const cards = await Promise.all(slice.stages.map(s => card(read, s, board)));
	return {
		v: CANVAS_PROTOCOL, type: 'lineage', episode: read.episode, origin: { kind: 'snapshot', observedAt: observedAt(read.drama, cards.map(c => c.id)) },
		sections: slice.sections, cards, links: slice.links, layout: read.layout, titles: board?.titles ?? null,
		focus: read.focus ? assetFocus(slice, read.focus) : null, viewport: read.viewport ?? null,
	};
}
