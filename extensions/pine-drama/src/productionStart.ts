import type * as vscode from 'vscode';

export const PROJECT_VIEW_ID = 'pine.project';

/**
 * A project window starts on Production, as Code-OSS starts on its default side bar container: Explorer is registered
 * with `isDefault` (explorerViewlet.ts) and layout.ts opens it at start-up. An extension's container cannot be the
 * default without a touchpoint (viewsExtensionPoint.ts registers it without `isDefault`; the budget is 10/10), so the
 * view is opened here. Code-OSS registers `<view id>.focus` for every view; with `preserveFocus` it calls
 * `openView(id, false)`, which opens the container without taking focus (viewsService.ts, FocusViewAction). It needs
 * no tree row, so a project with no stages yet shows Production too.
 */
export async function startOnProduction(view: Pick<vscode.TreeView<unknown>, 'visible'>,
	run: (command: string, options: { preserveFocus: boolean }) => Thenable<unknown>): Promise<void> {
	if (!view.visible) {
		await run(`${PROJECT_VIEW_ID}.focus`, { preserveFocus: true });
	}
}
