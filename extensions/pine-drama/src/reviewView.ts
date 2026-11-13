import * as vscode from 'vscode';
import { reviewCardToken } from './reviewCard';
import { chmodSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChatService } from './core/chats';
import { PROJECT_GROUP, projectReviewKeys, reviewIndexGroups, type ReviewIndexGroup } from './core/reviewGroups';
import { complete, type ReviewView } from './core/reviews';


// A project-wide native index. Decisions and file inspection live in the owning Chat card.
export const VIEW_ID = 'pine.sessionReview';
export const SUBMIT_COMMAND = 'pineDrama.review.submit';
const OPEN_FILE_COMMAND = 'pineDrama.review.openFile';
export const OPEN_REVIEW_COMMAND = 'pineDrama.review.openMessage';

interface Entry { key: string; review: ReviewView }
/** A row of the index: a group (Project or an episode) or a review in it (approved 2026-11-06). */
type Node = { group: ReviewIndexGroup<Entry> } | { entry: Entry; span: string | undefined };
export function registerReviewView(context: vscode.ExtensionContext, output: vscode.OutputChannel,
	service: ChatService, titleOf: (key: string) => string | undefined,
): { refresh(key: string): void; reveal(reviewId: string): Promise<boolean>;
	/** The window's project root (projectSessions), not one of its Chats (fix plan, item 9). */
	scope(root: string | undefined): void;
	/** Records and continues; rejects with the failure, for a caller that shows it itself (the Chat card). */
	/** `words`: the card's Anything else field; empty from the banner and the Review index, which have none. */
	submitReviewDecisions(key: string, id: string, words?: string): Promise<void>;
	/** Whether this review's continuation is being sent from this window: from Submit until its response completes. */
	continuing(id: string): boolean;
	readonly onDidChangeContinuing: vscode.Event<void> } {
	let root: string | undefined;
	const changed = new vscode.EventEmitter<void>();
	const entries = (): Entry[] => {
		if (!root) { return []; }
		return projectReviewKeys(service.chats(), root).flatMap(key => service.reviews(key)
			.filter(r => r.state === 'open' || r.submitted).map(review => ({ key, review })));
	};
	const open = async (entry: Entry) => {
		if (!entries().some(e => e.key === entry.key && e.review.id === entry.review.id)) {
			throw new Error('Open the owning project to read this review.');
		}
		await vscode.commands.executeCommand('pine.workbench.revealReview', entry.key, entry.review.id, reviewCardToken(entry.key, entry.review.id));
	};
	// Grouped as Code-OSS groups its own views: Problems under each file, Source Control under each repository, each with
	// its count (markersTreeViewer.ts:152-218, scmRepositoryRenderer.ts:68-184). An extension's tree has no per-row badge
	// (TreeView.badge is the view's), so a group's count is its description (TreeItem.description).
	const view = vscode.window.createTreeView<Node>(VIEW_ID, { treeDataProvider: {
		onDidChangeTreeData: changed.event,
		getChildren: node => !node ? reviewIndexGroups(entries()).map(group => ({ group })) : 'group' in node ? node.group.rows.map(row => ({ ...row })) : [],
		getTreeItem: node => {
			if ('group' in node) {
				const { id, waiting } = node.group;
				const group = new vscode.TreeItem(id, vscode.TreeItemCollapsibleState.Expanded);
				group.id = `group:${id}`;
				group.description = waiting ? `${waiting} waiting` : undefined;
				group.accessibilityInformation = { label: `${id === PROJECT_GROUP ? 'Project' : id}, ${waiting ? `${waiting} ${waiting === 1 ? 'review' : 'reviews'} waiting` : 'no review waiting'}` };
				return group;
			}
			const { entry, span } = node;
			const r = entry.review;
			const item = new vscode.TreeItem(r.subject);
			item.id = r.id;
			const approved = r.items.filter(i => r.verdicts[i.key]?.verdict === 'approve').length;
			item.description = r.submitted ? `${approved} approved · ${r.items.length - approved} changes requested` : `${r.items.length} items · needs review`;
			item.description = `${span ? `${span} · ` : ''}${titleOf(entry.key) ?? entry.key} · ${item.description}`;
			item.tooltip = `${titleOf(entry.key) ?? entry.key} · ${r.subject}`;
			item.iconPath = new vscode.ThemeIcon(r.submitted ? 'pass' : 'circle-large-outline');
			item.command = { command: OPEN_REVIEW_COMMAND, title: 'Open review in Chat', arguments: [entry] };
			return item;
		},
	} });
	const refresh = (_key?: string) => {
		const waiting = entries().filter(e => !e.review.submitted).length;
		view.badge = waiting ? { value: waiting, tooltip: `${waiting} review batches waiting` } : undefined;
		view.message = 'All conversations in this project. Select a review to open its message in Chat.';
		changed.fire();
	};
	// The one record that a continuation is in flight: from Submit until its response completes. The card reads it,
	// so a continuation being sent is never offered as one to retry (the person's run).
	const submitting = new Set<string>();
	const continuingChanged = new vscode.EventEmitter<void>();
	const submitReviewDecisions = async (key: string, id: string, words = '') => {
		const entry = entries().find(e => e.key === key && e.review.id === id);
		if (!entry || service.openReview(key)?.review.id !== id) { throw new Error('This review is no longer waiting in this project.'); }
		if (!complete(entry.review)) { throw new Error('Choose Approve or Change for every item before submitting.'); }
		if (submitting.has(id)) { return; }
		submitting.add(id);
		continuingChanged.fire();
		let continuing: Thenable<unknown> | undefined;
		try {
			const answer = await service.recordReviewDecisionsLocally(key, id, words);
			refresh();
			await vscode.commands.executeCommand('pine.workbench.openReviewChat', key);
			// One continuation at a time: the guard holds until its response completes, upstream's own wait for a query it
			// sends (chat.open's blockOnResponse, chatActions.ts:420). Without it chat.open returns once the request is
			// dispatched, the card offers Retry continuation while the continuation is still being sent, and a second
			// submit reaches upstream's request queue while the first runs (chatWidget.ts:3997-3999): one answer sent and
			// a copy queued to be sent again (the person's run). The card is not held: its files still open.
			continuing = vscode.commands.executeCommand('workbench.action.chat.open', { query: answer, isPartialQuery: false, preserveInput: true, blockOnResponse: true });
		} finally {
			if (!continuing) { submitting.delete(id); continuingChanged.fire(); refresh(); }
		}
		void Promise.resolve(continuing).then(undefined, error => shown('continuing a review', key, error))
			.finally(() => { submitting.delete(id); continuingChanged.fire(); refresh(); });
	};
	// A command the workbench runs (the Chat banner, a Review row, a Chat link) shows its own failure. Upstream's banner
	// hands a rejection to onUnexpectedError, which reaches only the console (chatReadOnlyBanner.ts:50); upstream's own
	// continuation catches its action's failure and shows it (chatWidget.ts:2277-2305). AGENTS.md coding rule 1.
	const shown = (what: string, key: string | undefined, error: unknown) => {
		output.appendLine(`${new Date().toISOString()} review: ${what} failed in session ${key ?? 'unknown'}, project ${(key && service.projectRoot(key)) ?? 'unknown'}: ${(error as Error).stack ?? error}`);
		void vscode.window.showErrorMessage(`Pine: ${(error as Error).message}`);
	};
	context.subscriptions.push(view, changed,
		vscode.commands.registerCommand(OPEN_REVIEW_COMMAND, async (arg: Entry | string, id?: string) => {
			const key = typeof arg === 'string' ? arg : arg.key;
			try {
				const entry = typeof arg === 'string' ? entries().find(e => e.key === arg && e.review.id === id) : arg;
				if (!entry) { throw new Error('This review is unavailable in the current project.'); }
				await open(entry);
			} catch (error) { shown('opening a review', key, error); }
		}),
		vscode.commands.registerCommand(SUBMIT_COMMAND, (key: string, id: string) => submitReviewDecisions(key, id).catch(error => shown('submitting a review', key, error))),
		vscode.commands.registerCommand(OPEN_FILE_COMMAND, async (key: string, relPath: string, sha: string | undefined) => {
			const r = service.resolveReturned(key, relPath, sha, true);
			if (r?.state === 'arrived' && r.where === 'folder') {
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(r.path), { preview: true });
			} else if (r?.state === 'arrived') {
				const copy = service.preview(r.sha, relPath, join(context.globalStorageUri.fsPath, 'previews'));
				if (!copy) {
					void vscode.window.showErrorMessage(`Pine: the version of ${relPath} under review is not kept on this computer.`);
					return;
				}
				chmodSync(copy, 0o444);
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(copy), { preview: true });
				if (r.newer) {
					void vscode.window.showInformationMessage(`Pine: this is the version of ${basename(relPath)} under review; a newer copy is in the drama's folder.`);
				}
			} else {
				output.appendLine(`${new Date().toISOString()} review: ${key}: ${relPath} could not be opened: ${JSON.stringify(r)}`);
				void vscode.window.showWarningMessage(`Pine: ${relPath} cannot be opened: ${r === undefined ? 'this session has no drama folder' : r.state === 'failed' ? r.error : r.state === 'refused' ? r.reason : r.state === 'arriving' ? 'it is still arriving' : 'it was not returned'}.`);
			}
		}),
		view.onDidChangeVisibility(e => { if (e.visible) { refresh(); } }),
		vscode.window.onDidChangeWindowState(e => { if (e.focused) { refresh(); } }),
	);
	context.subscriptions.push(continuingChanged);
	return { refresh, submitReviewDecisions, continuing: id => submitting.has(id), onDidChangeContinuing: continuingChanged.event, scope: projectRoot => { root = projectRoot; refresh(); },
		reveal: async id => { const entry = entries().find(e => e.review.id === id); if (!entry) { return false; } await open(entry); return true; } };
}
