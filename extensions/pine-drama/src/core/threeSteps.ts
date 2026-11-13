// The three steps' words that are not objects: an episode's
// decomposition under Script, which steps are reached, and the kinds' counts, all from the drama. No vscode import.

import { kindCount } from './assetStatus';
import type { Collection } from './galleryProtocol';
import type { Drama, DramaObject, OutlineNode } from './project';

/** An episode's decomposition under Script: the label for its row, and whether "Go to episode" applies. */
interface Decomposition {
	readonly text: string;
	readonly decomposed: boolean;
}

/** An episode's breakdown: none is "Not decomposed"; usable is "Decomposed"; else the snapshot's `why`. */
export function decomposition(breakdown: DramaObject | undefined): Decomposition {
	if (!breakdown?.versions.length) {
		return { text: 'Not decomposed', decomposed: false };
	}
	return breakdown.usable ? { text: 'Decomposed', decomposed: true } : { text: breakdown.why ?? 'not usable yet', decomposed: false };
}

/** Which of the later steps are reached (DESIGN-2026-11-08; the flow; 11). */
interface OpenSteps {
	readonly assets: boolean;
	readonly episodes: boolean;
}

/** 2. Assets opens once the drama has an asset; 3. Episodes once an episode's breakdown is accepted. */
export function openSteps(drama: Drama): OpenSteps {
	const objects = [...drama.objects.values()];
	return {
		assets: objects.some(o => o.type === 'character' || o.type === 'scene' || o.type === 'prop'),
		episodes: objects.some(o => o.type === 'breakdown' && o.resolved.accepted !== null),
	};
}

/** A row of the tree shown locked: a step not reached yet, or a group whose feature does not exist yet. */
interface Lock {
	readonly description: string;
	readonly tooltip: string;
}

/**
 * The locked rows (627/628: as Pippit shows its later steps): 2. Assets before any asset, 3. Episodes before
 * a breakdown is accepted, and audio and motion until drama-cli has their stages. Null for a row that is open.
 */
export function lockOf(id: string, open: OpenSteps): Lock | null {
	if (id === '#assets' && !open.assets) {
		return { description: 'available after the bible', tooltip: 'Available after the bible: it lists every character, scene and prop' };
	}
	if (id === 'episodes' && !open.episodes) {
		return { description: 'available after the episodes are broken down', tooltip: "Available once an episode's breakdown is approved; each episode opens in its seg editor" };
	}
	if (id === '#audio') {
		// drama-cli has no voice stage: a voice is the bible's text.
		return { description: 'not in this build', tooltip: "Each character's voice is the bible's text for now: drama-cli has no voice stage yet" };
	}
	if (id === '#motion') {
		return { description: 'not in this build', tooltip: "Clips from the preset's motion-reference library: not listed in this build yet" };
	}
	return null;
}

/**
 * A file the tree has no row for but whose object Versions still follows: the bible's, since the bible has no row of
 * its own. The node is detached: Versions shows it, the tree selects nothing.
 */
export function detachedStage(drama: Drama, path: string): (OutlineNode & { readonly detached: true }) | undefined {
	const bible = [...drama.objects.values()].find(o => o.type === 'bible' && (path === o.id || path.startsWith(`${o.id}/`)));
	return bible ? { id: bible.id, label: 'Bible', kind: 'stage', role: 'bible', stagePath: bible.id, hasChildren: false, detached: true } : undefined;
}

/** A kind's row under Assets: how many assets, and how many of their objects are still to be set. */
export function kindRow(kind: Collection, drama: Drama): { description: string; tooltip: string } {
	const { assets, toSet } = kindCount(drama, kind);
	return {
		description: [`${assets}`, toSet ? `${toSet} to set` : ''].filter(Boolean).join(' · '),
		tooltip: `${assets} ${kind}; ${toSet} of their pictures still to be set`,
	};
}
