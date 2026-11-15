// The seg editor's model: an episode's segs, each with its take, what the take was made with (its receipt), and its
// prompt, all from the read model (core/project.ts). The Studio writes no prompt text. No vscode import.

import { notMadeText } from './canvasProtocol';
import type { ProjectReadModel } from './project';
import type { Poster, Seg, SegEditorModel } from './segEditorProtocol';
import { episodeCut, episodeSegs } from './segTakes';
import { receiptDetail } from './versionDetail';

export type { Seg, SegEditorModel };

/**
 * The request to shoot a seg, put in its episode's session's input for the person to send: the seg editor's Generate
 * and Regenerate (`again`, a new take), and a take card's Generate on the canvas. It asks for no second yes: BUDGET
 * (instructions.ts) covers the cost.
 */
export function shootRequest(episode: string, seg: string, again: boolean): string {
	return `Shoot ${again ? `a new take of ${episode} ${seg}` : `${episode} ${seg}`}.`;
}


/** The episode's (`EP001`) segs of the project at `projectRoot`. `uri` is a project file's webview address. */
export async function segEditorModel(projectRoot: string, drama: ProjectReadModel, episode: string, uri: (file: string) => string): Promise<SegEditorModel> {
	const segs: Seg[] = await Promise.all(episodeSegs(drama, episode).map(async seg => {
		const object = seg.take;
		const video = object?.shownFile ?? null;
		const frame = seg.keyframes.map(k => k.shownFile).find(Boolean) ?? null;
		const poster: Poster | null = video ? { media: 'video', src: uri(video) } : frame ? { media: 'image', src: uri(frame) } : null;
		return {
			id: seg.id, take: object?.id ?? null, src: video ? uri(video) : null,
			request: object ? await receiptDetail(projectRoot, drama, object, uri) : null, prompt: object?.prompt ?? null,
			badge: video ? '' : notMadeText('take'), poster,
		};
	}));
	const cut = episodeCut(drama, episode)?.shownFile ?? null;
	return { episode, segs, cut: cut ? { src: uri(cut) } : null };
}
