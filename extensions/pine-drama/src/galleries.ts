// The galleries' glue: characters, scenes and props open their asset grid, all three in one editor whose content
// the next kind replaces, as Code-OSS reuses its preview editor (workbench.editor.enablePreview, workbench.contribution.ts:331
// at 235ceeb5); a card opens the assets canvas on it. Restored after a reload. The grids are built in core
// (assetStatus.ts) from the drama; the webview is canvas/gallery.tsx.
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { unchangedLine } from './core/entryActions';
import { cardActions } from './cardActions';
import { galleryPageMessage } from './core/galleryMessage';
import { Throttled } from './core/throttled';
import { GALLERY_PROTOCOL, readFromGallery, type Collection, type ToGallery } from './core/galleryProtocol';
import type { ChatTitle } from './core/project';
import type { ProjectViews } from './projectViews';
import { closeUnrevived, webviewHtml } from './webviewHtml';

const VIEW_TYPE = 'pineDrama.gallery';
type Page = { kind: 'collection'; collection: Collection };
const COLLECTIONS: readonly Collection[] = ['characters', 'scenes', 'props'];
// The three kinds share one editor: its key is the same for each (open, below).
// One editor for the three grids (open, below).
const keyOf = (_page: Page) => 'assets';

export function registerGalleries(context: vscode.ExtensionContext, views: ProjectViews, output: vscode.OutputChannel, chatTitle: ChatTitle = () => undefined): { refresh(): void } {
	const { project } = views;
	const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'canvas');
	const root = vscode.Uri.file(project.root);
	const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const panels = new Map<string, vscode.WebviewPanel>();
	const pages = new Map<vscode.WebviewPanel, Page>();
	// The tree item a page shows: its kind's group.
	views.follow(() => {
		const page = [...pages].find(([panel]) => panel.active)?.[1];
		return page && { path: { characters: 'assets/characters', scenes: 'assets/scenes', props: 'assets/props' }[page.collection], versions: 'none' };
	});
	// The card actions and Create New, shared with the assets canvas's record panel (cardActions.ts).
	const act = cardActions(context, project.root);

	const titleOf = (page: Page) => page.collection;

	// The page each panel last showed, and when it was read: a failed read keeps it, dated.
	const shown = new Map<vscode.WebviewPanel, { message: Extract<ToGallery, { type: 'page' }>; at: string }>();
	const post = async (panel: vscode.WebviewPanel, page: Page) => {
		let message: ToGallery;
		try {
			message = await galleryPageMessage({
				root: project.root, drama: await project.drama(), kind: page.collection, chatTitle,
				src: path => panel.webview.asWebviewUri(isAbsolute(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(root, ...path.split('/'))).toString(),
			});
			if (pages.get(panel) === page) {
				shown.set(panel, { message, at: new Date().toISOString() });
			}
		} catch (error) {
			const text = (error as Error).message;
			output.appendLine(`gallery ${keyOf(page)}: ${text} (project ${project.root})`);
			// A page read before stays, with the failure and the time it was read.
			const last = shown.get(panel);
			message = last
				? { ...last.message, note: [last.message.note, `Reading it again failed: ${text}. Showing what was read at ${time(last.at)}`].filter(Boolean).join(' · ') }
				: { v: GALLERY_PROTOCOL, type: 'error', message: text };
		}
		// A read that ran while the editor changed kind is not posted: the editor shows another page now, whose own read
		// follows (open, below). Posting it would show one kind's cards under another's.
		if (pages.get(panel) !== page) {
			return;
		}
		await panel.webview.postMessage(message);
	};
	// One read of a panel at a time: a page coming into view and a file change made while one runs share the next read, so reads never pile up or post twice (Code-OSS's Throttler).
	const reading = new Map<vscode.WebviewPanel, Throttled<void>>();
	const send = (panel: vscode.WebviewPanel, page: Page) => {
		let read = reading.get(panel);
		if (!read) {
			// The page the panel shows when the read runs: the asset grid's editor changes kind (open, below).
			read = new Throttled(() => post(panel, pages.get(panel) ?? page));
			reading.set(panel, read);
		}
		return read.run();
	};

	/** The panel shows `page`: its title and icon; its content is the page message, which names a grid's kind. */
	const show = (panel: vscode.WebviewPanel, page: Page, title: string) => {
		pages.set(panel, page);
		panel.title = title;
		panel.iconPath = new vscode.ThemeIcon('library');
	};
	const setUp = (panel: vscode.WebviewPanel, page: Page, title: string) => {
		const key = keyOf(page);
		panels.set(key, panel);
		panel.webview.options = { enableScripts: true, localResourceRoots: [media, root, context.globalStorageUri] };
		show(panel, page, title);
		panel.webview.html = webviewHtml(panel.webview, media, 'gallery', panel.title, { gallery: page.collection });
		panel.onDidDispose(() => {
			reading.delete(panel);
			shown.delete(panel);
			panels.delete(key);
			pages.delete(panel);
		});
		// Read again whenever the page comes back into view, so it shows the project as it is now; the tree follows it.
		panel.onDidChangeViewState(({ webviewPanel }) => {
			if (webviewPanel.visible) {
				void send(panel, pages.get(panel) ?? page);
			}
			if (webviewPanel.active) {
				views.followActive();
			}
		});
		if (panel.active) {
			views.followActive();
		}
		panel.webview.onDidReceiveMessage(async (value: unknown) => {
			const message = readFromGallery(value);
			if (message?.type === 'ready') {
				await send(panel, pages.get(panel) ?? page);
			} else if (message?.type === 'open') {
				// A card opens the global assets canvas on it (Pippit 587-588; 592).
				const object = (await project.drama()).objects.get(message.stagePath);
				await views.inspect(message.stagePath, object?.name ?? message.stagePath, object?.type === 'character' ? 'character' : object?.type === 'scene' ? 'location' : 'prop')
					.catch(error => output.appendLine(`gallery: ${(error as Error).message}`));
				await vscode.commands.executeCommand('pineDrama.openAssetsCanvas', message.stagePath);
			} else if (message?.type === 'entry') {
				let error: string | null = null;
				let unchanged: string | null = null;
				try {
					const done = await act(message.request);
					unchanged = unchangedLine(done);
					project.forget();
					output.appendLine(`gallery ${key}: ${message.request.action} ${message.key}: ${done ? unchanged ?? 'written' : 'cancelled'} (project ${project.root})`);
				} catch (failure) {
					error = (failure as Error).message;
					output.appendLine(`gallery ${key}: ${message.request.action} ${message.key}: ${error} (project ${project.root})`);
				}
				await panel.webview.postMessage({ v: GALLERY_PROTOCOL, type: 'actionEnded', key: message.key, error, unchanged } satisfies ToGallery);
				await send(panel, pages.get(panel) ?? page);
			} else if (message?.type === 'failed') {
				output.appendLine(`gallery ${key}: webview: ${message.message}`);
			}
		});
	};

	const open = async (page: Page) => {
		const existing = panels.get(keyOf(page));
		if (existing) {
			// Another kind replaces the grid's content in the same editor (keyOf), as the preview editor's does.
			const was = pages.get(existing);
			if (was && was.collection !== page.collection) {
				shown.delete(existing);
				show(existing, page, titleOf(page));
				void send(existing, page);
			}
			existing.reveal(undefined, true);
			return;
		}
		const title = titleOf(page);
		await closeUnrevived(VIEW_TYPE, title);
		setUp(vscode.window.createWebviewPanel(VIEW_TYPE, keyOf(page), { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { retainContextWhenHidden: false }), page, title);
	};

	// A restored tab is revived only when shown, so one this build cannot serve (the removed Production assets page or
	// detail pages) or a second grid would stay until clicked: they close now, leaving at most one grid (one editor).
	const restored = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE));
	const grids = restored.filter(tab => COLLECTIONS.includes(tab.label as Collection));
	const unserved = [...restored.filter(tab => !grids.includes(tab)), ...grids.slice(1)];
	if (unserved.length) {
		void vscode.window.tabGroups.close(unserved).then(undefined, error => output.appendLine(`gallery: closing restored tabs: ${(error as Error).message}`));
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('pineDrama.openGallery', (which: unknown) => {
			if (COLLECTIONS.includes(which as Collection)) {
				return open({ kind: 'collection', collection: which as Collection });
			}
			return undefined;
		}),
		vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
				const s = (state ?? {}) as Record<string, unknown>;
				const page: Page | undefined = COLLECTIONS.includes(s.gallery as Collection) ? { kind: 'collection', collection: s.gallery as Collection }
					: undefined;
				if (page) {
					setUp(panel, page, titleOf(page));
				} else {
					panel.dispose();
				}
			},
		}),
	);
	const sendVisible = () => {
		for (const [panel, page] of pages) {
			if (panel.visible) {
				void send(panel, page);
			}
		}
	};
	return {
		// The folder's files changed (extension.ts watches them): visible pages read the drama again.
		refresh: sendVisible,
	};
}
