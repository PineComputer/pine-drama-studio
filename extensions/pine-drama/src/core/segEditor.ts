// The seg editor's model: an episode's segs, each with its take,
// what the shown take was made with, or before one its planned prompt, all from the drama (doc/protocol.md). The Studio
// writes no prompt text. No vscode import.

import { episodeIn, versionFile as shown, type Drama, type DramaObject } from './project';
import type { PlannedPrompt, Poster, Seg, SegEditorModel, SegTake } from './segEditorProtocol';
import { episodeCut, episodeSegs, shownTake, takeBadge, takeLabel } from './segTakes';
import { versionDetail } from './versionDetail';

export type { Seg, SegEditorModel };

/** An object's planned prompt: the person's where set, else the agent's; null when there is none. */
export function plannedPrompt(drama: Drama, object: DramaObject): PlannedPrompt | null {
	const person = drama.choices?.objects[object.id]?.prompt;
	return person !== undefined ? { by: 'person', text: person } : object.prompt ? { by: 'agent', text: object.prompt } : null;
}

/**
 * The request to shoot a seg, put in its episode's session's input for the person to send: the seg editor's Generate
 * and Regenerate (`again`, a new take), and a take card's Generate on the canvas. It asks for no second yes: BUDGET
 * (instructions.ts) covers the cost.
 */
export function shootRequest(episode: string, seg: string, again: boolean): string {
	return `Shoot ${again ? `a new take of ${episode} ${seg}` : `${episode} ${seg}`}.`;
}


/** The episode's (`EP001`) segs. `uri` is a project file's webview address. */
export function segEditorModel(drama: Drama, episode: string, uri: (file: string) => string): SegEditorModel {
	const segs: Seg[] = episodeSegs(drama, episode).map(seg => {
		const object = seg.take;
		const take = object && shownTake(object);
		const video = object && take ? shown(object, take) : null;
		const frame = seg.keyframes.map(k => shown(k, k.resolved.current)).find(Boolean) ?? null;
		const poster: Poster | null = video ? { media: 'video', src: uri(video) } : frame ? { media: 'image', src: uri(frame) } : null;
		return {
			id: seg.id, take: object?.id ?? null,
			takes: object ? object.versions.filter(v => !object.resolved.discarded.has(v.id)).map((v): SegTake => {
				const file = shown(object, v.id);
				return { version: v.id, label: takeLabel(object, v.id), src: file ? uri(file) : null, request: versionDetail(drama, object.id, v.id, uri) };
			}) : [],
			shown: take ?? null,
			planned: object && !take ? plannedPrompt(drama, object) : null,
			badge: takeBadge(object), poster,
		};
	});
	const cutObject = episodeCut(drama, episode);
	const accepted = cutObject?.resolved.accepted ?? null;
	const cutFile = cutObject && accepted ? shown(cutObject, accepted) : null;
	const observed = [...drama.objects.values()].find(o => episodeIn(o.id) === episode)?.observedAt ?? null;
	return { episode, segs, cut: accepted ? { version: accepted, src: cutFile ? uri(cutFile) : null } : null, observedAt: observed };
}
