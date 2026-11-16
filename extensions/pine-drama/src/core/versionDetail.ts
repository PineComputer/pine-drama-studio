// What an object's shown file was made with, for the canvas's detail panel and the seg editor: its receipt
// (doc/protocol.md 2.3), read once in the read model (project.ts shownFileReceipt): its prompt, when it was finished,
// and the files it was sent, in their order, as the prompt's Image 1..N. And what its next draw request will send
// (object.json `objects_sent_by_draw_request`), the composer's references. No vscode import.

import { extname, join } from 'node:path';
import { madeBy, shortDate, type CanvasDetail, type CanvasPicture, type MadeFrom } from './canvasProtocol';
import { objectOwningFile, objectTitle, type ProjectObject, type ProjectReadModel } from './project';
import { listHistoryOfShownFile, writeBlobToFile } from './projectHistory';
import { sha256OfFile } from './sha256';

const IMAGE_SUFFIXES: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** What a file is, as a card shows it: a picture, a take's video, or text. */
export function mediaOf(file: string): 'image' | 'video' | 'text' {
	const suffix = extname(file).toLowerCase();
	return IMAGE_SUFFIXES.has(suffix) ? 'image' : suffix === '.mp4' ? 'video' : 'text';
}

/**
 * `object`'s shown file as the panel shows it: its receipt's prompt and the files it was sent, in order, the pictures
 * numbered as the prompt's Image 1..N, the videos as its Video 1..N (a take's motion reference, which drama-cli sends
 * as Video 1 and records among the files sent) and the others by name, each with its card. A picture or a video shows
 * itself (`src`) only while the project still holds the bytes it was sent (its receipt's sha256, doc/protocol.md 2.3);
 * one changed since shows none, and says so. Null for a file with no receipt: the person's own, a text, or none shown.
 */
export async function receiptDetail(projectRoot: string, drama: ProjectReadModel, object: ProjectObject, src: (rel: string) => string): Promise<CanvasDetail | null> {
	const receipt = object.shownFileReceipt;
	if (!receipt) {
		return null;
	}
	const counted = { image: 0, video: 0 };
	const same = await Promise.all(receipt.inputsSentInOrder.map(async ({ path, sha256 }) => mediaOf(path) !== 'text' && await sha256OfFile(join(projectRoot, ...path.split('/'))) === sha256));
	const sent = receipt.inputsSentInOrder.map(({ path }, i) => {
		const owner = objectOwningFile(drama, path);
		const label = owner ? objectTitle(drama, owner) : path;
		const media = mediaOf(path);
		if (media === 'text') { return { media, made: { label, src: null, stageId: owner ?? null } }; }
		return { media, made: { label: same[i] ? label : `${label} (changed since)`, src: same[i] ? src(path) : null, stageId: owner ?? null, n: ++counted[media] } };
	});
	const of = (media: string) => sent.filter(i => i.media === media).map(i => i.made);
	return { prompt: receipt.promptSent, madeAt: receipt.finishedAt, pictures: of('image'), videos: of('video'), madeFrom: of('text') };
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
