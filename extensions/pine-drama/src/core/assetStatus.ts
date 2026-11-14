// The asset grids (sections 13 and 14): one card per character, scene or prop, as
// Pippit's grid shows them, and the tree's counts; and the canvas record panel's record and picture strip. All from the
// drama (core/project.ts): names, readiness and edges are the snapshot's, versions and acceptance the files' and the
// person's choices. Nothing is judged here. No vscode import.

import type { CanvasPicture, CanvasRecord } from './canvasProtocol';
import type { AddType, Collection, GallerySection, GalleryTile } from './galleryProtocol';
import { marksOf, variantParent, variantsOf, versionFile, type ChatTitle, type Drama, type DramaObject } from './project';
import { mediaOf } from './versionDetail';

/** The object type of a grid's kind (doc/protocol.md, section 5.1). */
export const TYPE_OF: Readonly<Record<Collection, AddType>> = { characters: 'character', scenes: 'scene', props: 'prop' };

/** An asset and every variant derived from it, down their chains. */
function family(drama: Drama, asset: DramaObject): DramaObject[] {
	const out = [asset];
	for (let i = 0; i < out.length; i += 1) {
		out.push(...variantsOf(drama, out[i].id).filter(v => !out.includes(v)));
	}
	return out;
}

/** One asset and its counts: how many of its objects have a version, and how many the next steps cannot use yet. */
export interface AssetVisuals {
	readonly object: DramaObject;
	readonly made: number;
	readonly needed: number;
}

/** The assets of a kind, in id order, each with its own and its variants' counts (Pippit's "4 visuals · 3 visuals needed"). */
export function assetsOf(drama: Drama, kind: Collection): AssetVisuals[] {
	return [...drama.objects.values()].filter(o => o.type === TYPE_OF[kind]).sort((a, b) => (a.id < b.id ? -1 : 1)).map(object => {
		const all = family(drama, object);
		return { object, made: all.filter(o => o.resolved.current).length, needed: all.filter(o => !o.usable).length };
	});
}

/** The tree's words on a kind's row: how many assets, and how many of their objects are still to be set. */
export function kindCount(drama: Drama, kind: Collection): { assets: number; toSet: number } {
	const assets = assetsOf(drama, kind);
	return { assets: assets.length, toSet: assets.reduce((sum, a) => sum + a.needed, 0) };
}

/** The picture a version shows (versionFile), when its file is an image; else null. */
function picture(object: DramaObject, version: string | null): string | null {
	const file = versionFile(object, version);
	return file && mediaOf(file) === 'image' ? file : null;
}

/**
 * A kind's grid: one card per asset (Pippit's asset grid), its current picture, its name, and its objects counted; its
 * description is its tooltip and what its actions change. The person's adds of this kind that
 * no task has made yet follow as cards of their own (doc/protocol.md, section 3.1), then Create New.
 */
export function assetGrid(drama: Drama, kind: Collection, chatTitle: ChatTitle = () => undefined): GallerySection {
	const tiles: GalleryTile[] = assetsOf(drama, kind).map(({ object, made, needed }) => ({
		stagePath: object.id, name: object.name, note: null, version: object.resolved.current, accepted: object.resolved.accepted,
		file: picture(object, object.resolved.current), description: object.description ?? '',
		visuals: { made, needed }, ...marksOf(drama, chatTitle, object, null),
	}));
	const adds: GalleryTile[] = drama.adds.filter(a => a.type === TYPE_OF[kind]).map(a => ({
		stagePath: null, name: a.name, note: null, version: null, accepted: null, file: null, description: a.description, add: a.id,
		...marksOf(drama, chatTitle, null, a.id),
	}));
	return { title: kind, tiles: [...tiles, ...adds], add: TYPE_OF[kind] };
}

/** The record panel's data for an asset's or a variant's card; null for any other object. */
export function recordOf(drama: Drama, id: string): CanvasRecord | null {
	const object = drama.objects.get(id);
	if (!object || !['character', 'scene', 'prop', 'variant'].includes(object.type)) {
		return null;
	}
	return { object: id, type: object.type, description: object.description ?? '', from: variantParent(drama, id) ?? null };
}

/** An asset card's picture strip: its pointers, its standing, and its versions the person has not discarded. Null with none. */
export function pictureOf(drama: Drama, id: string, src: (rel: string) => string): CanvasPicture | null {
	const object = drama.objects.get(id);
	if (!object?.versions.length) {
		return null;
	}
	const { resolved } = object;
	return {
		object: id, current: resolved.current, accepted: resolved.accepted, usable: object.usable, why: object.usable ? null : object.why,
		versions: object.versions.filter(v => !resolved.discarded.has(v.id)).map(v => {
			// A take's version is a video: its strip shows a frame of it, as its card does.
			const file = versionFile(object, v.id);
			const media = file ? mediaOf(file) : 'text';
			return { version: v.id, own: resolved.own(v), accepted: v.id === resolved.accepted, ...file && media !== 'text' ? { src: src(file), media } : { src: null, media: null } };
		}),
	};
}
