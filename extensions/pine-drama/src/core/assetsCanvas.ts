// The global assets canvas's board (screenshots 647 and 711 beside Pippit's): one group frame
// per asset, keyed by the asset's id and titled with its name, holding one card per object: the asset itself and each of
// its variants, with a dashed line from each variant to the object it derives from (`variant_of`); a scene inside
// another sits in that scene's group (`inside_of`). Names, edges and the episodes an asset appears in are its scope's
// snapshot's (doc/protocol.md, section 5). Nothing is made up. No vscode import.
import type { NodeName } from './canvasProtocol';
import { assetsLineage, ASSETS_CANVAS, type Lineage } from './lineage';
import type { Drama } from './project';
import { episodeIn, variantRoot } from './project';

export interface AssetsBoard extends Lineage {
	/** Each group's title, by its key (the asset's id). */
	readonly titles: Readonly<Record<string, string>>;
	/** The episodes each asset's own card says it appears in (`appears_in`), by card id. */
	readonly appearsIn: Readonly<Record<string, readonly string[]>>;
	/** Each card's asset's name and its own ("Base" for the asset's own), by card id: the box's header. */
	readonly names: Readonly<Record<string, NodeName>>;
}

/**
 * A card's name: in a frame titled with its asset's name, only what tells
 * it apart, its own name ("Base" for the asset's own card, after Pippit's "…-Base Image", 734). Where its frame names
 * another asset (an interior in its exterior's frame), the asset's name leads.
 */
export function cardLabel(name: NodeName, root: boolean, titled: boolean): string {
	return titled ? name.node : root ? name.asset : `${name.asset} · ${name.node}`;
}

export function assetsBoard(drama: Drama): AssetsBoard {
	const lineage = assetsLineage(drama);
	const nameOf = (id: string) => drama.objects.get(id)?.name ?? id;
	const outside = (asset: string) => drama.edges.find(e => e.kind === 'inside_of' && e.from === asset)?.to;
	const groupOf = (asset: string) => outside(asset) ?? asset;
	const stages = lineage.stages.map(s => {
		const asset = variantRoot(drama, s.id);
		return { ...s, section: groupOf(asset), name: { asset: nameOf(asset), node: s.id === asset ? 'Base' : s.label }, root: s.id === asset };
	});
	const titles: Record<string, string> = Object.fromEntries([...new Set(stages.map(s => s.section))].map(key => [key, nameOf(key)]));
	const appearsIn: Record<string, readonly string[]> = {};
	for (const s of stages.filter(s => s.root)) {
		const episodes = drama.edges.filter(e => e.kind === 'appears_in' && e.from === s.id).map(e => episodeIn(e.to) ?? e.to);
		if (episodes.length) {
			appearsIn[s.id] = episodes;
		}
	}
	const order = ['Characters', 'Locations', 'Props'];
	const regionOf = (key: string) => order.indexOf(lineage.stages.find(s => s.id === key)?.section ?? '');
	const sections = Object.keys(titles).sort((a, b) => regionOf(a) - regionOf(b) || titles[a].localeCompare(titles[b]));
	const names: Record<string, NodeName> = Object.fromEntries(stages.map(s => [s.id, s.name]));
	const labelled = stages.map(({ name, root, ...s }) => ({ ...s, label: cardLabel(name, root, s.section === variantRoot(drama, s.id)) }));
	const ids = new Set(stages.map(s => s.id));
	// The derivations the edges state, drawn before anything is drawn: each variant from what it derives from, and a
	// scene to the one it lies inside. The version records' own lines are the same pairs once drawn, and drawn once.
	const derived = drama.edges.filter(e => (e.kind === 'variant_of' || e.kind === 'inside_of') && ids.has(e.from) && ids.has(e.to)).map(e => ({ from: e.to, to: e.from }));
	const links = [...lineage.links, ...derived.filter(l => !lineage.links.some(o => o.from === l.from && o.to === l.to))];
	return { stages: labelled, links, sections, titles, appearsIn, names };
}

/**
 * The tree item a canvas shows while it is the active editor (section 4, as galleries.ts gives a page
 * its kind's group): an episode's canvas its episode; the assets canvas 2. Assets, or the picked card itself.
 */
export function canvasTreePath(canvas: string, picked: string | undefined): string {
	if (canvas !== ASSETS_CANVAS) {
		return `episodes/${canvas}`;
	}
	return picked ?? '#assets';
}
