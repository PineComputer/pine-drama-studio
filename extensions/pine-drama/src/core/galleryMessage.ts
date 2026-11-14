// An asset grid's page message, built from the read model (assetStatus.ts): what the galleries post (galleries.ts) and what
// the render smoke test posts, one builder for both. No vscode import: webview addresses come from `src`.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assetGrid } from './assetStatus';
import { GALLERY_PROTOCOL, type Collection, type ToGallery } from './galleryProtocol';
import type { ProjectReadModel } from './project';

export interface GalleryRead {
	readonly root: string;
	readonly drama: ProjectReadModel;
	readonly kind: Collection;
	/** The webview's address of a project file. */
	src(rel: string): string;
}

export async function galleryPageMessage(read: GalleryRead): Promise<Extract<ToGallery, { type: 'page' }>> {
	const exists = (rel: string) => stat(join(read.root, ...rel.split('/'))).then(() => true, () => false);
	const grid = assetGrid(read.drama, read.kind);
	const tiles = await Promise.all(grid.tiles.map(async t => ({
		...t,
		src: t.file && await exists(t.file) ? read.src(t.file) : null,
	})));
	return {
		v: GALLERY_PROTOCOL, type: 'page', title: read.kind, kind: read.kind,
		note: null,
		sections: [{ title: grid.title, ...(grid.add ? { add: grid.add } : {}), tiles }],
	};
}
