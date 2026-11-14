// The asset grids (sections 13 and 14): one card per character, scene or prop, as Pippit's grid shows them, and the
// tree's counts; and the canvas record panel's record. All from the read model (core/project.ts). Nothing is judged
// here. No vscode import.

import type { CanvasRecord } from './canvasProtocol';
import type { AddType, Collection, GallerySection, GalleryTile } from './galleryProtocol';
import { variantsOf, type ProjectObject, type ProjectReadModel } from './project';
import { mediaOf } from './versionDetail';

/** The object type of a grid's kind (doc/protocol.md 2.2). */
export const TYPE_OF: Readonly<Record<Collection, AddType>> = { characters: 'character', scenes: 'scene', props: 'prop' };

/** An asset and every variant derived from it, down their chains. */
function family(drama: ProjectReadModel, asset: ProjectObject): ProjectObject[] {
	const out = [asset];
	for (let i = 0; i < out.length; i += 1) {
		out.push(...variantsOf(drama, out[i].id).filter(v => !out.includes(v)));
	}
	return out;
}

/** One asset and its counts: how many of its objects show a file, and how many are still to be made. */
export interface AssetVisuals {
	readonly object: ProjectObject;
	readonly made: number;
	readonly needed: number;
}

/** The assets of a kind, in id order, each with its own and its variants' counts (Pippit's "4 visuals · 3 visuals needed"). */
export function assetsOf(drama: ProjectReadModel, kind: Collection): AssetVisuals[] {
	return [...drama.objects.values()].filter(o => o.type === TYPE_OF[kind]).sort((a, b) => (a.id < b.id ? -1 : 1)).map(object => {
		const all = family(drama, object);
		return { object, made: all.filter(o => o.shownFile).length, needed: all.filter(o => !o.shownFile).length };
	});
}

/** The tree's words on a kind's row: how many assets, and how many of their objects are still to be made. */
export function kindCount(drama: ProjectReadModel, kind: Collection): { assets: number; toSet: number } {
	const assets = assetsOf(drama, kind);
	return { assets: assets.length, toSet: assets.reduce((sum, a) => sum + a.needed, 0) };
}

/**
 * A kind's grid: one card per asset (Pippit's asset grid), its shown picture, its name, and its objects counted; its
 * description is its tooltip and what its actions change. Create New comes last.
 */
export function assetGrid(drama: ProjectReadModel, kind: Collection): GallerySection {
	const tiles: GalleryTile[] = assetsOf(drama, kind).map(({ object, made, needed }) => ({
		stagePath: object.id, name: object.name, note: null,
		file: object.shownFile && mediaOf(object.shownFile) === 'image' ? object.shownFile : null, description: object.description ?? '',
		visuals: { made, needed },
	}));
	return { title: kind, tiles, add: TYPE_OF[kind] };
}

/** The record panel's data for an asset's or a variant's card; null for any other object. */
export function recordOf(drama: ProjectReadModel, id: string): CanvasRecord | null {
	const object = drama.objects.get(id);
	if (!object || !['character', 'scene', 'prop', 'variant'].includes(object.type)) {
		return null;
	}
	return { object: id, type: object.type, description: object.description ?? '', from: object.variantOf };
}
