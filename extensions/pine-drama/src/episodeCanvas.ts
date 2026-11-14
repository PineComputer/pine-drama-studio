// The episode canvas's glue: one webview panel per episode, fed the drama's lineage
// for that episode (core/lineage.ts), and the global assets canvas. A click shows the object in the Versions view; a
// double-click opens exactly the file the card shows in the native viewer. Production logic is in core (lineage.ts,
// canvasLayout.ts, canvasProtocol.ts); the webview is canvas/canvas.tsx, on React Flow (spike S11).
import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import { CANVAS_COMMANDS, CANVAS_PROTOCOL, readFromCanvas, type CanvasDetail, type CanvasLayout, type CanvasViewport, type Shown, type ToCanvas } from './core/canvasProtocol';
import { unchangedLine, type EntryDone } from './core/entryActions';
import { pictureOf, recordOf } from './core/assetStatus';
import { plannedPrompt, shootRequest } from './core/segEditor';
import { madeWith, plannedWith, requestDetail } from './core/versionDetail';
import { canvasTreePath } from './core/assetsCanvas';
import { lineageMessage } from './core/canvasMessage';
import { ASSETS_CANVAS } from './core/lineage';
import { episodeIn, episodeOfNode, roleOf, versionFile, versionFolder, type ChatTitle, type OutlineNode, type Role } from './core/project';
import type { CardAction } from './cardActions';
import type { ProjectViews, StageRef } from './projectViews';
import { CanvasPicks } from './core/canvasPicks';
import { closeUnrevived, globalStorageFolder, webviewHtml } from './webviewHtml';

const VIEW_TYPE = 'pineDrama.episodeCanvas';

