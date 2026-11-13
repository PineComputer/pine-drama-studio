// The seg editor's glue: one webview panel per episode, the
// episode's main view, fed the seg editor's model (core/segEditor.ts). Its toggle and the canvas's open each other: an
// episode's two views of one model. Its takes play inside it. Generate and Regenerate put the request in the Chat's
// input for the person to send: sending it is their go, and BUDGET (core/instructions.ts) covers the
// cost. Nothing here starts a paid call.
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { episodeIn, type OutlineNode } from './core/project';
import { segEditorModel, shootRequest } from './core/segEditor';
import { readFromSegEditor, SEG_PROTOCOL, type ToSegEditor } from './core/segEditorProtocol';
import type { ProjectViews } from './projectViews';
import { closeUnrevived, webviewHtml } from './webviewHtml';

const VIEW_TYPE = 'pineDrama.segEditor';
const titleOf = (episode: string) => `${episode} · Segs`;

export function registerSegEditor(context: vscode.ExtensionContext, views: ProjectViews, output: vscode.OutputChannel): { refresh(): void } {
	const { project } = views;
	const fileUri = (path: string) => isAbsolute(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(vscode.Uri.file(project.root), ...path.split('/'));
	const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'canvas');
	const panels = new Map<string, vscode.WebviewPanel>();

	// The seg a command asked for, shown once the panel's model has gone (a new panel), or at once (an open one).
	const asked = new Map<string, string>();
	const show = async (panel: vscode.WebviewPanel, episode: string) => {
		const seg = asked.get(episode);
		if (seg) {
			asked.delete(episode);
			await panel.webview.postMessage({ v: SEG_PROTOCOL, type: 'show', seg } satisfies ToSegEditor);
		}
	};
	const send = async (panel: vscode.WebviewPanel, episode: string) => {
		let message: ToSegEditor;
		try {
			message = { v: SEG_PROTOCOL, type: 'model', model: segEditorModel(await project.drama(), episode, rel => panel.webview.asWebviewUri(fileUri(rel)).toString()) };
		} catch (error) {
			output.appendLine(`seg editor ${episode}: ${(error as Error).message} (project ${project.root})`);
			message = { v: SEG_PROTOCOL, type: 'error', episode, message: (error as Error).message };
		}
		await panel.webview.postMessage(message);
	};

	const setUp = (panel: vscode.WebviewPanel, episode: string) => {
		panels.set(episode, panel);
		panel.title = titleOf(episode);
		panel.iconPath = new vscode.ThemeIcon('device-camera-video');
		panel.webview.options = { enableScripts: true, localResourceRoots: [media, vscode.Uri.file(project.root), context.globalStorageUri] };
		panel.webview.html = webviewHtml(panel.webview, media, 'seg', titleOf(episode), { episode });
		panel.onDidDispose(() => panels.delete(episode));
		panel.webview.onDidReceiveMessage(async (value: unknown) => {
			const message = readFromSegEditor(value);
			if (message?.type === 'ready') {
				await send(panel, episode);
				await show(panel, episode);
			} else if (message?.type === 'generate') {
				// The request in the Chat's input, not sent (`isPartialQuery`), as the canvas's Generate does (episodeCanvas.ts).
				await vscode.commands.executeCommand('workbench.action.chat.open', { query: shootRequest(episode, message.seg, message.again), isPartialQuery: true });
			} else if (message?.type === 'canvas') {
				await vscode.commands.executeCommand('pineDrama.openEpisodeCanvas', { id: `episodes/${episode}` });
			} else if (message?.type === 'go') {
				// A reference's card: one outside the episode on the assets canvas, centred on it (AC1); its own on the episode's canvas.
				await (episodeIn(message.stageId) !== episode
					? vscode.commands.executeCommand('pineDrama.openAssetsCanvas', message.stageId)
					: vscode.commands.executeCommand('pineDrama.openEpisodeCanvas', { id: `episodes/${episode}` }));
			} else if (message?.type === 'failed') {
				output.appendLine(`seg editor ${episode}: webview: ${message.message}`);
			}
		});
	};

	const open = async (episode: string, seg?: string) => {
		if (seg) {
			asked.set(episode, seg);
		}
		const existing = panels.get(episode);
		if (existing) {
			// A hidden panel's page is gone (retainContextWhenHidden false): revealed, it loads again and says 'ready', and
			// the seg is shown then; a visible one is told now.
			const live = existing.visible;
			existing.reveal();
			if (live) {
				await show(existing, episode);
			}
			return;
		}
		await closeUnrevived(VIEW_TYPE, titleOf(episode));
		setUp(vscode.window.createWebviewPanel(VIEW_TYPE, titleOf(episode), vscode.ViewColumn.Active, { retainContextWhenHidden: false }), episode);
	};
	// The episode a command means: the row it was given, else the seg editor in front, else the tree's selection.
	const activeEpisode = () => [...panels].find(([, panel]) => panel.active)?.[0];
	const target = (node: unknown) => {
		const id = (node as Partial<OutlineNode> | undefined)?.id;
		return (typeof id === 'string' ? episodeIn(id) : undefined) ?? activeEpisode() ?? episodeIn(views.selection()?.id ?? '');
	};

	context.subscriptions.push(
		// `seg`: the canvas's "Open in Seg Editor" on a seg's card chooses that seg.
		vscode.commands.registerCommand('pineDrama.openSegEditor', (node?: unknown, seg?: unknown) => {
			const episode = target(node);
			if (!episode) {
				void vscode.window.showInformationMessage('No episode is chosen: select an episode in the Project view.');
				return;
			}
			return open(episode, typeof seg === 'string' ? seg : undefined);
		}),
		vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
				const episode = (state as { episode?: unknown } | undefined)?.episode;
				if (typeof episode === 'string' && episode !== '' && !episode.includes('/')) {
					setUp(panel, episode);
				} else {
					panel.dispose();
				}
			},
		}),
	);
	return { refresh: () => { for (const [episode, panel] of panels) { void send(panel, episode); } } };
}
