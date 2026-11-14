// What a version was made with, for the canvas's read-only detail panel and the seg editor: its prompt and the versions it was made from, as its version.json states them
// (doc/protocol.md, section 2.1); and, for display only, the model and settings of the request the Computer side saved
// beside it, or planned for a node not drawn yet. No vscode import.

import { readdir, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import type { CanvasDetail, MadeFrom, MadeWith } from './canvasProtocol';
import { episodeIn, fileIn, versionFile, versionFolder, versionTitle, type Drama, type DramaObject } from './project';
import { sentRequest } from './requestRead';

export const IMAGE_SUFFIXES: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * `object`'s version `version` as the panel shows it: its prompt, and every version its record lists it was made from
 * (doc/protocol.md 2.1), in order, the pictures with their webview address (`src`) and the others by name, each with its
 * card. The record gives no order: requestDetail numbers them by the request they were sent with. Null when the drama
 * has no such version.
 */
export function versionDetail(drama: Drama, object: string, version: string, src: (rel: string) => string): CanvasDetail | null {
	const record = drama.objects.get(object)?.versions.find(v => v.id === version)?.record;
	if (!record) {
		return null;
	}
	const inputs: MadeFrom[] = record.inputs.map(input => {
		const used = drama.objects.get(input.object);
		const unlisted = drama.unlisted.get(`${input.object}/${input.version}`);
		const file = used ? versionFile(used, input.version) : unlisted ? fileIn(unlisted.folder, unlisted.file) : null;
		return {
			label: versionTitle(drama, input.object, input.version),
			src: file && IMAGE_SUFFIXES.has(extname(file).toLowerCase()) ? src(file) : null,
			stageId: drama.objects.has(input.object) ? input.object : null,
		};
	});
	return { prompt: record.prompt, madeAt: record.made_at, pictures: inputs.filter(i => i.src), madeFrom: inputs.filter(i => !i.src) };
}

/**
 * What `object`'s version `version` was made with (versionDetail), its pictures numbered as the prompt's "Image N" by the
 * request it was sent with (requestRead.ts), those first, in order, then any other picture it lists, unnumbered; the
 * rest by name. A seg not shot yet (`version` null) shows its compiled request's pictures, from its episode's working
 * video prompts. Where no request is read, the pictures stay as versionDetail lists them; never an error.
 */
export async function requestDetail(drama: Drama, root: string, object: DramaObject, version: string | null, src: (rel: string) => string): Promise<CanvasDetail | null> {
	const recorded = version ? versionDetail(drama, object.id, version, src) : null;
	const prompts = !version && object.type === 'take' && object.segment ? drama.objects.get(`episodes/${episodeIn(object.id)}/video_prompts`) : undefined;
	const at = (path: string) => { const file = located(drama, path); return isAbsolute(file) ? file : join(root, ...file.split('/')); };
	const sent = version ? await sentRequest(at, versionFolder(object, version))
		: prompts?.resolved.current ? await sentRequest(at, versionFolder(prompts, prompts.resolved.current), `${object.segment}.json`) : null;
	if (!sent) {
		return recorded;
	}
	const numbered = sent.images.flatMap(image => image.file ? [{ ...picture(drama, image.file, src), n: image.n }] : []);
	const frame = sent.firstFrame && firstFrame(drama, object, sent.firstFrame.version);
	const pictures = [...frame ? [{ ...picture(drama, frame, src), n: 1 }] : [], ...numbered];
	const others = (recorded?.pictures ?? []).filter(p => !pictures.some(q => q.src === p.src));
	return { prompt: recorded?.prompt ?? null, madeAt: recorded?.madeAt ?? null, pictures: [...pictures, ...others], madeFrom: recorded?.madeFrom ?? [] };
}

/**
 * A project file's version: the version folder of the drama that holds it (`<object>/<version>/<file>`, a listed
 * object's or an unlisted input's), the deepest one; null for a file in none.
 */
function versionOf(drama: Drama, file: string): { object: string; version: string; rest: string } | null {
	const parts = file.split('/');
	for (let at = parts.length - 2; at > 0; at--) {
		const object = parts.slice(0, at).join('/');
		if (drama.objects.get(object)?.versions.some(v => v.id === parts[at]) || drama.unlisted.has(`${object}/${parts[at]}`)) {
			return { object, version: parts[at], rest: parts.slice(at + 1).join('/') };
		}
	}
	return null;
}

/**
 * Where a project file is: in its version's folder (versionFolder), a downloaded version's being its preview folder,
 * for a listed object or an unlisted one; as it is otherwise.
 */
function located(drama: Drama, file: string): string {
	const of = versionOf(drama, file);
	const object = of && drama.objects.get(of.object);
	const folder = of && (object ? versionFolder(object, of.version) : drama.unlisted.get(`${of.object}/${of.version}`)?.folder);
	return of && folder ? fileIn(folder, of.rest) : file;
}

/** A file a request pinned (project-relative) as a picture it was made from: its version's title and card where the drama holds them. */
function picture(drama: Drama, file: string, src: (rel: string) => string): MadeFrom {
	const of = versionOf(drama, file);
	const object = of && drama.objects.get(of.object);
	return {
		label: object ? versionTitle(drama, object.id, of.version) : file,
		src: IMAGE_SUFFIXES.has(extname(file).toLowerCase()) ? src(located(drama, file)) : null,
		stageId: object?.id ?? null,
	};
}

/**
 * The picture a seg starts from, `version` of its shot 1 keyframe, or when null the version shoot would send, its
 * accepted one (short_drama stages.py `_first_frame_items`, plan.py `_accepted_current`) (requestRead.ts SentRequest.firstFrame).
 */
function firstFrame(drama: Drama, take: DramaObject, version: string | null): string | null {
	const prefix = `episodes/${episodeIn(take.id)}/keyframe/${take.segment}/`;
	const shot1 = [...drama.objects.values()].find(o => o.id.startsWith(prefix) && Number(o.id.slice(prefix.length).replace(/\D/g, '')) === 1);
	const shown = version ?? shot1?.resolved.accepted;
	const file = shown && shot1?.versions.find(v => v.id === shown)?.record.file;
	// Project-relative, as a request pins a file (picture() finds a downloaded one's preview).
	return shot1 && file ? `${shot1.id}/${shown}/${file}` : null;
}

/**
 * The request fields shown for a picture or a video, by the `kind` and `provider` drama-cli records in a version's
 * job.json, each in its provider's own name: the OpenAI Images API (size, quality, n), ModelArk's image generation
 * (size) and video generation task (ratio, resolution, duration), Model Studio's Wan 3.0 task (its `parameters`) and
 * MuleRouter's berry-1.0 task. The model is job.json's: MuleRouter's request names it only in its path.
 */
const SHOWN: Readonly<Record<string, readonly string[]>> = {
	'image:openai': ['size', 'quality', 'n'],
	'image:seedream': ['size'],
	'video:ark': ['ratio', 'resolution', 'duration'],
	'video:dashscope': ['parameters.resolution', 'parameters.ratio', 'parameters.duration'],
	'video:mulerouter': ['resolution', 'ratio', 'duration'],
};

/**
 * The planned request's fields shown before a node is drawn, by the provider its model names (`<provider>:<model>`):
 * an image's `aspect`, then from its `parameters`, which drama-cli fills by the provider's own names from the code that
 * builds the request (short_drama doc/drama-cli/prompts-before-pictures.md), its size, image_size or resolution and
 * quality; a video's resolution, ratio and duration. A field the record lacks (one written before `parameters`) is
 * left out. Each call makes one image or one video, so no count. A Map, so only these providers are found.
 */
const PLANNED: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
	openai: ['aspect', 'parameters.size', 'parameters.quality'],
	openai_compatible: ['aspect', 'parameters.size', 'parameters.quality'],
	seedream: ['aspect', 'parameters.size'],
	gemini: ['aspect', 'parameters.image_size'],
	wavespeed: ['aspect', 'parameters.resolution'],
	ark: ['parameters.resolution', 'parameters.ratio', 'parameters.duration'],
	dashscope: ['parameters.resolution', 'parameters.ratio', 'parameters.duration'],
	mulerouter: ['parameters.resolution', 'parameters.ratio', 'parameters.duration'],
}));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A missing or malformed file is an ordinary case here (an import has no request): it shows nothing.
const readJson = (path: string): Promise<unknown> => readFile(path, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null);

