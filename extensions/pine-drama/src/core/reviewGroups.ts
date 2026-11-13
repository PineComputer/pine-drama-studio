import { episodeIn } from './project';
import type { ReviewItem, ReviewView } from './reviews';
// The Review index follows the window's project, independently of the selected Chat.
export function projectReviewKeys(chats: readonly { key: string; folder: string | null }[], root: string | undefined): string[] {
	return root ? chats.filter(c => c.folder === root).map(c => c.key) : [];
}

// ---- the Review index's groups ("Review index grouped by episode", approved 2026-11-06) ----

/** Project-wide reviews' group, listed before the episodes. */
export const PROJECT_GROUP = 'Project';

interface ReviewIndexRow<T> {
	readonly entry: T;
	/** What tells the row apart in its group: the segments its items name, or the episodes of a review that spans several. */
	readonly span: string | undefined;
}
export interface ReviewIndexGroup<T> {
	/** `Project`, or a drama-cli episode id (`EP001`). */
	readonly id: string;
	/** Batches not yet successfully submitted; a draft with every item decided still waits. */
	readonly waiting: number;
	readonly rows: readonly ReviewIndexRow<T>[];
}

/** The project-relative paths an item stands for: its targets' objects, else its files (under drama/). */
function pathsOf(item: ReviewItem): string[] {
	return item.targets?.length ? item.targets.map(t => t.object) : item.files.map(f => f.relPath.replace(/^drama\//, ''));
}

/** Consecutive segments as one run (`seg01–seg03`), others each (`seg01, seg04`); a lettered id stands alone. */
function segmentSpan(ids: readonly string[]): string | undefined {
	const sorted = [...new Set(ids)].sort();
	const runs: string[][] = [];
	for (const id of sorted) {
		const run = runs.at(-1);
		const last = run?.at(-1);
		const n = /^seg(\d+)$/.exec(id)?.[1];
		const previous = last && /^seg(\d+)$/.exec(last)?.[1];
		if (run && n && previous && Number(n) === Number(previous) + 1) { run.push(id); } else { runs.push([id]); }
	}
	return runs.length ? runs.map(run => run.length > 1 ? `${run[0]}–${run.at(-1)}` : run[0]).join(', ') : undefined;
}

/**
 * The Review index's groups: a review goes under the episode its items' drama-cli paths name (`episodes/<EP>/…`), or
 * under Project for any other path; one whose items fall in more than one group goes once under Project, naming its
 * episodes, since a review is one decision with one card. Project first, then episodes by id; inside a group, waiting
 * batches first, then the newest.
 */
export function reviewIndexGroups<T extends { readonly review: ReviewView }>(entries: readonly T[]): ReviewIndexGroup<T>[] {
	const groups = new Map<string, ReviewIndexRow<T>[]>();
	for (const entry of entries) {
		const paths = entry.review.items.flatMap(pathsOf);
		const homes = new Set(paths.map(path => episodeIn(path) ?? PROJECT_GROUP));
		const id = homes.size === 1 ? [...homes][0] : PROJECT_GROUP;
		const episodes = [...homes].filter(home => home !== PROJECT_GROUP).sort();
		const span = homes.size > 1 && episodes.length
			? episodes.join(', ')
			: segmentSpan(paths.flatMap(path => /(?:^|\/)(seg\d+[a-z]*)(?=\/|$)/.exec(path)?.[1] ?? []));
		groups.set(id, [...(groups.get(id) ?? []), { entry, span }]);
	}
	const waiting = (row: ReviewIndexRow<T>) => !row.entry.review.submitted;
	return [...groups.entries()]
		.sort(([a], [b]) => (a === PROJECT_GROUP ? -1 : b === PROJECT_GROUP ? 1 : a.localeCompare(b)))
		.map(([id, rows]) => ({
			id,
			waiting: rows.filter(waiting).length,
			rows: [...rows].sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || b.entry.review.createdAt.localeCompare(a.entry.review.createdAt)),
		}));
}
