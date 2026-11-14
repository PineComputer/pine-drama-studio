// What an object's shown file was made with, for the canvas's detail panel and the seg editor: its receipt
// (doc/protocol.md 2.3), read once in the read model (project.ts shownFileReceipt): its prompt, when it was finished,
// and the files it was sent, in their order, as the prompt's Image 1..N. And what its next draw request will send
// (object.json `objects_sent_by_draw_request`), the composer's references. No vscode import.

import { statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { madeBy, shortDate, type CanvasDetail, type CanvasPicture, type MadeFrom } from './canvasProtocol';
import { objectOwningFile, objectTitle, type ProjectObject, type ProjectReadModel } from './project';
import { listHistoryOfShownFile, writeBlobToFile } from './projectHistory';
import { sha256OfFileOnDisk } from './sha256';

const IMAGE_SUFFIXES: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** What a file is, as a card shows it: a picture, a take's video, or text. */
export function mediaOf(file: string): 'image' | 'video' | 'text' {
	const suffix = extname(file).toLowerCase();
	return IMAGE_SUFFIXES.has(suffix) ? 'image' : suffix === '.mp4' ? 'video' : 'text';
}

/**
 * `object`'s shown file as the panel shows it: its receipt's prompt and the files it was sent, in order, the pictures
 * numbered as the prompt's Image 1..N and the others by name, each with its card. A picture shows its thumbnail (`src`)
 * only while the project still holds the bytes it was sent (its receipt's sha256, doc/protocol.md 2.3); one changed
 * since shows none, and says so. Null for a file with no receipt: the person's own, a text, or none shown.
 */
export function receiptDetail(projectRoot: string, drama: ProjectReadModel, object: ProjectObject, src: (rel: string) => string): CanvasDetail | null {
	const receipt = object.shownFileReceipt;
	if (!receipt) {
		return null;
	}
	let images = 0;
	const sent = receipt.inputsSentInOrder.map(({ path, sha256 }) => {
		const owner = objectOwningFile(drama, path);
		const label = owner ? objectTitle(drama, owner) : path;
		if (mediaOf(path) !== 'image') { return { image: false, made: { label, src: null, stageId: owner ?? null } }; }
		const same = currentSha256(join(projectRoot, ...path.split('/'))) === sha256;
		return { image: true, made: { label: same ? label : `${label} (changed since)`, src: same ? src(path) : null, stageId: owner ?? null, n: ++images } };
	});
	return { prompt: receipt.promptSent, madeAt: receipt.finishedAt, pictures: sent.filter(i => i.image).map(i => i.made), madeFrom: sent.filter(i => !i.image).map(i => i.made) };
}

/**
 * What `object`'s next draw request sends (object.json `objects_sent_by_draw_request`), in order, each its Image N, with
 * its shown picture as the project holds it now and its card: the composer's references.
 */
export function nextDrawRequest(drama: ProjectReadModel, object: ProjectObject, src: (rel: string) => string): MadeFrom[] {
	return object.objectsSentByDrawRequest.map((id, i) => {
		const file = drama.objects.get(id)?.shownFile ?? null;
		return { label: objectTitle(drama, id), src: file && mediaOf(file) === 'image' ? src(file) : null, stageId: drama.objects.has(id) ? id : null, n: i + 1 };
	});
}

/**
 * `object`'s picture history for the composer's strip: one thumbnail per result of its shown file, newest first, the one
 * it shows Main (projectHistory.ts listHistoryOfShownFile), each written once from history to `storage` under its blob
 * id (writeBlobToFile) and shown at `src` of that file. Null with no picture or take shown, or no history.
 */
export async function pictureHistory(projectRoot: string, object: ProjectObject, storage: string, src: (file: string) => string): Promise<CanvasPicture | null> {
	const shown = object.shownFile;
	const media = shown ? mediaOf(shown) : 'text';
	if (!shown || media === 'text') { return null; }
	const history = await listHistoryOfShownFile(projectRoot, object.id);
	if (!history.length) { return null; }
	const versions = await Promise.all(history.map(async entry => {
		const file = join(storage, 'history', `${entry.blob}${extname(entry.file).toLowerCase()}`);
		await writeBlobToFile(projectRoot, entry.blob, file);
		return { commit: entry.commit, label: `${shortDate(entry.committedAt)} · ${madeBy(entry.author)}`, main: entry.shown, src: src(file), media: mediaOf(entry.file) };
	}));
	return { object: object.id, versions };
}

/** The sha256 each file was last found with, by path, with the size and time it had then. */
const hashed = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly sha256: string | null }>();

/**
 * A file's sha256 now, hashed again only when its size or modification time changed since, as git's index keeps each
 * file's stat data to know which to read again (git, "racy git"): the seg editor shows every take's inputs on each read.
 */
function currentSha256(file: string): string | null {
	const stat = statSync(file, { throwIfNoEntry: false });
	if (!stat) { return null; }
	const known = hashed.get(file);
	if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) { return known.sha256; }
	const sha256 = sha256OfFileOnDisk(file);
	hashed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
	return sha256;
}
