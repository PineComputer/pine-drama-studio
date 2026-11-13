// The HTML of a Studio webview page (the canvas, the galleries and the seg editor): the bundle and
// stylesheet built by canvas/build.mjs, under a content security policy that loads nothing from the network. What the
// extension serves (webviewHtml.ts) and what the render smoke test loads (scripts/render-smoke.mjs). No vscode import.

export type WebviewPage = 'canvas' | 'gallery' | 'seg';

/**
 * @param at `src`: the webview's address of a file of media/canvas; `cspSource`: the webview's own source for the policy
 * (Code-OSS's `webview.cspSource`); `nonce`: the one script's nonce.
 */
export function webviewPageHtml(page: WebviewPage, title: string, data: Record<string, string>, at: { src(name: string): string; cspSource: string; nonce: string }): string {
	// React sets inline styles (React Flow's node transforms), hence 'unsafe-inline' for styles only.
	const csp = [
		`default-src 'none'`,
		`img-src ${at.cspSource} data: blob:`,
		`media-src ${at.cspSource} blob:`,
		`style-src ${at.cspSource} 'unsafe-inline'`,
		`font-src ${at.cspSource}`,
		`script-src 'nonce-${at.nonce}'`,
		`connect-src ${at.cspSource}`,
	].join('; ');
	const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	const attributes = Object.entries(data).map(([key, value]) => ` data-${key}="${escape(value)}"`).join('');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${at.src(`${page}.css`)}">
<title>${escape(title)}</title>
</head>
<body${attributes}>
<div id="root"></div>
<script nonce="${at.nonce}" src="${at.src(`${page}.js`)}"></script>
</body>
</html>`;
}
