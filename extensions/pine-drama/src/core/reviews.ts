// Human review uses explicit, version-bound stop targets. Draft verdicts are not
// acceptance. The local CLI records the person's decision; answerText formats feedback for remote continuation,
// retaining open-pinedrama's established approve/send-back wording (main 3e7dc81, engine/decisions.ts). No vscode import.

import type { ObjectType } from './protocol';
import type { ReviewRow } from './store';
import type { ReviewTarget } from './resultImporter';

export type Verdict = 'approve' | 'revise';

/** What a stop asks for (main ReviewKind). Another feature may use its own string. */
type ReviewKind = 'looks' | 'references' | 'storyboards' | 'takes' | 'cut' | 'bible' | 'breakdowns' | 'question' | (string & {});

export interface ReviewFile {
	/** The library row; 0 for a file of a stop still being saved (its row comes when it is here). */
	id: number;
	relPath: string;
	type: string;
	/** Its SHA-256 as the stop returned it, for a review made before the stop's files were all saved. */
	sha?: string;
	/** Computed when the review is read, never stored: false while its bytes are not here yet. */
	here?: boolean;
}

export interface ReviewItem {
	key: string;
	label: string;
	files: ReviewFile[];
	/** The versions the stop's return asks the person to choose (doc/protocol.md, 4.3, `review`); none for a file shown only. */
	targets?: ReviewTarget[];
	recorded?: boolean;
}

/** A note on an item: the reason for a send back, or a remark on an approved one (main Note, without `image`). */
export interface Note {
	fileId?: number;
	x?: number;
	y?: number;
	time?: number;
	text: string;
}

interface ItemDecision {
	key: string;
	verdict: Verdict;
	notes: Note[];
}

interface Decision {
	items: ItemDecision[];
	/** The person's own words, quoted in the record of what they approved. */
	words: string;
}

/** What the person gave so far on an item; the reason is the text of its note. */
type Verdicts = Record<string, { verdict: Verdict; reason: string }>;

/** A review as a screen shows it. */
export interface ReviewView {
	id: string;
	turnId: string;
	kind: ReviewKind;
	subject: string;
	question: string;
	items: ReviewItem[];
	verdicts: Verdicts;
	state: 'open' | 'answered' | 'closed';
	/** When the review was made (its row's created_at): the Review index lists the newest first. */
	createdAt: string;
	submitted?: boolean;
	/** Its stop's files are still being saved (its settles row is not settled): computed when read. */
	settling?: boolean;
}

// ---- a review whose stop is still being saved ----


/** How many of an item's files are here. */
export function itemHere(item: ReviewItem): { here: number; of: number } {
	return { here: item.files.filter(file => file.here !== false).length, of: item.files.length };
}

/**
 * Whether an item's whole file set is here: only then does it take a verdict. A storyboard segment's line-art and
 * photoreal pictures are one item, so a verdict on part of it would approve a picture nobody has seen.
 */
export function itemComplete(item: ReviewItem): boolean {
	const { here, of } = itemHere(item);
	return here === of;
}

/** How many of the stop's files are here, across its items. */
export function filesHere(view: Pick<ReviewView, 'items'>): { here: number; of: number } {
	const counts = view.items.map(itemHere);
	return { here: counts.reduce((sum, c) => sum + c.here, 0), of: counts.reduce((sum, c) => sum + c.of, 0) };
}

/** Whether files are still coming: the stop is being saved, or an item's set is not whole. */
export function arriving(view: Pick<ReviewView, 'items' | 'settling'>): boolean {
	return !!view.settling || !view.items.every(itemComplete);
}

// ---- what a stop asks (main reviews.ts, flow.ts) ----

/**
 * What a stop asks the person for, from the types of the objects its return asks them to choose (doc/protocol.md, 5.1,
 * `type`), in the order main's `inferKind` checked them: a cut, takes, storyboards, references, looks, the bible, breakdowns.
 */
export function reviewKindOf(types: readonly ObjectType[]): ReviewKind {
	const has = (...wanted: ObjectType[]) => types.some(type => wanted.includes(type));
	return has('cut') ? 'cut' : has('take') ? 'takes' : has('storyboard', 'keyframe') ? 'storyboards'
		: has('scene', 'prop', 'variant') ? 'references' : has('character') ? 'looks' : has('bible') ? 'bible'
			: has('breakdown') ? 'breakdowns' : types.length ? 'files' : 'question';
}

