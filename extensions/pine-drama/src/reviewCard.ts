import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ChatService } from './core/chats';
import { complete } from './core/reviews';
import { REVIEW_APPROVAL_STATEMENT, REVIEW_CARD_NOT_ISSUED, REVIEW_CARD_OPEN_PROJECT, REVIEW_CARD_OTHER_PROJECT, reviewCardAction,
	type ReviewCardAction, type ReviewCardUpdate } from './core/reviewCardProtocol';
import { previewFolder } from './webviewHtml';

// Only locally issued capabilities can create actionable cards; model-authored fences cannot name reviews.
const cards = new Map<string, { key: string; id: string }>();
export function reviewCardToken(key: string, id: string): string {
	for (const [token, card] of cards) { if (card.key === key && card.id === id) { return token; } }
	const token = randomUUID();
	cards.set(token, { key, id });
	return token;
}
export function reviewCardMarkdown(key: string, id: string): string {
	const token = reviewCardToken(key, id);
	return `\n\n\`\`\`pine-review\n${JSON.stringify({ version: 1, token })}\n\`\`\`\n`;
}

export function registerReviewCards(context: vscode.ExtensionContext, service: ChatService,
	output: vscode.OutputChannel, belongs: (key: string) => boolean,
	/** The Review index's submit, which rejects with its failure; the card shows that failure in place (fix plan, item 6). */
	submit: (key: string, id: string, words: string) => Promise<void>,
	/** Whether the review's continuation is being sent (reviewView.ts): the card then shows it in progress, not Retry. */
	continuing: (id: string) => boolean): { refresh(): void } {
	const updates = new Set<() => void>();
	context.subscriptions.push(vscode.chat.registerChatOutputRenderer('pine.review', {
		async renderChatOutput(data, target) {
			const payload: unknown = JSON.parse(Buffer.from(data.value).toString('utf8'));
			const token = payload && typeof payload === 'object' && 'version' in payload && payload.version === 1 && 'token' in payload ? payload.token : undefined;
			const identity = typeof token === 'string' ? cards.get(token) : undefined;
			// A token this window never issued (for example a fence the model wrote) and a card of another project are
			// different refusals, as our layer-2 `pine.workbench.revealReview` throws one error per cause (pineProjectChat.ts).
			if (!identity) { throw new Error(REVIEW_CARD_NOT_ISSUED); }
			if (!belongs(identity.key)) { throw new Error(REVIEW_CARD_OTHER_PROJECT); }
			const { key, id } = identity;
			// One line per card event, with the session and review it belongs to, so an empty card can be traced from Output.
			const log = (what: string) => output.appendLine(`${new Date().toISOString()} review card ${id} in session ${key}, project ${service.projectRoot(key) ?? 'unknown'}: ${what}`);
			log('rendering');
			const webview = target.webview;
			const media = vscode.Uri.joinPath(context.extensionUri, 'media');
			const previews = previewFolder(context, 'review-previews');
			webview.options = { enableScripts: true, localResourceRoots: [media, previews] };
			const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'reviewCard.js'));
			const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'reviewCard.css'));
			const nonce = randomUUID();
			webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><main id="review" aria-live="polite">Loading review…</main><p id="error" role="alert"></p><script nonce="${nonce}" src="${script}"></script></body></html>`;
			const post = (message: ReviewCardUpdate) => { void webview.postMessage(message); };
			const update = () => {
				try {
				if (!belongs(key)) { post({ version: 1, error: REVIEW_CARD_OPEN_PROJECT }); return; }
				const review = service.review(key, id);
				const thumbnails: Record<string, (string | undefined)[]> = {};
				for (const item of review?.items ?? []) {
					thumbnails[item.key] = item.files.map(file => {
						if (!/\.(png|jpe?g|webp|gif)$/i.test(file.relPath) || file.here === false) { return undefined; }
						const sha = service.reviewFileSha(file);
						const copy = sha && service.preview(sha, file.relPath, previews.fsPath);
						return copy ? webview.asWebviewUri(vscode.Uri.file(copy)).toString() : undefined;
					});
				}
				post({ version: 1, review, thumbnails, approvalStatement: REVIEW_APPROVAL_STATEMENT, ready: !!review && complete(review), continuing: continuing(id),
					locked: !review || review.state !== 'open' || service.savedReviewWords(id) !== undefined });
				} catch (error) {
					log(`update failed: ${String(error)}`);
					post({ version: 1, error: String(error) });
				}
			};
			updates.add(update);
			// drama-cli's code, message and action, as the index's commands show them (reviewView.ts); the stack goes to Output.
			const fail = (error: unknown) => {
				output.appendLine(`${new Date().toISOString()} review ${id} in session ${key}, project ${service.projectRoot(key) ?? 'unknown'}: ${(error as Error).stack ?? error}`);
				post({ version: 1, error: (error as Error).message });
			};
			const act = async (message: Exclude<ReviewCardAction, { action: 'ready' | 'report' }>) => {
				try {
					if (!belongs(key)) { throw new Error('Open the owning project before reviewing.'); }
					switch (message.action) {
						case 'approveAll': service.approveAll(key, id); break;
						case 'decide': service.decideItem(key, id, message.item, message.verdict, message.reason); break;
						case 'submit': {
							const review = service.review(key, id);
							if (service.savedReviewWords(id) === undefined) {
								for (const [item, reason] of Object.entries(message.notes)) {
									if (review?.verdicts[item]?.verdict === 'revise') { service.decideItem(key, id, item, 'revise', reason); }
								}
							}
							await submit(key, id, message.words);
							break;
						}
						case 'open': {
							const file = service.review(key, id)?.items.find(i => i.key === message.item)?.files[message.file];
							if (!file) { throw new Error('This review file is unavailable.'); }
							await vscode.commands.executeCommand('pineDrama.review.openFile', key, file.relPath, service.reviewFileSha(file));
							break;
						}
					}
					update();
				} catch (error) {
					// The card is locked from Submit until the host replies: send its current state, then the error.
					update();
					fail(error);
				}
			};
			// One mutating action at a time per card, in arrival order: each waits for the one before it to settle, as
			// Code-OSS's Sequencer chains tasks (src/vs/base/common/async.ts:296-302). No flag another path can reset.
			let queue: Promise<void> = Promise.resolve();
			const listener = webview.onDidReceiveMessage((raw: unknown): Promise<void> | undefined => {
				let message: ReviewCardAction;
				try { message = reviewCardAction(raw); }
				catch (error) { fail(error); return undefined; }
				// `ensureLivePineSession` only renders again, so it does not wait behind a submission.
				if (message.action === 'ready') { update(); return undefined; }
				// The card's own errors and empty paints are logged at once, not queued behind a submission.
				if (message.action === 'report') { log(`webview reported: ${message.message}`); return undefined; }
				queue = queue.then(() => act(message));
				return queue;
			});
			target.onDidDispose(() => { updates.delete(update); listener.dispose(); });
		},
	}), { dispose: () => { updates.clear(); cards.clear(); } });
	return { refresh: () => { for (const update of updates) { update(); } } };
}