/** A setting as a person reads it, by its field's name: "2048×1152", "1 image", "19 s"; any other as its value. */
const LABEL: Readonly<Record<string, (value: string | number) => string>> = {
	size: value => String(value).replace('x', '×'),
	n: value => `${value} image${value === 1 ? '' : 's'}`,
	duration: value => `${value} s`,
};

/** `request`'s scalar `fields`, each as LABEL reads it by the last part of its path; a field it lacks is left out. */
function settingsOf(request: Record<string, unknown>, fields: readonly string[]): string[] {
	return fields.flatMap(path => {
		const value = path.split('.').reduce<unknown>((at, key) => isRecord(at) ? at[key] : undefined, request);
		const label = LABEL[path.split('.').pop()!] ?? String;
		return typeof value === 'string' || typeof value === 'number' ? [label(value)] : [];
	});
}

/**
 * The model and settings the version in `folder` was made with, read from the Computer side's job.json and request.json
 * for display only (doc/protocol.md, section 2.1): never used for a decision. Null for any version they do not describe
 * as a table above does: none saved (an import), unreadable, or another kind or provider.
 */
export async function madeWith(folder: string): Promise<MadeWith | null> {
	const [job, request] = await Promise.all([readJson(join(folder, 'job.json')), readJson(join(folder, 'request.json'))]);
	const fields = isRecord(job) && SHOWN[`${job.kind}:${job.provider}`];
	if (!fields || !isRecord(request) || typeof job.model !== 'string') {
		return null;
	}
	return { model: job.model, settings: settingsOf(request, fields) };
}

/**
 * The model and settings planned for the object in `folder` before it is drawn: its latest prompt record's `request`
 * (drama-project prompts.py: `prompts/vN/prompt.json`), read for display only like madeWith. Null with no record, or
 * one that names no model.
 */
export async function plannedWith(folder: string): Promise<MadeWith | null> {
	const versions = await readdir(join(folder, 'prompts')).catch(() => []);
	const latest = versions.filter(name => /^v\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
	const record = latest && await readJson(join(folder, 'prompts', latest, 'prompt.json'));
	const request = isRecord(record) && record.request;
	if (!isRecord(request) || typeof request.model !== 'string') {
		return null;
	}
	// `<provider>:<model>`, shown as the model alone, as a drawn version's is.
	const colon = request.model.indexOf(':');
	const provider = request.model.slice(0, Math.max(colon, 0));
	return { model: request.model.slice(colon + 1), settings: settingsOf(request, PLANNED.get(provider) ?? []) };
}