/** Whether the agent's last paragraph asks the person something (main flow.ts `asks`). */
export function asks(text: string): boolean {
	const last = text.trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
	return (
		/[?\uff1f][\s*_)\uff09\u300d”"']*$/.test(last) ||
		/\b(please|kindly)\s+(reply|respond|review|approve|confirm|let me know|tell me|decide|choose|watch|check)\b|\breply with\b|\u8bf7(\u4f60)?(\u56de\u590d|\u7b54\u590d|\u5ba1\u9605|\u5ba1\u6279|\u5ba1\u6838|\u786e\u8ba4|\u6279\u51c6|\u544a\u8bc9\u6211|\u51b3\u5b9a|\u9009\u62e9|\u89c2\u770b|\u67e5\u770b)/i.test(last)
	);
}

export function subjectOf(kind: ReviewKind): string {
	switch (kind) {
		case 'looks': return "the leads' looks";
		case 'references': return 'the shared references';
		case 'storyboards': return 'the storyboards';
		case 'takes': return 'the takes';
		case 'cut': return 'the cut';
		case 'bible': return 'the bible';
		case 'breakdowns': return 'the breakdowns';
		case 'screenplay': return 'the screenplay';
		case 'files': return 'the files';
		default: return 'your question';
	}
}

export function viewOf(row: ReviewRow): ReviewView {
	return { id: row.id, turnId: row.turn_id, kind: row.kind, subject: row.subject, question: row.question, items: JSON.parse(row.items) as ReviewItem[], verdicts: JSON.parse(row.verdicts) as Verdicts, state: row.state, createdAt: row.created_at };
}

/** Whether every item has a verdict, and so the decision may be sent (main `verdicts-missing`). A review with no items is a question. */
export function complete(view: Pick<ReviewView, 'items' | 'verdicts'> & { settling?: boolean }): boolean {
	// "Every item has a verdict" waits for the stop's files: more items' files may still come.
	return view.items.length > 0 && !arriving(view) && view.items.every(item => view.verdicts[item.key] !== undefined);
}

// ---- the verdicts so far, as the Review view and the refusals show them ----

/**
 * What Chat says of a stop that asks for verdicts: what waits, and where to give them (* section 2.1, change 7). Chat holds no per-item Accept or Send back: verdicts are given in one place, Review, which
 * redraws as they are given; a Chat part is drawn once and cannot.
 */
export function stopLine(view: Pick<ReviewView, 'subject' | 'items' | 'verdicts'>, reviewLink: string): string {
	const left = undecided(view).length;
	const items = `${view.items.length} ${view.items.length === 1 ? 'item' : 'items'}`;
	return `**The agent waits for your review of ${view.subject}** (${items}${left < view.items.length ? `, ${left} still undecided` : ''}). Decide and submit in [Review](${reviewLink}).`;
}

/** The items that still have no verdict. */
export function undecided(view: Pick<ReviewView, 'items' | 'verdicts'>): ReviewItem[] {
	return view.items.filter(item => view.verdicts[item.key] === undefined);
}

/** How far the person is: "7 of 10 decided", or that the review is ready to send. */
function progressText(view: Pick<ReviewView, 'items' | 'verdicts' | 'settling'>): string {
	if (arriving(view)) {
		const { here, of } = filesHere(view);
		return `${here} of ${of} here`;
	}
	return complete(view) ? 'ready to Submit Review' : `${view.items.length - undecided(view).length} of ${view.items.length} decided`;
}

/** The decision the verdicts make, with the person's own words. */
function decisionOf(view: Pick<ReviewView, 'items' | 'verdicts'>, words: string): Decision {
	return {
		words,
		items: view.items.map(item => {
			const given = view.verdicts[item.key]!;
			return { key: item.key, verdict: given.verdict, notes: given.verdict === 'revise' && given.reason.trim() ? [{ text: given.reason.trim() }] : [] };
		}),
	};
}

// ---- the answer (main decisions.ts, word for word) ----

