// What a version was made with, for the canvas's read-only detail panel and the seg editor: its prompt and the versions it was made from, in their order, as its version.json states them
// (doc/protocol.md, section 2.1). The model, settings and cost stay the Computer side's: they are not part of the
// protocol. No vscode import.

import { extname } from 'node:path';
import type { CanvasDetail } from './canvasProtocol';
import { versionFile, type Drama } from './project';

export const IMAGE_SUFFIXES: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * `object`'s version `version` as the panel shows it: its prompt, and each input numbered in its order, with the file
 * that input version shows, its picture's webview address (`src`) and its card. Null when the drama has no such version.
 */
export function versionDetail(drama: Drama, object: string, version: string, src: (rel: string) => string): CanvasDetail | null {
	const record = drama.objects.get(object)?.versions.find(v => v.id === version)?.record;
	if (!record) {
		return null;
	}
	return {
		prompt: record.prompt, madeAt: record.made_at,
		references: record.inputs.map((input, i) => {
			const used = drama.objects.get(input.object);
			const file = used ? versionFile(used, input.version) : null;
			return {
				n: i + 1, file, raw: `${input.object} ${input.version}`,
				src: file && IMAGE_SUFFIXES.has(extname(file).toLowerCase()) ? src(file) : null,
				stageId: drama.objects.has(input.object) ? input.object : null,
			};
		}),
	};
}