/** `act`: the card actions (cardActions.ts), which the record panel and a card's box run. */
export function registerEpisodeCanvas(context: vscode.ExtensionContext, views: ProjectViews, output: vscode.OutputChannel,
	act: (action: CardAction) => Promise<EntryDone | undefined>, chatTitle: ChatTitle = () => undefined): { refresh(): void } {
	const { project } = views;
	const panels = new Map<string, vscode.WebviewPanel>();
	// The card picked on each canvas, so that coming back to a canvas shows it in Versions again.
	const picks = new CanvasPicks<StageRef>({
		isActive: episode => panels.get(episode)?.active === true,
		showInVersions: pick => views.inspect(pick.stagePath, pick.label).then(() => undefined, error => output.appendLine(`canvas: ${(error as Error).message}`)),
		followActive: () => views.followActive(),
	});
	// The person's arrangement, per project and episode, in workspace state: UI state, not a project file (canvasProtocol.ts,
	// CanvasLayout). The assets canvas keeps none: the board lays it out from the object model each time (positionsFor).
	const layoutKey = (episode: string) => `pineDrama.canvasLayout:${project.root}:${episode}`;
	// Where the person last left each canvas, the assets canvas too, kept the same way.
	const viewportKey = (episode: string) => `pineDrama.canvasViewport:${project.root}:${episode}`;
	const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'canvas');
	const root = vscode.Uri.file(project.root);
	// A version's file: project-relative, or absolute for a downloaded version in the drama's record (project.ts versionFile).
	const fileUri = (path: string) => isAbsolute(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(root, ...path.split('/'));

	// The card each canvas centres on when it is next drawn: the asset the person clicked (the assets canvas).
	const focus = new Map<string, string>();
	const send = async (panel: vscode.WebviewPanel, episode: string) => {
		let message: ToCanvas;
		// Every read is logged when it starts and when it ends, with how long it took: the
		// export of a large project takes tens of seconds, and a canvas that shows nothing must say why in the log.
		const started = Date.now();
		const took = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
		try {
			const built = await lineageMessage({
				root: project.root, episode, drama: await project.drama(), layout: context.workspaceState.get<CanvasLayout>(layoutKey(episode)) ?? {},
				focus: focus.get(episode), viewport: context.workspaceState.get<CanvasViewport>(viewportKey(episode)), src: rel => panel.webview.asWebviewUri(fileUri(rel)).toString(), chatTitle,
			});
			message = built;
			focus.delete(episode);
			output.appendLine(`canvas ${episode}: ${built.cards.length} objects, ${built.links.length} links, ${built.cards.filter(c => c.missing).length} missing files, in ${took()} (project ${project.root})`);
		} catch (error) {
			const e = error as Error;
			output.appendLine(`canvas ${episode}: ${e.message}, after ${took()} (project ${project.root})`);
			message = { v: CANVAS_PROTOCOL, type: 'error', episode, message: e.message, code: null, action: null };
		}
		// A message the webview does not take (closed, or not yet loaded) is said, never lost in silence.
		if (!await panel.webview.postMessage(message)) {
			output.appendLine(`canvas ${episode}: the canvas did not take the ${message.type} message; it asks again when it next loads`);
		}
	};

	/**
	 * The detail panel's reply for a card: what its shown version was made with (versionDetail.ts); an asset's or a
	 * variant's card, its record and picture strip too; and the box's prompt for an object that has one to edit.
	 */
	const detailReply = async (webview: vscode.Webview, episode: string, shown: Shown): Promise<ToCanvas> => {
		try {
			const drama = await project.drama();
			const object = drama.objects.get(shown.stageId);
			const src = (rel: string) => webview.asWebviewUri(fileUri(rel)).toString();
			const detail: CanvasDetail | null = object ? await requestDetail(drama, project.root, object, shown.version, src) : null;
			const planned = object && plannedPrompt(drama, object);
			const prompt = object && (planned || object.prompt !== null) ? { object: object.id, text: planned?.text ?? null } : null;
			// The shown version's request, or before any is drawn, the one planned for it (versionDetail.ts).
			const made = !object ? null : shown.version ? await madeWith(resolve(project.root, versionFolder(object, shown.version))) : await plannedWith(resolve(project.root, object.id));
			return { v: CANVAS_PROTOCOL, type: 'detail', stageId: shown.stageId, version: shown.version, detail, record: recordOf(drama, shown.stageId),
				picture: pictureOf(drama, shown.stageId, src), prompt, made, error: object ? null : `${shown.stageId} is not in the drama any more` };
		} catch (error) {
			const text = (error as Error).message;
			output.appendLine(`canvas ${episode}: ${text} (project ${project.root})`);
			return { v: CANVAS_PROTOCOL, type: 'detail', stageId: shown.stageId, version: shown.version, detail: null, error: text };
		}
	};

	/** The shown file, the very one the drama says that version shows, so a message can open nothing else. */
	const shownFile = async (shown: Shown): Promise<string | undefined> => {
		const object = (await project.drama()).objects.get(shown.stageId);
		const file = object && shown.version ? versionFile(object, shown.version) : null;
		return file && file === shown.file ? file : undefined;
	};

	const setUp = (panel: vscode.WebviewPanel, episode: string) => {
		panels.set(episode, panel);
		panel.title = `${episode} · Canvas`;
		panel.iconPath = new vscode.ThemeIcon('layout');
		panel.webview.options = { enableScripts: true, localResourceRoots: [media, root, globalStorageFolder(context)] };
		panel.webview.html = webviewHtml(panel.webview, media, 'canvas', `${episode} · Canvas`, { episode });
		panel.onDidDispose(() => {
			panels.delete(episode);
			picks.close(episode);
		});
		// The tree follows the canvas in front, including one restored already active after a restart.
		panel.onDidChangeViewState(({ webviewPanel }) => webviewPanel.active && views.followActive());
		if (panel.active) {
			views.followActive();
		}
		panel.webview.onDidReceiveMessage(async (value: unknown) => {
			const message = readFromCanvas(value);
			if (message?.type === 'ready') {
				await send(panel, episode);
			} else if (message?.type === 'unpick') {
				picks.unpick(episode);
			} else if (message?.type === 'inspect') {
				const applied = await picks.pick(episode, async () => {
					const drama = await project.drama();
					const object = drama.objects.get(message.stageId);
					return { stagePath: message.stageId, label: object?.name ?? message.stageId, role: object ? roleOf(drama, object) : 'other' as Role };
				});
				if (!applied) {
					return; // An unpick or a newer pick arrived while the lineage loaded.
				}
				await panel.webview.postMessage(await detailReply(panel.webview, episode, message));
			} else if (message?.type === 'open') {
				const file = await shownFile(message);
				if (!file) {
					void vscode.window.showInformationMessage(`${message.stageId} has no file to open: ${message.version ? `${message.version} names none` : 'no version is generated yet'}.`);
					return;
				}
				output.appendLine(`canvas ${episode}: open ${file}`);
				await vscode.commands.executeCommand('vscode.open', fileUri(file), { preview: true });
			} else if (message?.type === 'layout' && message.episode === episode) {
				await context.workspaceState.update(layoutKey(episode), message.positions);
			} else if (message?.type === 'viewport' && message.episode === episode) {
				await context.workspaceState.update(viewportKey(episode), message.viewport);
			} else if (message?.type === 'segEditor') {
				await vscode.commands.executeCommand('pineDrama.openSegEditor', { id: `episodes/${episode}` }, message.seg ?? undefined);
			} else if (message?.type === 'entry') {
				// The card actions (cardActions.ts); then the canvas and the panel read the drama again.
				let error: string | null = null;
				let unchanged: string | null = null;
				try {
					const done = await act(message.request);
					unchanged = unchangedLine(done);
					project.forget();
					output.appendLine(`canvas ${episode}: entry ${message.request.action} ${message.stageId}: ${done ? unchanged ?? 'written' : 'cancelled'} (project ${project.root})`);
				} catch (failure) {
					error = (failure as Error).message;
					output.appendLine(`canvas ${episode}: entry ${message.request.action} ${message.stageId}: ${error} (project ${project.root})`);
				}
				await panel.webview.postMessage({ v: CANVAS_PROTOCOL, type: 'actionEnded', key: message.key, error, unchanged } satisfies ToCanvas);
				// The canvas reads the drama again, and the panel then shows the record as written, for the version its card
				// now shows (lineage.ts: the object's current one).
				await send(panel, episode);
				const version = (await project.drama()).objects.get(message.stageId)?.resolved.current ?? null;
				await panel.webview.postMessage(await detailReply(panel.webview, episode, { stageId: message.stageId, version, file: null }));
			} else if (message?.type === 'generate') {
				// Put in the Chat's input for the person to send, never sent from here: an asset's picture (the Project Chat
				// draws assets, DESIGN 2026-11-08, Option B) or a keyframe's is drawn; a take is shot, asked as the seg editor's
				// Generate asks it (segEditor.ts; shootRequest; amended 2026-11-11). Sending it is the person's explicit
				// action, and the session's BUDGET (core/instructions.ts) has the agent spend within
				// budget_usd without asking about cost.
				const object = (await project.drama()).objects.get(message.stageId);
				const ep = episodeIn(message.stageId);
				const query = object?.type === 'take' && ep && object.segment ? shootRequest(ep, object.segment, false) : `Draw ${object?.name ?? message.stageId} (${message.stageId}).`;
				await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: true });
			} else if (message?.type === 'failed') {
				output.appendLine(`canvas ${episode}: webview: ${message.message}`);
			}
		});
	};

	// One panel per episode: an open canvas is shown where it is, unless the person asks for the side.
	const open = async (episode: string, column?: vscode.ViewColumn.Beside) => {
		const existing = panels.get(episode);
		if (existing) {
			existing.reveal(column);
			return;
		}
		await closeUnrevived(VIEW_TYPE, `${episode} · Canvas`);
		setUp(vscode.window.createWebviewPanel(VIEW_TYPE, `${episode} · Canvas`, column ?? vscode.ViewColumn.Active, { retainContextWhenHidden: true }), episode);
	};
	const activeEpisode = () => [...panels].find(([, panel]) => panel.active)?.[0];
	views.follow(() => {
		const episode = activeEpisode();
		const picked = episode ? picks.get(episode) : undefined;
		return episode ? { path: canvasTreePath(episode, picked?.stagePath), versions: picked ?? 'none' } : undefined;
	});
	// The episode a command means: the row it was given, else the canvas in front, else the tree's selection.
	const target = (node: unknown) => {
		return episodeOfNode(node as Partial<OutlineNode> | undefined) ?? activeEpisode() ?? episodeOfNode(views.selection());
	};
	const openTarget = (node: unknown, column?: vscode.ViewColumn.Beside) => {
		const episode = target(node);
		if (!episode) {
			void vscode.window.showInformationMessage('No episode is chosen: select an episode in the Project view, or open its canvas.');
			return;
		}
		return open(episode, column);
	};

	// Board commands go to the canvas in front; their keybindings only apply while a canvas has focus.
	const active = () => [...panels.values()].find(panel => panel.active);
	context.subscriptions.push(...CANVAS_COMMANDS.map(name => vscode.commands.registerCommand(`pineDrama.canvas.${name}`, () =>
		void active()?.webview.postMessage({ v: CANVAS_PROTOCOL, type: 'command', name } satisfies ToCanvas))));

	context.subscriptions.push(
		vscode.commands.registerCommand('pineDrama.openEpisodeCanvas', (node?: unknown) => openTarget(node)),
		// The global assets canvas, focused on an asset when one is given: a card's click and Edit in canvas open it.
		vscode.commands.registerCommand('pineDrama.openAssetsCanvas', async (stagePath?: unknown) => {
			if (typeof stagePath === 'string' && /^assets\//.test(stagePath)) {
				focus.set(ASSETS_CANVAS, stagePath);
				// Versions shows the asset it opens on, whichever row, card or editor opened it.
				void views.inspect(stagePath, (await project.drama()).objects.get(stagePath)?.name ?? stagePath)
					.catch(error => output.appendLine(`canvas: ${(error as Error).message}`));
			}
			const existing = panels.get(ASSETS_CANVAS);
			await open(ASSETS_CANVAS);
			if (existing) {
				await send(existing, ASSETS_CANVAS);
			}
		}),
		vscode.commands.registerCommand('pineDrama.openEpisodeCanvasToSide', (node?: unknown) => openTarget(node, vscode.ViewColumn.Beside)),
		// Restores an open canvas after a reload; the webview saved its episode with setState.
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
