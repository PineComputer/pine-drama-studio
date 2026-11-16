// A link into the Studio from a partner's page, "Open in Pine Drama Studio": the app's URL scheme
// (upstream/product.package.json urlProtocol, registered with macOS as CFBundleURLSchemes) to this extension,
// pine-drama-studio://pine.pine-drama/<path>, as Code-OSS hands an extension the URIs addressed to it
// (vscode.window.registerUriHandler). A link carries no key and sends nothing: `start` puts the request for a preset in
// the Chat for the person to send, `connect` opens the Pine connection, where the person pastes their key. No vscode
// import.

/** What a link asks: a drama with a preset, or the Pine connection. */
export type StartLink = { readonly kind: 'start'; readonly preset: string } | { readonly kind: 'connect' };

/** A preset's name as drama-cli names one: its folder under drama_cli/presets (customer-xxcited, en-us-film-sfw). */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The link at `path` with `query` (a URI's own parts), or undefined for one the Studio does not take. */
export function readStartLink(path: string, query: string): StartLink | undefined {
	if (path === '/connect') { return { kind: 'connect' }; }
	const preset = new URLSearchParams(query).get('preset');
	return path === '/start' && preset !== null && PRESET_NAME.test(preset) ? { kind: 'start', preset } : undefined;
}

/** The request a `start` link puts in the Chat; the agent's drama-cli init takes the preset by its name (skills/drama-workflow). */
export const startRequest = (preset: string): string => `Make this drama with the ${preset} preset.`;
