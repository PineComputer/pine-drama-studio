// What a version was made with, for the canvas's read-only detail panel and the seg editor: its prompt and the versions it was made from, as its version.json states them
// (doc/protocol.md, section 2.1). The model, settings and cost stay the Computer side's: they are not part of the
// protocol. No vscode import.

import { extname } from 'node:path';
import type { CanvasDetail, MadeFrom } from './canvasProtocol';
import { directInputs, versionFile, versionTitle, type Drama } from './project';

export const IMAGE_SUFFIXES: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * `object`'s version `version` as the panel shows it: its prompt, and the versions it was made from directly, in order, the
 * pictures with their webview address (`src`) and the others by name, each with its card. No input is numbered as the
 * prompt's "Image N": that counts the request's images, in an order the record does not give (#77). Null when the drama
 * has no such version.
 */
export function versionDetail(drama: Drama, object: string, version: string, src: (rel: string) => string): CanvasDetail | null {
	const record = drama.objects.get(object)?.versions.find(v => v.id === version)?.record;
	if (!record) {
		return null;
	}
	const inputs: MadeFrom[] = directInputs(drama, record.inputs).map(input => {
		const used = drama.objects.get(input.object);
		const file = used ? versionFile(used, input.version) : null;
		return {
			label: versionTitle(drama, input.object, input.version),
			src: file && IMAGE_SUFFIXES.has(extname(file).toLowerCase()) ? src(file) : null,
			stageId: drama.objects.has(input.object) ? input.object : null,
		};
	});
	return { prompt: record.prompt, madeAt: record.made_at, pictures: inputs.filter(i => i.src), madeFrom: inputs.filter(i => !i.src) };
}
