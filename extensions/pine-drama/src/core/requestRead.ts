// The images a request sent, in the order the model was given them ("Image 1".."Image N" in its prompt), each as the
// project file it is, read from drama-cli's own records in the version's folder: the old seg editor's reader
// (pine-drama-studio-archieve #425 requestRead.ts and versionDetail.ts, #539 the first-frame slot), ported. Display
// only: what it cannot read or resolve is left unnumbered, never guessed and never an error. No vscode import.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaOf } from './versionDetail';

/** One image a request sent: its number in the prompt, and the project file it is, when the records say. */
export interface SentImage {
	readonly n: number;
	readonly file: string | null;
}

export interface SentRequest {
	readonly images: readonly SentImage[];
	/**
	 * The frame the request starts from where the records name it by version only: a take's `drama.first_frame` (shoot
	 * places that version of the segment's shot 1 keyframe as Image 1, short_drama stages.py `_place_image`, D166), or
	 * a compiled request whose text keeps Image 1 for the first frame (FIRST_FRAME_LINE) and numbers its own images from
	 * 2: `shoot` adds that frame, shot 1's keyframe (stages.first_frame_slot, doc/drama-cli/image-references.md). Null
	 * otherwise. `version` null: the keyframe's working version, the one shoot would send.
	 */
	readonly firstFrame: { readonly n: 1; readonly version: string | null } | null;
}

/** The line a compiled seg request opens its references with when its Image 1 is the first frame (stages.FIRST_FRAME_LINE). */
const FIRST_FRAME_LINE = 'Image 1 is the first frame.';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The request in `dir` (project-relative, or absolute for a downloaded version) as sent: a take's or a picture's
 * `spec.json`, or a seg's `<seg>.json` in a video-prompts version. Null when it has none or it cannot be read.
 * @param at where a project-relative path is on this machine, a downloaded version's file in its preview folder
 */
export async function sentRequest(at: (path: string) => string, dir: string, specFile = 'spec.json'): Promise<SentRequest | null> {
	// A file read by where it is (`at`); one missing or malformed reads as nothing.
	const read = (file: string): Promise<unknown> => readFile(file, 'utf8').then(raw => JSON.parse(raw) as unknown).catch(() => undefined);
	const [spec, artifact] = await Promise.all([read(join(at(dir), specFile)), read(join(at(dir), 'artifact.json'))]);
	if (spec === undefined) {
		return null;
	}
	const s = record(spec);
	const drama = record(s.drama);
	// The files the request used, with their sha256: its version's artifact.json `dependencies`, and the request's own
	// `drama.lineage`, the files drama-cli pins in it.
	const pinned = [...new Set([...list(record(artifact).dependencies), ...list(drama.lineage)].map(d => text(record(d).path)).filter((p): p is string => !!p))];
	// An `asset://` reference is the file its upload record names by sha256: the version's `asset/job.json` or its
	// registration in the asset library, each pinned in the lineage (schemas/job.py AssetJob: asset_uri, sha256); a
	// newer request also maps its assets itself (`drama.asset_files`).
	const uploads = await Promise.all(pinned.filter(p => p.endsWith('/job.json')).map(p => read(at(p))));
	const assets = new Map<string, string>([
		...uploads.map(record).filter(u => u.kind === 'asset' && text(u.asset_uri) && text(u.sha256)).map(u => [u.asset_uri as string, u.sha256 as string] as const),
		...Object.entries(record(drama.asset_files)).filter((e): e is [string, string] => typeof e[1] === 'string'),
	]);
	// The file an upload is: the pinned picture whose bytes in this project have its sha256, read only when the request
	// sent one; a file that is missing or changed resolves to nothing, never to a guess (the archive's assetFiles).
	const hashed = new Map<string, string>();
	if (assets.size) {
		for (const path of pinned.filter(p => mediaOf(p) === 'image')) {
			const sha = await readFile(at(path)).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(() => null);
			if (sha && !hashed.has(sha)) { hashed.set(sha, path); }
		}
	}
	const resolve = (url: string): string | null => {
		if (url.startsWith('asset://')) {
			return hashed.get(assets.get(url) ?? '') ?? null;
		}
		// A path as the machine that sent it wrote it, a Windows one included, is the pinned file it ends with.
		const path = url.replace(/^@/, '').replace(/\\/g, '/');
		return pinned.find(p => path === p || path.endsWith(`/${p}`)) ?? null;
	};
	// The images in the request's own form: a Seedance request's image_url content items, a Wan request's
	// reference_image media, a MuleRouter request's reference_images, a picture spec's `images`.
	const urls = [
		...list(s.content).map(record).filter(i => i.type === 'image_url').map(i => record(i.image_url).url),
		...list(record(s.input).media).map(record).filter(i => i.type === 'reference_image').map(i => i.url),
		...list(s.reference_images),
		...list(s.images),
	].map(url => text(url) ?? '');
	// The prompt in the same forms: a picture spec's or MuleRouter's `prompt`, Wan's `input.prompt`, Seedance's text items.
	const prompt = [text(s.prompt), text(record(s.input).prompt), ...list(s.content).map(record).filter(i => i.type === 'text').map(i => text(i.text))].filter(Boolean).join('\n');
	const kept = prompt.split('\n').some(line => line.trim() === FIRST_FRAME_LINE) && !text(drama.first_frame);
	const offset = kept ? 1 : 0;
	const images = urls.map((url, i) => ({ n: i + 1 + offset, file: resolve(url) }));
	const firstFrame = kept ? { n: 1 as const, version: null } : text(drama.first_frame) && images[0] && !images[0].file ? { n: 1 as const, version: drama.first_frame as string } : null;
	return { images, firstFrame };
}
