// A project's lineage for the canvas, from the read model (core/project.ts): a card per object, a line from each object
// its draw request sends (object.json `objects_sent_by_draw_request`, doc/protocol.md 2.2, the one source of lines, for
// a drawn object and an undrawn one alike), and the groups the canvas frames them in. No vscode import.

import type { ObjectType } from './protocol';
import type { ProjectObject, ProjectReadModel } from './project';

/** The object types in pipeline order (doc/protocol.md, section 5.1): a card's column. */
export const TYPES: readonly ObjectType[] = [
	'screenplay', 'bible', 'character', 'scene', 'prop', 'variant', 'breakdown', 'storyboard', 'keyframe', 'video_prompts', 'take', 'cut', 'subtitles',
];
export type LineageKind = ObjectType;

/** One object as a card. */
/** One object as a card. */
export interface LineageStage {
	/** The object id: its folder, project-relative. */
	readonly id: string;
	readonly kind: LineageKind;
	/** Its column in the pipeline's order (TYPES). */
	readonly column: number;
	/** Its shown file, project-relative, or null for a planned, empty card. */
	readonly shows: string | null;
	/** Its name for the person (object.json `name`). */
	readonly label: string;
	/** The group it is framed in: `Text`, `Characters`, `Locations`, `Props`, `<episode> <segment>`, `<episode> cut`. */
	readonly section: string;
	/** Its segment within its episode, or null. */
	readonly segment: string | null;
	/** A paid call for it is under way (project.ts makingNow). */
	readonly makingNow: boolean;
}

/** A line: the draw request of `to` sends `from`. */
export interface LineageLink {
	readonly from: string;
	readonly to: string;
}

export interface Lineage {
	readonly stages: readonly LineageStage[];
	readonly links: readonly LineageLink[];
	/** Group titles in the canvas's order, each holding at least one card. */
	readonly sections: readonly string[];
}

export { ASSETS_CANVAS } from './canvasProtocol';

const TEXT: ReadonlySet<ObjectType> = new Set(['screenplay', 'bible', 'breakdown', 'video_prompts', 'subtitles']);
const ASSET: Readonly<Record<string, string>> = { character: 'Characters', scene: 'Locations', prop: 'Props' };

/** The asset an object is, or derives from down its `variant_of` chain; undefined for any other object. */
function assetOf(drama: ProjectReadModel, object: ProjectObject): ProjectObject | undefined {
	const seen = new Set<string>();
	let at: ProjectObject | undefined = object;
	while (at && at.type === 'variant' && !seen.has(at.id)) {
		seen.add(at.id);
		at = at.variantOf ? drama.objects.get(at.variantOf) : undefined;
	}
	return at && ASSET[at.type] ? at : undefined;
}

function sectionOf(drama: ProjectReadModel, object: ProjectObject): string {
	if (TEXT.has(object.type)) {
		return 'Text';
	}
	const asset = assetOf(drama, object);
	if (asset) {
		return ASSET[asset.type];
	}
	const episode = object.episode ?? object.id;
	return object.type === 'cut' ? `${episode} cut` : object.segment ? `${episode} ${object.segment}` : episode;
}

function stageOf(drama: ProjectReadModel, object: ProjectObject): LineageStage {
	return {
		id: object.id, kind: object.type, column: TYPES.indexOf(object.type), shows: object.shownFile,
		label: object.name, section: sectionOf(drama, object), segment: object.segment, makingNow: object.makingNow,
	};
}

/**
 * The objects an object's draw request sends: which cards an episode's canvas holds, and the lines it draws (a take's
 * from its keyframe, storyboard, places, people and props).
 */
const inputsOf = (object: ProjectObject): readonly string[] => object.objectsSentByDrawRequest;

/** The lineage of `kept` objects, with the lines among them, its groups in the canvas's order. */
function lineageOf(drama: ProjectReadModel, kept: readonly ProjectObject[]): Lineage {
	const ids = new Set(kept.map(o => o.id));
	const stages = kept.map(o => stageOf(drama, o)).sort((a, b) => a.column - b.column || (a.id < b.id ? -1 : 1));
	// One line per pair, though a draw request may send one object twice (its Image numbers keep the repeat).
	const links = kept.flatMap(o => [...new Set(inputsOf(o))].filter(from => ids.has(from)).map(from => ({ from, to: o.id })));
	const head = ['Text', 'Characters', 'Locations', 'Props'];
	const rest = [...new Set(stages.map(s => s.section))].filter(s => !head.includes(s)).sort((a, b) => Number(a.endsWith(' cut')) - Number(b.endsWith(' cut')) || (a < b ? -1 : 1));
	return { stages, links, sections: [...head, ...rest].filter(title => stages.some(s => s.section === title)) };
}

/**
 * One episode's canvas: the episode's own objects and every object one of them was made from (the shared assets it
 * used), with the lines among those. `episode` is its folder name (`EP001`).
 */
export function episodeLineage(drama: ProjectReadModel, episode: string): Lineage {
	const own = [...drama.objects.values()].filter(o => o.episode === episode);
	const used = new Set(own.flatMap(o => inputsOf(o)));
	return lineageOf(drama, [...own, ...[...drama.objects.values()].filter(o => o.episode !== episode && used.has(o.id))]);
}

/** The assets canvas: every character, scene, prop and variant. */
export function assetsLineage(drama: ProjectReadModel): Lineage {
	return lineageOf(drama, [...drama.objects.values()].filter(o => assetOf(drama, o)));
}

/**
 * The card an asset's click centres the assets canvas on: the asset's own card, else null when
 * the canvas has none.
 */
export function assetFocus(slice: Lineage, object: string): string | null {
	return slice.stages.some(s => s.id === object) ? object : null;
}
