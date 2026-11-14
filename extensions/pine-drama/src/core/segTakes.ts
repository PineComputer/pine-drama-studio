// An episode's segments, their takes and keyframes, and its cut, from the read model (each object's `segment`,
// doc/protocol.md 2.2). The seg editor reads these. No vscode import.
import type { ProjectObject, ProjectReadModel } from './project';

export interface EpisodeSeg {
	readonly id: string;
	/** The seg's take object, or null when the project holds none. */
	readonly take: ProjectObject | null;
	/** Its keyframes, in id order. */
	readonly keyframes: readonly ProjectObject[];
}

const byId = (a: ProjectObject, b: ProjectObject) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The episode's (`EP001`) segments in order, each with its take and keyframes. */
export function episodeSegs(drama: ProjectReadModel, episode: string): EpisodeSeg[] {
	const own = [...drama.objects.values()].filter(o => o.episode === episode).sort(byId);
	const segs = [...new Set(own.map(o => o.segment).filter((s): s is string => s !== null))].sort();
	return segs.map(id => ({
		id,
		take: own.find(o => o.type === 'take' && o.segment === id) ?? null,
		keyframes: own.filter(o => o.type === 'keyframe' && o.segment === id),
	}));
}

/** The episode's cut object, or undefined. */
export function episodeCut(drama: ProjectReadModel, episode: string): ProjectObject | undefined {
	return [...drama.objects.values()].find(o => o.type === 'cut' && o.episode === episode);
}
