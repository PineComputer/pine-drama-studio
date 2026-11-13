// The card's own script (media/reviewCard.js) in a minimal DOM: only what it touches. Shared by the script's tests and the
// host round-trip tests (reviewCardHost.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

export class Node {
	children: Node[] = []; textContent = ''; className = ''; value = ''; disabled = false; open = false; type = '';
	dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
	oninput?: () => void; onchange?: () => void; onclick?: () => void; ontoggle?: () => void;
	constructor(readonly tag: string) {}
	append(...nodes: Node[]) { this.children.push(...nodes); }
	prepend(...nodes: Node[]) { this.children.unshift(...nodes); }
	replaceChildren() { this.children = []; }
	setAttribute(name: string, value: string) { this.attributes[name] = value; }
	focus() {} setSelectionRange() {}
	all(): Node[] { return [this, ...this.children.flatMap(c => c.all())]; }
	querySelectorAll(selector: string) { const tags = selector.split(',').map(s => s.trim()); return this.all().filter(n => n !== this && tags.includes(n.tag)); }
}

/** One load of the card's page; `kept` is the webview state upstream gives a reloaded webview (chatOutputItemRenderer.ts). */
export function card(kept: { state?: unknown; onPost?: (message: { action: string }) => void } = {}) {
	const posted: { action: string }[] = [];
	const onPost = kept.onPost;
	const root = new Node('main'); const error = new Node('p');
	let listener!: (event: { data: unknown }) => void;
	let state: unknown = kept.state;
	runInNewContext(readFileSync(join(__dirname, '..', '..', 'media', 'reviewCard.js'), 'utf8'), {
		acquireVsCodeApi: () => ({ postMessage: (m: { action: string }) => { const copy = JSON.parse(JSON.stringify(m)) as { action: string }; posted.push(copy); onPost?.(copy); }, getState: () => state, setState: (s: unknown) => { state = s; } }),
		document: { getElementById: (id: string) => (id === 'review' ? root : error), createElement: (tag: string) => new Node(tag), activeElement: null },
		window: { addEventListener: (type: string, l: typeof listener) => { if (type === 'message') { listener = l; } } },
	});
	return { root, posted, render: (data: unknown) => listener({ data }), state: () => state };
}

