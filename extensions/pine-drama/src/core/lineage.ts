// A drama's lineage for the canvas, from the protocol (doc/protocol.md): a card per object, a line from each input
// its current version was made from (version.json `inputs`; a planned object's from the snapshot's `inputs`), and the
// groups the canvas frames them in. Lines between versions come from the version records, never from edges (section
// 5.2). Nothing is judged here. No vscode import.

import type { ObjectType } from './protocol';
import { detailOf, episodeIn, versionFile, writtenIn, type Drama, type DramaObject } from './project';

/** The object types in pipeline order (doc/protocol.md, section 5.1): a card's column. */
export const TYPES: readonly ObjectType[] = [
	'episode', 'screenplay', 'bible', 'character', 'scene', 'prop', 'variant', 'breakdown', 'storyboard', 'keyframe', 'video_prompts', 'take', 'cut', 'subtitles',
];
export type LineageKind = ObjectType;

/** One object as a card. */
export interface LineageStage {
	/** The object id: its folder, project-relative. */
	readonly id: string;
	readonly kind: LineageKind;
	/** Its column in the pipeline's order (TYPES). */
	readonly column: number;
	/** The current version, or null when none is made. */
	readonly version: string | null;
	readonly accepted: string | null;
	/** The file the current version shows (project.ts versionFile), or null. */
	readonly shows: string | null;
	/** Its name for the person (the snapshot's `name`). */
	readonly label: string;
	/** The group it is framed in: `Text`, `Characters`, `Locations`, `Props`, `<episode> <segment>`, `<episode> cut`. */
	readonly section: string;
	/** Its segment within its episode, or null. */
	readonly segment: string | null;
	/** An object with no version yet: its card stands in its place and says Planned. */
	readonly planned?: boolean;
	/** The parts its current version is written in, when more than one (doc/protocol.md 2.1, `continues`). */
	readonly parts?: number;
}

/** A line: the current version of `to` was made from `from` (or, planned, will be). */
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

const TEXT: ReadonlySet<ObjectType> = new Set(['screenplay', 'bible', 'breakdown', 'video_prompts', 'subtitles', 'episode']);
const ASSET: Readonly<Record<string, string>> = { character: 'Characters', scene: 'Locations', prop: 'Props' };

/** The asset an object is, or derives from down its `variant_of` chain; undefined for any other object. */
function assetOf(drama: Drama, object: DramaObject): DramaObject | undefined {
	const seen = new Set<string>();
	let at: DramaObject | undefined = object;
	while (at && at.type === 'variant' && !seen.has(at.id)) {
		seen.add(at.id);
		const up: string | undefined = drama.edges.find(e => e.kind === 'variant_of' && e.from === at!.id)?.to;
		at = up ? drama.objects.get(up) : undefined;
	}
	return at && ASSET[at.type] ? at : undefined;
}

function sectionOf(drama: Drama, object: DramaObject): string {
	if (TEXT.has(object.type)) {
		return 'Text';
	}
	const asset = assetOf(drama, object);
	if (asset) {
		return ASSET[asset.type];
	}
	const episode = episodeIn(object.id) ?? object.id;
	return object.type === 'cut' ? `${episode} cut` : object.segment ? `${episode} ${object.segment}` : episode;
}

function stageOf(drama: Drama, object: DramaObject): LineageStage {
	return {
		id: object.id, kind: object.type, column: TYPES.indexOf(object.type), version: object.resolved.current, accepted: object.resolved.accepted,
		shows: versionFile(object, object.resolved.current),
		label: object.name, section: sectionOf(drama, object), segment: object.segment,
		...(object.versions.length ? {} : { planned: true }),
		...partsField(object),
	};
}

function partsField(object: DramaObject): { parts?: number } {
	const parts = object.resolved.current ? writtenIn(detailOf(object), object.resolved.current) : 1;
	return parts > 1 ? { parts } : {};
}

/**
 * The objects an object's current version was made from, every one its record lists: which cards an episode's canvas
 * holds, and the lines it draws (a take's from its keyframe, storyboard, places, people and props; the reduction to
 * direct inputs is the take panel's and seg editor's alone, versionDetail.ts); a planned object's planned inputs.
 */
function inputsOf(object: DramaObject): string[] {
	const current = object.versions.find(v => v.id === object.resolved.current);
	return current ? [...new Set(current.record.inputs.map(i => i.object))] : [...object.plannedInputs];
}

/** The lineage of `kept` objects, with the lines among them, its groups in the canvas's order. */
function lineageOf(drama: Drama, kept: readonly DramaObject[]): Lineage {
	const ids = new Set(kept.map(o => o.id));
	const stages = kept.map(o => stageOf(drama, o)).sort((a, b) => a.column - b.column || (a.id < b.id ? -1 : 1));
	const links = kept.flatMap(o => inputsOf(o).filter(from => ids.has(from)).map(from => ({ from, to: o.id })));
	const head = ['Text', 'Characters', 'Locations', 'Props'];
	const rest = [...new Set(stages.map(s => s.section))].filter(s => !head.includes(s)).sort((a, b) => Number(a.endsWith(' cut')) - Number(b.endsWith(' cut')) || (a < b ? -1 : 1));
	return { stages, links, sections: [...head, ...rest].filter(title => stages.some(s => s.section === title)) };
}

/**
 * One episode's canvas: the episode's own objects and every object one of them was made from (the shared assets it
 * used), with the lines among those. `episode` is its folder name (`EP001`).
 */
export function episodeLineage(drama: Drama, episode: string): Lineage {
	const own = [...drama.objects.values()].filter(o => episodeIn(o.id) === episode && o.type !== 'episode');
	const used = new Set(own.flatMap(o => inputsOf(o)));
	return lineageOf(drama, [...own, ...[...drama.objects.values()].filter(o => episodeIn(o.id) !== episode && used.has(o.id))]);
}

/** The assets canvas: every character, scene, prop and variant. */
export function assetsLineage(drama: Drama): Lineage {
	return lineageOf(drama, [...drama.objects.values()].filter(o => assetOf(drama, o)));
}

/**
 * The card an asset's click centres the assets canvas on: the asset's own card, else null when
 * the canvas has none.
 */
export function assetFocus(slice: Lineage, object: string): string | null {
	return slice.stages.some(s => s.id === object) ? object : null;
}
