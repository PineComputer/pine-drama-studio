// A Studio webview page's HTML at the webview's own addresses (core/webviewPage.ts), and the folder webviews show
// preview copies from.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { webviewPageHtml, type WebviewPage } from './core/webviewPage';

/**
 * The folder of a webview's preview copies, as a file: URI: both its `localResourceRoots` entry and, through
 * `vscode.Uri.file`, every copy ChatService.preview writes into it. On desktop `globalStorageUri` is a
 * vscode-userdata: URI (Code-OSS environmentService.ts:68, userDataProfile.ts:353), and a webview loads a resource only
 * under a root of the same scheme (resourceLoading.ts:136-159), so a root joined onto it refuses every file: copy.
 */
export function previewFolder(context: vscode.ExtensionContext, name: string): vscode.Uri {
	return vscode.Uri.file(join(context.globalStorageUri.fsPath, name));
}

export function webviewHtml(webview: vscode.Webview, media: vscode.Uri, page: WebviewPage, title: string, data: Record<string, string>): string {
	return webviewPageHtml(page, title, data, {
		src: name => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString(),
		cspSource: webview.cspSource,
		nonce: randomBytes(16).toString('base64'),
	});
}

/**
 * Closes a tab of this view type and title that the workbench restored but has not yet given back to the extension
 * (a hidden webview tab is revived only when shown), so that opening the page again never leaves two tabs of it.
 */
export async function closeUnrevived(viewType: string, title: string): Promise<void> {
	const stale = vscode.window.tabGroups.all.flatMap(group => group.tabs)
		.filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType) && tab.label === title);
	if (stale.length) {
		await vscode.window.tabGroups.close(stale);
	}
}
