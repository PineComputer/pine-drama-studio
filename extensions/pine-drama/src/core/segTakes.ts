// An episode's segments, their takes and keyframes, and its cut, from the drama (doc/protocol.md, section 5.1: each
// object's `segment`; versions and acceptance from the files and choices.json). The seg editor reads these. No vscode
// import.
import { episodeIn, type Drama, type DramaObject } from './project';

export interface EpisodeSeg {
	readonly id: string;
	/** The seg's take object, or null when the snapshot lists none. */
	readonly take: DramaObject | null;
	/** Its keyframes, in id order. */
	readonly keyframes: readonly DramaObject[];
}

const byId = (a: DramaObject, b: DramaObject) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The episode's (`EP001`) segments in order, each with its take and keyframes. */
export function episodeSegs(drama: Drama, episode: string): EpisodeSeg[] {
	const own = [...drama.objects.values()].filter(o => episodeIn(o.id) === episode).sort(byId);
	const segs = [...new Set(own.map(o => o.segment).filter((s): s is string => s !== null))].sort();
	return segs.map(id => ({
		id,
		take: own.find(o => o.type === 'take' && o.segment === id) ?? null,
		keyframes: own.filter(o => o.type === 'keyframe' && o.segment === id),
	}));
}

/** The episode's cut object, or undefined. */
export function episodeCut(drama: Drama, episode: string): DramaObject | undefined {
	return [...drama.objects.values()].find(o => o.type === 'cut' && episodeIn(o.id) === episode);
}

/** The take a seg shows: its accepted one, else its current one (the person's rule, E4). */
export function shownTake(take: DramaObject): string | null {
	return take.resolved.accepted ?? take.resolved.current;
}

/** A seg's badge in the strip: accepted, waiting for review, being made, or not generated. */
export function takeBadge(take: DramaObject | null): string {
	if (take?.resolved.accepted) {
		return 'Approved';
	}
	if (take?.resolved.current) {
		return 'Waiting for review';
	}
	return take?.making ? 'Being made' : 'Not generated';
}

/** A take's standing among its seg's takes (doc/protocol.md, section 3.2). */
export function takeLabel(take: DramaObject, version: string): string {
	return version === take.resolved.accepted ? 'Approved' : version === take.resolved.current ? 'Waiting for review' : 'Earlier take';
}
