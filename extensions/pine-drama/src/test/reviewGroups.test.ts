import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { projectReviewKeys, reviewIndexGroups } from '../core/reviewGroups';
import type { ReviewView } from '../core/reviews';
const rows = [{ key: 'main', folder: '/film' }, { key: 'episode', folder: '/film' }, { key: 'other', folder: '/other' }, { key: 'unbound', folder: null }];
test('an unscoped Review index never shows another project or an unbound history', () => {
	assert.deepEqual(projectReviewKeys(rows, undefined), []);
});
test('Review includes every conversation in the current project, not only its primary Chat', () => {
	assert.deepEqual(projectReviewKeys(rows, '/film'), ['main', 'episode']);
	assert.deepEqual(projectReviewKeys(rows, '/other'), ['other']);
});
test('a project without associated conversations has an empty index', () => {
	assert.deepEqual(projectReviewKeys(rows, '/new'), []);
});

// The Review index's groups ("Review index grouped by episode", approved 2026-11-06).
type Item = ReviewView['items'][number];
/** An item as a stop's return proposes it: an object's version (core/chats.ts createReviewForTurn). */
const staged = (stage: string): Item => ({ key: `${stage}/v1`, label: stage, files: [{ id: 1, relPath: `drama/${stage}/v1/image-1.png`, type: 'image/png' }],
	targets: [{ object: stage, version: 'v1', reason: 'checked' }] });
/** An item without a target: its files' paths stand for it. */
const filed = (relPath: string): Item => ({ key: relPath, label: relPath, files: [{ id: 1, relPath, type: 'image/png' }] });
const review = (id: string, items: Item[], more: Partial<ReviewView> = {}) => ({ key: 'chat', review: { id, turnId: id, kind: 'files', subject: id, question: '',
	state: 'open', createdAt: '2026-11-06T01:00:00.000Z', items, verdicts: {}, ...more } as ReviewView });
const shape = (entries: ReturnType<typeof review>[]) => reviewIndexGroups(entries).map(g => [g.id, g.waiting, g.rows.map(r => [r.entry.review.id, r.span])]);

test('a review goes under the episode its items\' drama-cli stage paths name, and anything else under Project', () => {
	assert.deepEqual(shape([
		review('takes', [staged('episodes/EP002/segments/seg01'), staged('episodes/EP002/segments/seg02'), staged('episodes/EP002/segments/seg03')]),
		review('looks', [staged('assets/characters/lin'), staged('assets/scenes/office')]),
		review('boards', [filed('drama/episodes/EP001/multi_panel_storyboard/seg04/line-art/v2/image-1.png'), staged('episodes/EP001/multi_panel_storyboard/seg01/line-art')]),
	]), [
		['Project', 1, [['looks', undefined]]],
		['EP001', 1, [['boards', 'seg01, seg04']]],
		['EP002', 1, [['takes', 'seg01–seg03']]],
	]);
});

test('a review across episodes goes once, under Project, naming its episodes', () => {
	assert.deepEqual(shape([review('both', [staged('episodes/EP001/segments/seg01'), staged('episodes/EP003/segments/seg02')])]),
		[['Project', 1, [['both', 'EP001, EP003']]]]);
	assert.deepEqual(shape([review('mixed', [staged('episodes/EP001/breakdown'), staged('assets/props/lamp')])]),
		[['Project', 1, [['mixed', 'EP001']]]], 'an episode and a project-wide stage: one place, under Project');
});

test('groups in order, Project first then by episode id; in a group the waiting batches first, then the newest', () => {
	const groups = reviewIndexGroups([
		review('ep10', [staged('episodes/EP010/segments/seg01')]),
		review('old-submitted', [staged('episodes/EP002/segments/seg01')], { submitted: true, createdAt: '2026-11-06T03:00:00.000Z' }),
		review('old-waiting', [staged('episodes/EP002/segments/seg02')], { createdAt: '2026-11-06T01:00:00.000Z' }),
		review('new-waiting', [staged('episodes/EP002/segments/seg03')], { createdAt: '2026-11-06T02:00:00.000Z' }),
		review('project', [staged('screenplay')]),
	]);
	assert.deepEqual(groups.map(g => g.id), ['Project', 'EP002', 'EP010']);
	assert.deepEqual(groups[1].rows.map(r => r.entry.review.id), ['new-waiting', 'old-waiting', 'old-submitted']);
});

test('waiting counts every batch not yet submitted, a draft with every item decided included', () => {
	const item = staged('episodes/EP001/segments/seg01');
	const [group] = reviewIndexGroups([
		review('drafted', [item], { verdicts: { [item.key]: { verdict: 'approve', reason: '' } } }),
		review('undecided', [staged('episodes/EP001/segments/seg02')]),
		review('recorded', [staged('episodes/EP001/segments/seg03')], { submitted: true }),
	]);
	assert.equal(group.waiting, 2);
});