interface DecisionContext {
	kind: ReviewKind;
	/** What was reviewed, e.g. "the storyboards" or "the leads' looks". */
	subject: string;
	/** Item key → how the agent named it (seg03, Lin Xiaoyu…). */
	labels: Map<string, string>;
	/** File id → its path in the session's working directory. */
	paths: Map<number, string>;
	/** Item key → the stage versions approving it accepts (acceptTargets). */
	targets?: Map<string, readonly AcceptTarget[]>;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function clock(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function where(note: Note, paths: Map<number, string>): string {
	const parts: string[] = [];
	const file = note.fileId !== undefined ? paths.get(note.fileId) : undefined;
	if (file) {
		parts.push(`on ${file}`);
	}
	if (note.x !== undefined && note.y !== undefined) {
		parts.push(`at ${percent(note.x)} across and ${percent(note.y)} down`);
	}
	if (note.time !== undefined) {
		parts.push(`at ${clock(note.time)}`);
	}
	return parts.length ? ` (${parts.join(', ')})` : '';
}

export function answerText(decision: Decision, context: DecisionContext): string {
	const words = decision.words.trim();
	if (context.kind === 'question') {
		return words;
	}
	const label = (key: string) => context.labels.get(key) ?? key;
	const approved = decision.items.filter(item => item.verdict === 'approve');
	const revise = decision.items.filter(item => item.verdict === 'revise');
	const lines = [`My review of ${context.subject}.`];
	if (approved.length) {
		// Each approved item names the versions the person saw; main says the items only.
		const shown = (key: string) => {
			const targets = context.targets?.get(key);
			return targets?.length ? ` (${targets.map(t => `${t.stage} ${t.version}`).join(', ')})` : '';
		};
		const named = approved.map(item => `${label(item.key)}${shown(item.key)}`).join(', ');
		lines.push(revise.length ? `Approved: ${named}.` : context.targets ? `Approved: all ${approved.length}: ${named}.` : `Approved: all ${approved.length}.`);
	}
	if (revise.length) {
		lines.push('Revise:');
		for (const item of revise) {
			const notes = item.notes.filter(note => note.text.trim());
			if (!notes.length) {
				lines.push(`- ${label(item.key)}: please redo it.`);
			}
			for (const note of notes) {
				lines.push(`- ${label(item.key)}: ${note.text.trim()}${where(note, context.paths)}`);
			}
		}
	}
	// Notes on approved items are kept as remarks: approved, with something to know.
	for (const item of approved) {
		for (const note of item.notes.filter(n => n.text.trim())) {
			lines.push(`Remark on ${label(item.key)}: ${note.text.trim()}${where(note, context.paths)}`);
		}
	}
	if (words) {
		lines.push(`In my own words: "${words}"`);
	}
	return lines.join('\n');
}

/** Exact explicit targets, never inferred from a filename or a Chat message. */
interface AcceptTarget { readonly stage: string; readonly version: string }


/** The text of a decision on a review: the one answer the agent receives. */
export function answerFor(view: ReviewView, words: string): string {
	const files = view.items.flatMap(item => item.files);
	const decision = decisionOf(view, words);
	const targets = new Map(view.items.map(item => [item.key, (item.targets ?? []).map(t => ({ stage: `drama/${t.object}`, version: t.version }))]));
	const answer = answerText(decision, {
		kind: view.kind,
		subject: view.subject,
		labels: new Map(view.items.map(item => [item.key, item.label])),
		paths: new Map(files.map(file => [file.id, file.relPath])),
		targets,
	});
	return answer;
}

/** main goals.ts:151 `decisionGoal`, for a decision that is a run: the stop was a finished turn, not a question. `as the goal says` is dropped: a Chat has no goal text. */
export function decisionRun(answer: string): string {
	return [answer, 'Carry on from there, stopping for my review at the next point that needs me, returning the files with your question.'].join('\n\n');
}

/** Why a Chat waits for the person, for the status bar: its review and how far they are, or its question. */
export function waitingReason(label: string, view: Pick<ReviewView, 'subject' | 'items' | 'verdicts'> | undefined): string {
	return view && view.items.length > 0 ? `${label}: review of ${view.subject}, ${progressText(view)}` : `${label}: the agent asks you something`;
}
