// The render smoke test: each webview page (the canvas, the asset grid, the seg editor) loaded in headless Chromium with
// the very message the extension posts, built by the same core builders from the protocol fixture (a drama folder and
// its snapshots, test-fixtures/protocol), and failed on a page error, a console error, a `failed` message from the page,
// or fewer cards than the message holds. Unit tests never render the pages, and the assets canvas once went blank while
// every one of them passed. Run by scripts/pine-dev-test-remote.sh; not part of `npm test`.
//
//   node out/test/renderSmoke.js
//
// Environment: PDS_PLAYWRIGHT, a folder whose node_modules holds playwright-core (installed outside the repository, as
// the remote script does); PLAYWRIGHT_BROWSERS_PATH, its browsers. PDS_RENDER_SHOTS, a folder: each page is also saved
// there as shot-<case>.png (and the box case's open box as shot-box-under-card.png), at 1600 x 1000 in VS Code's Dark
// Modern colours, approximated, since no Code-OSS window is opened on the Mac to look at a UI change (AGENTS.md,
// section 9); the runner keeps them in the run folder.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { pictureOf, recordOf } from '../core/assetStatus';
import { lineageMessage } from '../core/canvasMessage';
import { onBoard } from '../core/canvasLayout';
import { ASSETS_CANVAS, CANVAS_PROTOCOL, type CanvasCard, type CanvasPrompt } from '../core/canvasProtocol';
import { galleryPageMessage } from '../core/galleryMessage';
import { NAME_MAX, TEXT_MAX, type Collection } from '../core/galleryProtocol';
import { readDrama, type Drama } from '../core/project';
import type { Snapshot } from '../core/protocol';
import { plannedPrompt, segEditorModel } from '../core/segEditor';
import { SEG_PROTOCOL } from '../core/segEditorProtocol';
import { webviewPageHtml, type WebviewPage } from '../core/webviewPage';

const EXTENSION = join(__dirname, '..', '..');
const MEDIA = join(EXTENSION, 'media', 'canvas');
const FIXTURES = join(EXTENSION, 'test-fixtures', 'protocol');
/** The pages' origin: every request to it is answered from media/canvas or the case's project, nothing from the network. */
const ORIGIN = 'https://render-smoke.invalid';
const WAIT_MS = 10_000;

/** One page load: the page, the message the extension would post once it is ready, and what must be on screen then. */
interface Case {
	readonly name: string;
	readonly page: WebviewPage;
	readonly data: Record<string, string>;
	readonly root: string;
	readonly message: unknown;
	/** Cards: this many matches of the selector. Text: the page says this (a message that is itself an error). */
	readonly expect: { readonly selector: string; readonly count: number } | { readonly text: string };
	/** What the page does once it rendered, and what went wrong; `answer` replies to a page message as the extension would. */
	/** Rendered as on a Mac (MAC's user agent). */
	readonly mac?: boolean;
	/** The page's size, when the case needs one (Playwright's default is 1280 x 720). */
	readonly pane?: { readonly width: number; readonly height: number };
	readonly interact?: { readonly answer: (message: { type?: string; stageId?: string; version?: string | null }) => unknown; readonly check: (page: Page, posted: readonly unknown[]) => Promise<string[]> };
}

/** A drama to render: its folder and the drama read from it, as the extension reads it (core/project.ts). */
interface Source { readonly name: string; readonly root: string; readonly drama: Drama }

const fileSrc = (rel: string) => `${ORIGIN}/project/${rel.split('/').map(encodeURIComponent).join('/')}`;

async function canvasCase(source: Source, episode: string): Promise<Case> {
	const message = await lineageMessage({ root: source.root, episode, drama: source.drama, layout: {}, focus: undefined, viewport: undefined, src: fileSrc });
	// Every recorded link between two cards on the board is drawn, from the card used to the card made from it: the
	// person missed them once all were dropped, and asked which way a take's line runs.
	const board = new Set(message.cards.filter(onBoard).map(c => c.id));
	const lines = message.links.filter(l => board.has(l.from) && board.has(l.to)).length;
	const check = async (page: Page): Promise<string[]> => {
		const edges = page.locator('.react-flow__edge');
		for (const until = Date.now() + WAIT_MS; Date.now() < until && await edges.count() < lines;) { await new Promise(resolve => setTimeout(resolve, 100)); }
		const drawn = await edges.count();
		if (lines === 0 || drawn !== lines) { return [lines === 0 ? `the fixture's ${episode} canvas has no link to draw` : `${drawn} lines drawn of ${lines} links`]; }
		// Each line leaves what was used from its right side (its output) and enters what was made from it on its left
		// side (its input), in screen space.
		type Point = { x: number; matrixTransform(matrix: unknown): Point };
		type Path = { getTotalLength(): number; getPointAtLength(at: number): Point; getScreenCTM(): unknown };
		type El = { getAttribute(name: string): string | null; querySelector(selector: string): Path | null; getBoundingClientRect(): { left: number; right: number } };
		return page.evaluate(() => {
			const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<El>; querySelector(selector: string): El | null } }).document;
			return Array.from(doc.querySelectorAll('.react-flow__edge')).flatMap(edge => {
				const [from, to] = (edge.getAttribute('data-id') ?? '').split('->');
				const path = edge.querySelector('.react-flow__edge-path');
				const source = doc.querySelector(`.react-flow__node[data-id="${from}"]`)?.getBoundingClientRect();
				const target = doc.querySelector(`.react-flow__node[data-id="${to}"]`)?.getBoundingClientRect();
				if (!path || !source || !target) { return [`${from} -> ${to}: no path or card`]; }
				const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()).x;
				const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()).x;
				return Math.abs(start - source.right) <= 4 && Math.abs(end - target.left) <= 4 ? []
					: [`${from} -> ${to} runs from x ${Math.round(start)} to ${Math.round(end)}, not from ${Math.round(source.right)} to ${Math.round(target.left)}`];
			});
		}, null);
	};
	return { name: `${source.name}: canvas ${episode}`, page: 'canvas', data: { episode }, root: source.root, message,
		expect: { selector: '.react-flow__node-card', count: message.cards.filter(onBoard).length }, interact: { answer: () => null, check } };
}

/**
 * A take as drama-cli records it lists every version it was made from, its keyframe's pictures and the breakdown too
 * (doc/protocol.md 2.1). Each one on the board has its line into the take; the breakdown, not on the board, has none:
 * the person once saw a take with no line from the pictures it was made from. `source`'s drama is changed: give it a
 * fresh one.
 */
async function takeLinesCase(source: Source): Promise<Case> {
	const take = 'episodes/EP001/segments/seg01';
	const pictures = ['assets/characters/lin', 'assets/scenes/office', 'episodes/EP001/keyframe/seg01/shot01'];
	const listed = [...pictures, 'episodes/EP001/breakdown'];
	Object.assign(source.drama.objects.get(take)!.versions.find(v => v.id === 'v1')!.record, { inputs: listed.map(object => ({ object, version: 'v1' })) });
	const c = await canvasCase(source, 'EP001');
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		const problems = await c.interact!.check(page, posted);
		const edges = page.locator('.react-flow__edge');
		const into = (await Promise.all(Array.from({ length: await edges.count() }, (_, i) => edges.nth(i).getAttribute('data-id'))))
			.filter(id => id?.endsWith(`->${take}`)).map(id => id!.slice(0, -`->${take}`.length)).sort();
		return JSON.stringify(into) === JSON.stringify([...pictures].sort()) ? problems : [...problems, `the take's lines come from ${into.join(', ') || 'nothing'}`];
	};
	return { ...c, name: `${source.name}: a take's lines come from every picture it lists on the board`, interact: { answer: () => null, check } };
}

/** The prompt the box shows for an object (episodeCanvas.ts detailReply). */
function promptOf(source: Source, id: string): CanvasPrompt | null {
	const object = source.drama.objects.get(id);
	const planned = object && plannedPrompt(source.drama, object);
	return object && planned ? { object: id, text: planned.text } : null;
}

/** What the shown version was made with, as madeWith reads it from a saved OpenAI image request. */
const MADE = { model: 'gpt-image-2.5-sunburst', settings: ['1152×2048', 'high', '1 image'] };

/** What the extension answers a click on a card with (episodeCanvas.ts detailReply): its record, picture strip, prompt and what it was made with. */
function recordAnswer(source: Source) {
	return (m: { type?: string; stageId?: string; version?: string | null }) => {
		if (m.type !== 'inspect' || !m.stageId) { return null; }
		return { v: CANVAS_PROTOCOL, type: 'detail', stageId: m.stageId, version: m.version ?? null, detail: null, record: recordOf(source.drama, m.stageId),
			picture: pictureOf(source.drama, m.stageId, fileSrc), prompt: promptOf(source, m.stageId), made: MADE, error: null };
	};
}

/** A card action the page posted (FromCanvas `entry`), by its request. */
type Posted = { type?: string; stageId?: string; key?: string; request?: { action?: string; object?: string; text?: string } };
const entries = (posted: readonly unknown[], action: string) => (posted as Posted[]).filter(m => m.type === 'entry' && m.request?.action === action);

async function boxCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, ASSETS_CANVAS);
	// A save is answered as episodeCanvas.ts answers it (actionEnded): refused by --expect the first time, written after.
	let saves = 0;
	// The last save is held, its answer sent by the check once the box is closed.
	let hold = false;
	let held: unknown = null;
	const record = recordAnswer(source);
	const answer = (m: { type?: string; stageId?: string; version?: string | null }) => {
		const e = m as Posted;
		if (e.type !== 'entry' || e.request?.action !== 'describe') { return record(m); }
		const ended = { v: CANVAS_PROTOCOL, type: 'actionEnded', key: e.key, error: ++saves === 1 ? 'The description changed since the composer showed it; nothing was saved.' : null, unchanged: null };
		if (hold) { hold = false; held = ended; return null; }
		return ended;
	};
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		const problems: string[] = [];
		const card = page.locator('.react-flow__node-card').first();
		await page.keyboard.press('v');
		await card.click({ position: { x: 12, y: 12 } });
		const box = page.locator('.composer');
		if (await box.waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return ['no composer opened under the clicked card']; }
		const text = box.locator('textarea');
		if (await text.waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return ['the composer shows no text (its reply did not arrive)']; }
		if (await text.count() !== 1) { problems.push(`the composer holds ${await text.count()} texts, not one`); }
		// Its one text is the picture's own: the asset's description, not the compiled prompt (the person's design).
		const pickedId = (posted.find(m => (m as { type?: string }).type === 'inspect') as { stageId?: string } | undefined)?.stageId;
		const description = recordOf(source.drama, pickedId ?? '')?.description;
		if (!description) { return [...problems, `${pickedId} has no description in this fixture`]; }
		if (await text.inputValue() !== description) { problems.push('the composer\'s text is not the description'); }
		if (await text.getAttribute('aria-label') !== 'Description') { problems.push('the composer\'s text is not labelled Description'); }
		// What the Computer cannot take yet is shown greyed; the model and settings are the shown version's own; no cost is shown.
		for (const name of [`${MADE.model} ▾`, 'Reference', 'Style', `${MADE.settings.join(' · ')} ▾`]) {
			const button = box.locator(`button:has-text("${name}")`);
			if (await button.count() !== 1 || !await button.isDisabled() || await button.getAttribute('title') !== 'Not available yet') { problems.push(`${name} is not shown greyed as not available yet`); }
		}
		// No version numbers and no record labels on the card (the person's design).
		const foot = await textOf(card.locator('.card-status'));
		if (!foot || /\bv\d+\b/.test(foot)) { problems.push(`the card's status reads ${JSON.stringify(foot)}`); }
		const [c, b] = [await card.boundingBox(), await box.boundingBox()];
		if (!c || !b) {
			problems.push('the card or the box has no box on screen');
		} else {
			if (b.y < c.y + c.height) { problems.push(`the composer starts at y ${b.y}, above the card's bottom ${c.y + c.height}`); }
			const offset = Math.abs((b.x + b.width / 2) - (c.x + c.width / 2));
			if (offset > 2) { problems.push(`the composer is ${offset.toFixed(0)} px off the card's centre`); }
		}
		if (process.env.PDS_RENDER_SHOTS) { await new Promise(resolve => setTimeout(resolve, 800)); await page.screenshot({ path: join(process.env.PDS_RENDER_SHOTS, 'shot-box-under-card.png') }); }
		// Generate is last in the composer's bottom bar.
		const generate = box.locator('button.generate');
		const row = await box.locator('.composer-bar').evaluate(element => Array.from((element as { querySelectorAll(selector: string): ArrayLike<{ getAttribute(n: string): string | null }> }).querySelectorAll('button'), b => b.getAttribute('aria-label')));
		if (row.at(-1) !== 'Generate') { problems.push(`Generate is not last in the bottom bar (${JSON.stringify(row)})`); }
		if (await generate.isDisabled()) { problems.push('Generate is disabled with no edit'); }
		await generate.click();
		// The page's message reaches this side through an exposed binding, asynchronously.
		for (const until = Date.now() + 2000; !posted.some(m => (m as { type?: string }).type === 'generate') && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		const stageId = (posted.find(m => (m as { type?: string }).type === 'inspect') as { stageId?: string } | undefined)?.stageId;
		if (!posted.some(m => (m as { type?: string; stageId?: string }).type === 'generate' && (m as { stageId?: string }).stageId === stageId)) {
			problems.push(`Generate posted no generate for ${stageId}`);
		}
		// A blanked text can be neither saved nor drawn from: Generate waits, and nothing is posted.
		const before = posted.length;
		await text.fill('   ');
		if (!await generate.isDisabled()) { problems.push('Generate is enabled with a blank description'); }
		await page.keyboard.press('Control+Enter');
		await new Promise(resolve => setTimeout(resolve, 300));
		if (posted.length !== before) { problems.push(`a blank description posted ${JSON.stringify(posted.slice(before))}`); }
		await text.fill(description);
		// With an unsaved edit, Generate saves it and puts the request in the chat: never disabled for it.
		const edited = `${await text.inputValue()} edited`;
		await text.fill(edited);
		// Return, not click: a click on a disabled button waits out the whole run (seen in a mutation run).
		if (await generate.isDisabled()) { return [...problems, 'Generate is disabled with an unsaved edit']; }
		const generates = () => posted.filter(m => (m as { type?: string }).type === 'generate').length;
		const saved = () => entries(posted, 'describe').map(m => m.request!);
		// A refused save puts no request in the chat: the edit stays, with drama-cli's words.
		await generate.click();
		for (const until = Date.now() + 2000; saved().length < 1 && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		await new Promise(resolve => setTimeout(resolve, 300));
		if (saved()[0]?.text !== edited) { problems.push(`Generate with an edit saved ${JSON.stringify(saved()[0]?.text)}, not the edit`); }
		if (saved()[0]?.object !== pickedId) { problems.push(`the save names ${saved()[0]?.object}, not the card's object`); }
		if (generates() !== 1) { problems.push('Generate posted a request after its save was refused'); }
		if (await text.inputValue() !== edited) { problems.push('a refused save dropped the edit'); }
		// A written save, then the request.
		await generate.click();
		for (const until = Date.now() + 2000; generates() < 2 && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		if (generates() !== 2) { problems.push(`Generate with an edit posted ${generates() - 1} requests once saved, not 1`); }
		// + Variant's draft stops at what readFromCanvas takes, so nothing longer is sent and dropped unanswered.
		await box.locator('button:has-text("Variant")').click();
		problems.push(...await draftLimits(box, 'input[aria-label="Variant name"]', 'textarea[aria-label="Variant description"]', '+ Variant'));
		// A save still running when the box closes: its request still goes to the chat once the save is written (the box is keyed by its card and unmounts with it).
		await box.locator('input[aria-label="Variant name"]').click();
		await page.keyboard.press('Escape');
		hold = true;
		await box.locator('textarea[aria-label="Description"]').fill(`${edited} again`);
		await generate.click();
		for (const until = Date.now() + 2000; !held && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		if (!held) { return [...problems, 'Generate with an edit sent no save to hold']; }
		await box.locator('button[aria-label="Close"]').click();
		if (await box.waitFor({ state: 'detached', timeout: WAIT_MS }).then(() => false, () => true)) { return [...problems, 'the composer did not close']; }
		// Sent as the extension's reply is sent to the webview (the acquireVsCodeApi shim below).
		await page.evaluate(message => (globalThis as unknown as { postMessage(m: unknown, origin: string): void }).postMessage(message, '*'), held);
		for (const until = Date.now() + 2000; generates() < 3 && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		if (generates() !== 3) { problems.push('a save written after its composer closed put no request in the chat'); }
		return problems;
	};
	return { ...c, name: `${source.name}: the composer under an asset card`, interact: { answer, check } };
}

/**
 * An episode card's box has the asset box's Generate (amended 2026-11-11): with no edit it puts the request in the
 * chat; with an edit it saves the text shown first, on the card's own stage and version, and the request follows once
 * the save is written. On the first keyframe or take of EP001 whose prompt drama-cli planned.
 */
async function episodeBoxCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, 'EP001');
	const id = ((c.message as { cards?: readonly CanvasCard[] }).cards ?? []).filter(onBoard).map(card => card.id).find(card => promptOf(source, card));
	const target = id ? { id, text: promptOf(source, id)!.text!, take: source.drama.objects.get(id)?.type === 'take' } : undefined;
	// Answered as episodeCanvas.ts answers them (detailReply). A save's answer (actionEnded, written) is held, and sent by
	// the check, so a request posted before the save is written shows.
	let held: unknown = null;
	const answer = (m: { type?: string; stageId?: string; version?: string | null }) => {
		const e = m as Posted;
		if (e.type === 'entry' && e.request?.action === 'prompt') { held = { v: CANVAS_PROTOCOL, type: 'actionEnded', key: e.key, error: null, unchanged: null }; return null; }
		return m.type !== 'inspect' || !m.stageId ? null
			: { v: CANVAS_PROTOCOL, type: 'detail', stageId: m.stageId, version: null, detail: null, error: null, prompt: promptOf(source, m.stageId) };
	};
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		if (!target) { return ['no card of EP001 has a prompt, so no episode box is checked']; }
		const problems: string[] = [];
		await page.keyboard.press('v');
		await page.locator(`.react-flow__node[data-id="${target.id}"]`).click({ position: { x: 12, y: 12 } });
		const text = page.locator('.composer textarea[aria-label="Prompt"]');
		if (await text.waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return [`${target.id}'s box shows no prompt`]; }
		const generate = page.locator('.composer button.generate');
		if (await generate.count() !== 1) { return [`${target.id}'s composer has ${await generate.count()} Generate buttons, not one`]; }
		// A take is shot, a picture drawn: the tooltip says which, as the request does.
		const verb = target.take ? 'Shoot only this segment' : 'Draw only this picture';
		if (!(await generate.getAttribute('title'))?.startsWith(verb)) { problems.push(`${target.id}'s Generate reads ${JSON.stringify(await generate.getAttribute('title'))}, not "${verb}…"`); }
		const generates = () => posted.filter(m => (m as { type?: string }).type === 'generate') as { stageId?: string }[];
		const saved = () => entries(posted, 'prompt').map(m => m.request!);
		// No edit: the request at once, for this card, and no save.
		if (await generate.isDisabled()) { return [...problems, 'Generate is disabled with no edit']; }
		await generate.click();
		for (const until = Date.now() + 2000; generates().length < 1 && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		if (generates().length !== 1 || generates()[0].stageId !== target.id) { problems.push(`Generate with no edit posted ${JSON.stringify(generates())}, not one request for ${target.id}`); }
		if (saved().length) { problems.push('Generate with no edit saved'); }
		// An edit: saved first, then the request once written.
		const edited = `${target.text} edited`;
		await text.fill(edited);
		if (await generate.isDisabled()) { return [...problems, 'Generate is disabled with an unsaved edit']; }
		await generate.click();
		for (const until = Date.now() + 2000; !held && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		const save = saved()[0];
		if (!held || saved().length !== 1 || save.text !== edited || save.object !== target.id) {
			return [...problems, `Generate with an edit saved ${JSON.stringify(saved())}, not the edit on ${target.id}`];
		}
		// Not before the save is written.
		await new Promise(resolve => setTimeout(resolve, 300));
		if (generates().length !== 1) { problems.push('Generate with an edit posted its request before the save was written'); }
		// Sent as the extension's reply is sent to the webview (the acquireVsCodeApi shim).
		await page.evaluate(message => (globalThis as unknown as { postMessage(m: unknown, origin: string): void }).postMessage(message, '*'), held);
		for (const until = Date.now() + 2000; generates().length < 2 && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		if (generates().length !== 2 || generates()[1].stageId !== target.id) { problems.push(`Generate with an edit posted ${generates().length - 1} requests once saved, not 1 for ${target.id}`); }
		return problems;
	};
	return { ...c, name: `${source.name}: an episode card's composer has Generate`, interact: { answer, check } };
}

/**
 * A full episode's canvas as it opens: fitted, between 25 % and 55 %,
 * its segments side by side. Prints the zoom and how many segment frames show whole at opening; the shot is the
 * person's (PDS_RENDER_SHOTS).
 */
async function openingCase(source: Source, episode: string): Promise<Case> {
	const c = await canvasCase(source, episode);
	const check = async (page: Page): Promise<string[]> => {
		await new Promise(resolve => setTimeout(resolve, 500));
		const transform = await page.locator('.react-flow__viewport').first().evaluate(element => (element as { style: { transform: string } }).style.transform);
		const zoom = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1]);
		const pane = await page.locator('.react-flow').first().boundingBox();
		const frames = page.locator('.react-flow__node-frame');
		let whole = 0;
		const count = await frames.count();
		for (let i = 0; i < count; i++) {
			const box = await frames.nth(i).boundingBox();
			if (box && pane && box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height) { whole++; }
		}
		console.log(`    opening zoom ${zoom.toFixed(3)}; ${whole} of ${count} frames whole in a ${pane?.width} × ${pane?.height} pane`);
		if (process.env.PDS_RENDER_SHOTS) { await page.screenshot({ path: join(process.env.PDS_RENDER_SHOTS, `shot-opening-${source.name.replace(/[^\w]+/g, '-')}-${episode}.png`) }); }
		return zoom >= 0.25 - 1e-9 && zoom <= 0.55 + 1e-9 ? [] : [`opened at ${transform}, outside 25 %-55 %`];
	};
	return { ...c, name: `${source.name}: ${episode} opens fitted, 25 %-55 %`, interact: { answer: () => null, check } };
}

/** A Mac's user agent: React Flow takes ⌘ (Meta) for its zoom key only on a Mac (@xyflow/system isMacOs). */
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/**
 * ⌘+wheel and Ctrl+wheel zoom the board on a Mac, wherever the keyboard is. A webview gets key events only while it
 * has the keyboard focus, but a wheel event always carries the modifiers held (UI Events, WheelEvent inherits
 * MouseEvent's metaKey and ctrlKey): with the focus in the workbench, the canvas never sees ⌘ go down, only the wheel.
 * Each wheel is sent over a card and over the empty pane, once after ⌘'s keydown and once without it.
 */
async function wheelZoomCase(source: Source, episode: string): Promise<Case> {
	const c = await canvasCase(source, episode);
	const check = async (page: Page): Promise<string[]> => {
		const problems: string[] = [];
		const scale = async () => (await drawnViewport(page)).zoom;
		const card = page.locator('.react-flow__node-card').first();
		const pane = page.locator('.react-flow__pane').first();
		for (const [where, target] of [['a card', card], ['the pane', pane]] as const) {
			for (const how of ['⌘ (its keydown seen)', '⌘ (its keydown elsewhere)', 'Ctrl'] as const) {
				await page.locator('.bar button[aria-label="Fit"]').click();
				await new Promise(resolve => setTimeout(resolve, 400));
				const box = await target.boundingBox();
				const before = await scale();
				const meta = how !== 'Ctrl';
				if (how === '⌘ (its keydown seen)') { await page.keyboard.down('Meta'); }
				await target.dispatchEvent('wheel', { deltaY: -100, deltaMode: 0, metaKey: meta, ctrlKey: !meta, bubbles: true, cancelable: true, clientX: box!.x + 30, clientY: box!.y + 30 });
				if (how === '⌘ (its keydown seen)') { await page.keyboard.up('Meta'); }
				await new Promise(resolve => setTimeout(resolve, 100));
				const after = await scale();
				if (!(after > before)) { problems.push(`${how}+wheel over ${where} left the zoom at ${after} (was ${before})`); }
			}
		}
		return problems;
	};
	return { ...c, mac: true, name: `${source.name}: ${episode} zooms on ⌘+wheel and Ctrl+wheel`, interact: { answer: () => null, check } };
}

/** The board's pan and zoom as drawn: React Flow's viewport transform. */
async function drawnViewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
	const transform = await page.locator('.react-flow__viewport').first().evaluate(element => (element as { style: { transform: string } }).style.transform);
	const [, x, y, zoom] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform) ?? [];
	return { x: Number(x), y: Number(y), zoom: Number(zoom) };
}

/**
 * The assets canvas opens as the episodes do (openingViewport): a board that fits only below 25 % opens at 25 % with its
 * top-left at the pane's corner (40, 56), not fitted to an unreadable size. A small pane makes the fixture's board too
 * large to fit at 25 %.
 */
async function assetsFloorCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, ASSETS_CANVAS);
	const check = async (page: Page): Promise<string[]> => {
		await new Promise(resolve => setTimeout(resolve, 500));
		const { zoom } = await drawnViewport(page);
		const pane = (await page.locator('.react-flow').first().boundingBox())!;
		const boxes = page.locator('.react-flow__node');
		let [left, top] = [Infinity, Infinity];
		for (let i = 0; i < await boxes.count(); i++) {
			const box = (await boxes.nth(i).boundingBox())!;
			[left, top] = [Math.min(left, box.x - pane.x), Math.min(top, box.y - pane.y)];
		}
		return [
			...(Math.abs(zoom - 0.25) < 1e-6 ? [] : [`opened at ${zoom}, not the 25 % floor`]),
			...(Math.abs(left - 40) < 1 && Math.abs(top - 56) < 1 ? [] : [`the board's top-left is at (${left}, ${top}) in the pane, not (40, 56)`]),
		];
	};
	return { ...c, pane: { width: 320, height: 240 }, name: `${source.name}: the assets canvas too large to fit opens at 25 % at its top-left`, interact: { answer: () => null, check } };
}

/**
 * A canvas opens where the person last left it (the message's viewport), and wherever the board comes to rest is posted
 * back to be kept: here after the bar's Zoom in.
 */
async function savedViewportCase(source: Source, episode: string): Promise<Case> {
	const c = await canvasCase(source, episode);
	// The board's point left in the middle of the pane, and the zoom (CanvasViewport).
	const saved = { x: 500, y: 300, zoom: 0.8 };
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		const problems: string[] = [];
		const pane = (await page.locator('.react-flow').first().boundingBox())!;
		const opened = await drawnViewport(page);
		const want = { x: pane.width / 2 - saved.x * saved.zoom, y: pane.height / 2 - saved.y * saved.zoom, zoom: saved.zoom };
		if (Math.abs(opened.x - want.x) > 0.5 || Math.abs(opened.y - want.y) > 0.5 || opened.zoom !== want.zoom) {
			problems.push(`opened at ${JSON.stringify(opened)}, not ${JSON.stringify(want)} (${saved.x}, ${saved.y} in the middle at ${saved.zoom})`);
		}
		// Zoom in keeps the middle where it is, so what is kept next is the same point at a larger zoom.
		await page.locator('.bar button[aria-label="Zoom in"]').click();
		type Kept = { type?: string; episode?: string; viewport?: { x: number; y: number; zoom: number } };
		const kept = () => (posted as Kept[]).filter(m => m.type === 'viewport' && m.episode === episode && m.viewport!.zoom > saved.zoom);
		for (const until = Date.now() + 2000; !kept().length && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		const last = kept().at(-1)?.viewport;
		if (!last) { problems.push('after Zoom in, no viewport was posted to keep'); }
		else if (Math.abs(last.x - saved.x) > 1 || Math.abs(last.y - saved.y) > 1) { problems.push(`after Zoom in, the middle kept is (${last.x}, ${last.y}), not (${saved.x}, ${saved.y})`); }
		return problems;
	};
	return { ...c, message: { ...(c.message as object), viewport: saved }, name: `${source.name}: ${episode} opens where it was left, and keeps where it rests`, interact: { answer: () => null, check } };
}

/** An element's text as shown, or null when there is none. */
const textOf = async (scope: Locator) => (await scope.count()) === 1 ? scope.evaluate(element => (element as { textContent: string | null }).textContent) : null;

/**
 * A variant's composer shows its base as a reference, sent with it; the reference's click picks the base.
 */
async function variantBoxCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, ASSETS_CANVAS);
	const answer = recordAnswer(source);
	const rain = 'assets/characters/lin/variants/rain';
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		await page.keyboard.press('v');
		await page.locator(`.react-flow__node-card[data-id="${rain}"]`).click({ position: { x: 12, y: 12 } });
		const base = page.locator('.composer .composer-refs .ref');
		if (await base.first().waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return [`${rain}: its composer shows no base`]; }
		if (await base.count() !== 1) { return [`${rain}'s composer shows ${await base.count()} references, not its one base`]; }
		await base.click();
		for (const until = Date.now() + WAIT_MS; !(posted as Posted[]).some(m => m.type === 'inspect' && m.stageId === 'assets/characters/lin') && Date.now() < until;) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return (posted as Posted[]).some(m => m.type === 'inspect' && m.stageId === 'assets/characters/lin') ? [] : ['the base did not pick Lin'];
	};
	return { ...c, name: `${source.name}: a variant's composer shows its base`, interact: { answer, check } };
}

/**
 * A long node name ("Cathedral Hall · Toward th…" twice, the part that tells the cards apart cut off)
 * wraps to two lines inside its card's footer, which still holds its state line. On composed, the office's power-cut variant given a
 * name longer than two lines: the page's own CSS clamps it, so the name box is two lines tall and the footer ends
 * inside the card.
 */
async function longNameCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, ASSETS_CANVAS);
	const id = 'assets/characters/lin/variants/rain';
	const long = 'Toward the lit ceremonial altar, seen from the dungeon entrance under the pillars';
	const message = { ...(c.message as { cards: readonly CanvasCard[] }), cards: (c.message as { cards: readonly CanvasCard[] }).cards.map(x => (x.id === id ? { ...x, label: long } : x)) };
	const check = async (page: Page): Promise<string[]> => {
		const node = page.locator(`.react-flow__node-card[data-id="${id}"]`);
		if (await node.waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return [`no card ${id}`]; }
		type Box = { clientHeight: number; textContent: string | null; getBoundingClientRect(): { bottom: number } };
		const seen = await node.evaluate(element => {
			const find = (selector: string) => (element as { querySelector(s: string): Box | null }).querySelector(selector);
			const [name, foot, card] = [find('.card-name'), find('.card-foot'), find('.card')];
			const style = (globalThis as unknown as { getComputedStyle(e: unknown): { lineHeight: string } }).getComputedStyle(name);
			return name && foot && card && { height: name.clientHeight, line: parseFloat(style.lineHeight), text: name.textContent, footBottom: foot.getBoundingClientRect().bottom, cardBottom: card.getBoundingClientRect().bottom };
		});
		if (!seen) { return ['the card has no name, footer or card box']; }
		return [
			...(seen.text === long ? [] : [`the name reads ${JSON.stringify(seen.text)}`]),
			...(seen.height === 2 * seen.line ? [] : [`the name is ${seen.height} px tall, not two lines of ${seen.line} px`]),
			...(seen.footBottom <= seen.cardBottom + 0.5 ? [] : [`the footer ends at ${seen.footBottom}, below the card's bottom ${seen.cardBottom}`]),
		];
	};
	return { ...c, message, name: `${source.name}: a long node name wraps to two lines in its card`, interact: { answer: () => null, check } };
}

/**
 * The canvas tools: the canvas opens with Hand pressed (the person's choice); V presses Select, H presses Hand again.
 * Each shows its cursor: Select the arrow, also while a card is dragged (the person, after LibTV), and the open hand while
 * Space is held; Hand the open hand, as tldraw's; either a closed hand while the board pans.
 * Read where the pointer is: over the empty board, a card, and a frame's margin (most of the board is inside a frame).
 * What a click and a double-click do with each is clickModelCase's.
 */
async function toolsCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, ASSETS_CANVAS);
	const check = async (page: Page): Promise<string[]> => {
		const problems: string[] = [];
		const pressed = async () => [await page.locator('.bar button[aria-label="Select"]').getAttribute('aria-pressed'), await page.locator('.bar button[aria-label="Hand"]').getAttribute('aria-pressed')].join(' ');
		if (await pressed() !== 'false true') { problems.push(`on opening, Select and Hand are pressed ${await pressed()}, not "false true"`); }
		// Read again each time: a pan moves the cards and frames.
		const places = async () => {
			const pane = (await page.locator('.react-flow__pane').first().boundingBox())!;
			const card = (await page.locator('.react-flow__node-card').first().boundingBox())!;
			const frame = (await page.locator('.react-flow__node-frame').first().boundingBox())!;
			return { 'the board': { x: pane.x + pane.width - 8, y: pane.y + pane.height / 2 }, 'a card': { x: card.x + card.width / 2, y: card.y + card.height / 2 }, 'a frame': { x: frame.x + 6, y: frame.y + frame.height - 6 } };
		};
		type Doc = { elementFromPoint(x: number, y: number): unknown };
		const cursor = (at: { x: number; y: number }) => page.evaluate(({ x, y }) => (globalThis as unknown as { getComputedStyle(e: unknown): { cursor: string } })
			.getComputedStyle((globalThis as unknown as { document: Doc }).document.elementFromPoint(x, y)).cursor, at);
		const cursors = async (tool: string, want: string) => {
			for (const [where, at] of Object.entries(await places())) {
				const shown = await cursor(at);
				if (shown !== want) { problems.push(`with ${tool}, the cursor over ${where} is ${shown}, not ${want}`); }
			}
		};
		await cursors('Hand', 'grab');
		// A pan by drag, from a frame's margin: the hand closes while the board moves.
		const from = (await places())['a frame'];
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x + 40, from.y + 30);
		const panning = await cursor({ x: from.x + 40, y: from.y + 30 });
		await page.mouse.up();
		if (panning !== 'grabbing') { problems.push(`with Hand, the cursor while the board pans is ${panning}, not grabbing`); }
		await page.keyboard.press('v');
		await cursors('Select', 'default');
		// A drag from a card's middle: whether React Flow drags that card (its .dragging) and the board's move, and the cursor,
		// read once the drag has started (one step past React Flow's threshold; the card itself is not carried further).
		const drag = async (steps: number) => {
			const node = page.locator('.react-flow__node-card').first();
			const [card, board] = [(await node.boundingBox())!, await drawnViewport(page)];
			const at = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
			await page.mouse.move(at.x, at.y);
			await page.mouse.down();
			for (let i = 1; i <= steps; i++) { await page.mouse.move(at.x + 40 * i / steps, at.y + 30 * i / steps); }
			const [shown, dragged] = [await cursor({ x: at.x + 40, y: at.y + 30 }), /\bdragging\b/.test(await node.getAttribute('class') ?? '')];
			await page.mouse.up();
			const panned = await drawnViewport(page);
			return { shown, dragged, board: Math.hypot(panned.x - board.x, panned.y - board.y) };
		};
		// With Select a drag drags the card, the arrow staying (the person, after LibTV).
		const moved = await drag(1);
		if (!moved.dragged || moved.board > 0.5) { problems.push(`with Select, a drag from a card ${moved.dragged ? '' : 'did not drag it and '}moved the board ${moved.board.toFixed(0)} px`); }
		if (moved.shown !== 'default') { problems.push(`with Select, the cursor while a card is dragged is ${moved.shown}, not default`); }
		// Whatever the drag left picked is dropped, so no composer stands where the cursor is read next.
		await page.keyboard.press('Escape');
		// With Select, Space held is the Hand for that while (tldraw's and Figma's spacebar): the open hand at once, and a
		// drag from a card pans the board, the hand closed.
		await page.keyboard.down('Space');
		await new Promise(resolve => setTimeout(resolve, 100));
		await cursors('Select with Space held', 'grab');
		const spaced = await drag(2);
		await page.keyboard.up('Space');
		await new Promise(resolve => setTimeout(resolve, 100));
		if (spaced.dragged || spaced.board < 10) { problems.push(`with Select and Space held, a drag from a card ${spaced.dragged ? 'dragged it and ' : ''}panned the board ${spaced.board.toFixed(0)} px`); }
		if (spaced.shown !== 'grabbing') { problems.push(`with Select and Space held, the cursor while the board pans is ${spaced.shown}, not grabbing`); }
		await cursors('Select once Space is let go', 'default');
		if (await pressed() !== 'true false') { problems.push(`after V, Select and Hand are pressed ${await pressed()}, not "true false"`); }
		await page.keyboard.press('h');
		if (await pressed() !== 'false true') { problems.push(`after H, Select and Hand are pressed ${await pressed()}, not "false true"`); }
		await cursors('Hand again', 'grab');
		return problems;
	};
	return { ...c, name: `${source.name}: the canvas tools, Select and Hand`, interact: { answer: () => null, check } };
}

/**
 * A click and a double-click on a card, by tool, after tldraw's (HandTool.ts, SelectTool): with Hand a click picks
 * nothing and a double-click zooms in at the pointer; with Select a click picks the card and opens its composer without
 * moving the board, and a double-click fits the card in the view. Nothing opens a file in a tab. The composer is a part
 * of the board, flat (as LibTV's): a wheel over it pans the board, and its height is its text's, so a long prompt, as
 * long as a real take's (about 7000 characters in 27 lines), is read by panning the board down, with nothing clipped.
 */
async function clickModelCase(source: Source, episode: string): Promise<Case> {
	const c = await canvasCase(source, episode);
	const id = episode === ASSETS_CANVAS ? ((c.message as { cards?: readonly CanvasCard[] }).cards ?? []).find(onBoard)?.id : 'episodes/EP001/segments/seg01';
	const prompt = Array.from({ length: 27 }, (_, i) => `Line ${i + 1}: ${'the camera holds on the subject while the light shifts slowly across the room. '.repeat(3)}`).join('\n');
	const answer = (m: { type?: string; stageId?: string }) => m.type !== 'inspect' || !m.stageId ? null
		: { v: CANVAS_PROTOCOL, type: 'detail', stageId: m.stageId, version: null, detail: null, error: null, prompt: { object: m.stageId, text: prompt } };
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		if (!id) { return [`the ${episode} canvas has no card`]; }
		const problems: string[] = [];
		const settle = () => new Promise(resolve => setTimeout(resolve, 700));
		const node = page.locator(`.react-flow__node-card[data-id="${id}"]`);
		const composer = page.locator('.composer');
		const inspects = () => posted.filter(m => (m as { type?: string }).type === 'inspect').length;
		const at = { position: { x: 12, y: 12 } };
		// Hand: a click picks nothing; a double-click zooms in.
		await node.click(at);
		await settle();
		const selected = page.locator('.react-flow__node.selected');
		if (inspects() || await composer.count() || await selected.count()) { problems.push(`a click with Hand posted ${inspects()} inspects, shows ${await composer.count()} composers and selects ${await selected.count()} cards`); }
		const zoom = (await drawnViewport(page)).zoom;
		await node.dblclick(at);
		await settle();
		if (!((await drawnViewport(page)).zoom > zoom)) { problems.push(`a double-click with Hand left the zoom at ${(await drawnViewport(page)).zoom} (was ${zoom})`); }
		if (inspects()) { problems.push('a double-click with Hand picked the card'); }
		// Select: a click picks, and the board stays where it is, also once the reply has come.
		await page.keyboard.press('v');
		await page.locator('.bar button[aria-label="Fit"]').click();
		await settle();
		const before = await drawnViewport(page);
		await node.click(at);
		if (await composer.locator('textarea').waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return [...problems, 'a click with Select opened no composer with its text']; }
		await settle();
		if (inspects() !== 1) { problems.push(`a click with Select posted ${inspects()} inspects, not 1`); }
		const picked = await drawnViewport(page);
		if (Math.abs(picked.x - before.x) > 0.5 || Math.abs(picked.y - before.y) > 0.5 || picked.zoom !== before.zoom) { problems.push(`the click moved the board from ${JSON.stringify(before)} to ${JSON.stringify(picked)}`); }
		// The composer is the board's: its height is its text's, nothing in it scrolls, and a wheel over it pans the board
		// down to its end.
		type Scroller = { scrollHeight: number; clientHeight: number; querySelector(selector: string): Scroller | null };
		const clipped = await composer.evaluate(element => [element as Scroller, (element as Scroller).querySelector('textarea')!]
			.filter(e => e.scrollHeight > e.clientHeight + 1).map(e => `${e.scrollHeight} px in ${e.clientHeight} px`));
		if (clipped.length) { problems.push(`the composer clips its text: ${clipped.join(', ')}`); }
		const pane = (await page.locator('.react-flow').first().boundingBox())!;
		const wheel = async () => {
			const box = (await composer.boundingBox())!;
			await composer.dispatchEvent('wheel', { deltaY: 200, deltaMode: 0, bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: Math.max(box.y, pane.y) + 20 });
			await new Promise(resolve => setTimeout(resolve, 50));
		};
		await wheel();
		const wheeled = await drawnViewport(page);
		if (!(wheeled.y < picked.y - 1)) { problems.push(`a wheel over the composer left the board at y ${wheeled.y} (was ${picked.y})`); }
		for (let i = 0; i < 60 && (await composer.boundingBox())!.y + (await composer.boundingBox())!.height > pane.y + pane.height; i++) { await wheel(); }
		const end = (await composer.boundingBox())!;
		if (end.y + end.height > pane.y + pane.height) { problems.push(`panning down over the composer never reached its end (${end.y + end.height} px, the pane ends at ${pane.y + pane.height})`); }
		// Select: a double-click fits the card in the view (Fit first: the panning above took the card off the pane).
		await page.locator('.bar button[aria-label="Fit"]').click();
		await settle();
		await node.dblclick(at);
		await settle();
		const card = (await node.boundingBox())!;
		const off = Math.max(Math.abs(card.x + card.width / 2 - (pane.x + pane.width / 2)), Math.abs(card.y + card.height / 2 - (pane.y + pane.height / 2)));
		const fill = Math.max(card.width / pane.width, card.height / pane.height);
		if (off > 2 || fill < 0.7 || fill > 1) { problems.push(`a double-click with Select left the card ${off.toFixed(0)} px off the middle, filling ${(fill * 100).toFixed(0)} % of the view`); }
		if (posted.some(m => (m as { type?: string }).type === 'open')) { problems.push('a double-click asked to open a file in a tab'); }
		return problems;
	};
	return { ...c, name: `${source.name}: ${episode}, a click and a double-click with each tool`, interact: { answer, check } };
}

/**
 * An undrawn asset card: its footer names it and says "Not drawn yet"; its composer's Upload imports a picture for it
 * (an `entry` import for that card).
 */
async function faceCase(source: Source): Promise<Case> {
	const c = await canvasCase(source, ASSETS_CANVAS);
	const answer = recordAnswer(source);
	const street = 'assets/scenes/street';
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		const problems: string[] = [];
		const card = page.locator(`.react-flow__node-card[data-id="${street}"]`);
		if (await card.locator('.card-foot .card-name').count() !== 1) { problems.push('the footer has no name'); }
		if (await textOf(card.locator('.card-status.warn')) !== 'Not drawn yet') { problems.push('the footer does not say Not drawn yet'); }
		await page.keyboard.press('v');
		await card.click({ position: { x: 12, y: 12 } });
		const upload = page.locator('.composer button:has-text("Upload")');
		if (await upload.waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { return [...problems, 'its composer has no Upload']; }
		await upload.click();
		for (const until = Date.now() + 3000; !entries(posted, 'import').length && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		const sent = entries(posted, 'import')[0];
		if (!sent) { problems.push('Upload sent no import'); }
		else if (sent.request?.object !== street) { problems.push(`the import was for ${sent.request?.object}, the card is ${street}`); }
		return problems;
	};
	return { ...c, name: `${source.name}: an undrawn asset card, and Upload`, interact: { answer, check } };
}

/** A draft's fields stop at the protocol's limits (galleryProtocol NAME_MAX, TEXT_MAX), as the page renders them. */
async function draftLimits(scope: Locator, name: string, text: string, what: string): Promise<string[]> {
	const problems: string[] = [];
	for (const [selector, limit] of [[name, NAME_MAX], [text, TEXT_MAX]] as const) {
		const field = scope.locator(selector);
		if (await field.waitFor({ timeout: WAIT_MS }).then(() => false, () => true)) { problems.push(`${what} shows no ${selector}`); continue; }
		const max = await field.getAttribute('maxlength');
		if (max !== String(limit)) { problems.push(`${what}'s ${selector} takes ${max ?? 'any length'}, not ${limit}`); }
	}
	return problems;
}

async function galleryCase(source: Source, kind: Collection): Promise<Case> {
	const name = `${source.name}: ${kind}`;
	{
		const message = await galleryPageMessage({ root: source.root, drama: source.drama, kind, src: fileSrc });
		const grid = message.sections[0];
		// Create New's draft stops at what readFromGallery takes.
		const check = async (page: Page): Promise<string[]> => {
			await page.locator('.grid .card:has-text("Create New")').first().click();
			return draftLimits(page.locator('.grid'), 'input.draft-name', 'textarea.draft-text', 'Create New');
		};
		return { name, page: 'gallery', data: { gallery: kind }, root: source.root, message,
			expect: { selector: '.grid .card', count: grid.tiles.length + (grid.add ? 1 : 0) },
			...(grid.add ? { interact: { answer: () => null, check } } : {}) };
	}
}

/**
 * A drawn grid card (the person's 751.png): its caption is its needed count or nothing; a click opens the
 * assets canvas on it (`open`), never a picture; and its picture is shown whole (contain), as the canvas card shows it.
 */
async function gridClickCase(source: Source): Promise<Case> {
	const message = await galleryPageMessage({ root: source.root, drama: source.drama, kind: 'characters', src: fileSrc });
	const [first] = message.sections[0].tiles;
	const shown = message;
	const check = async (page: Page, posted: readonly unknown[]): Promise<string[]> => {
		const problems: string[] = [];
		const card = page.locator('.grid .card').first();
		if (await card.locator('img').count() !== 1) { return ['the drawn card shows no picture']; }
		const fit = await card.locator('img').first().evaluate(img => (globalThis as unknown as { getComputedStyle(e: unknown): { objectFit: string } }).getComputedStyle(img).objectFit);
		if (fit !== 'contain') { problems.push(`the card's picture is cropped (object-fit ${fit}), not shown whole`); }
		const line = await card.locator('.visuals').count() ? 'its count' : 'nothing';
		if ((line === 'nothing') !== !first.visuals?.needed) { problems.push(`the caption shows ${line}, needed ${first.visuals?.needed ?? 0}`); }
		await card.locator('button.tile').first().click();
		for (const until = Date.now() + 2000; !posted.some(m => (m as { type?: string }).type === 'open') && Date.now() < until;) { await new Promise(resolve => setTimeout(resolve, 50)); }
		const opened = posted.find(m => (m as { type?: string }).type === 'open') as { stagePath?: string } | undefined;
		if (opened?.stagePath !== first.stagePath) { problems.push(`the click posted ${JSON.stringify(posted.map(m => (m as { type?: string }).type))}, not open on ${first.stagePath}`); }
		return problems;
	};
	return { name: `${source.name}: a grid card's click, caption and picture`, page: 'gallery', data: { gallery: 'characters' }, root: source.root, message: shown,
		expect: { selector: '.grid .card', count: message.sections[0].tiles.length + (message.sections[0].add ? 1 : 0) }, interact: { answer: () => null, check } };
}

async function segCase(source: Source, episode: string): Promise<Case> {
	const model = segEditorModel(source.drama, episode, fileSrc);
	return { name: `${source.name}: seg editor ${episode}`, page: 'seg', data: { episode }, root: source.root, message: { v: SEG_PROTOCOL, type: 'model', model },
		expect: { selector: '.strip .seg', count: model.segs.length + 1 } };
}

// The few calls of playwright-core this test makes, typed here: it is installed outside the repository (PDS_PLAYWRIGHT).
interface Route { request(): { url(): string }; fulfill(response: { status: number; contentType?: string; body?: Buffer | string }): Promise<void> }
interface ConsoleMessage { type(): string; text(): string }
interface Page {
	route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
	exposeFunction(name: string, fn: (value: unknown) => unknown): Promise<void>;
	addInitScript(script: string): Promise<void>;
	on(event: 'pageerror', handler: (error: Error) => void): void;
	on(event: 'console', handler: (message: ConsoleMessage) => void): void;
	goto(url: string): Promise<unknown>;
	locator(selector: string): Locator;
	getByText(text: string): { first(): { waitFor(options: { timeout: number }): Promise<void> } };
	screenshot(options: { path: string }): Promise<unknown>;
	readonly keyboard: { press(key: string): Promise<void>; down(key: string): Promise<void>; up(key: string): Promise<void> };
	readonly mouse: { move(x: number, y: number): Promise<void>; down(): Promise<void>; up(): Promise<void> };
	evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
}
interface Locator {
	count(): Promise<number>;
	first(): Locator;
	nth(index: number): Locator;
	locator(selector: string): Locator;
	click(options?: { position: { x: number; y: number } }): Promise<void>;
	dblclick(options?: { position: { x: number; y: number } }): Promise<void>;
	fill(value: string): Promise<void>;
	inputValue(): Promise<string>;
	getAttribute(name: string): Promise<string | null>;
	evaluate<T>(fn: (element: unknown) => T): Promise<T>;
	isDisabled(): Promise<boolean>;
	dispatchEvent(type: string, init: Record<string, unknown>): Promise<void>;
	waitFor(options: { timeout: number; state?: 'detached' }): Promise<void>;
	boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}
interface Browser { newContext(options?: { viewport?: { width: number; height: number }; userAgent?: string }): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>; close(): Promise<void> }

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.json': 'application/json' };

/** Loads one case and returns what went wrong, if anything. */
async function render(browser: Browser, c: Case): Promise<string[]> {
	const problems: string[] = [];
	const context = await browser.newContext({ ...(c.pane ? { viewport: c.pane } : process.env.PDS_RENDER_SHOTS ? { viewport: { width: 1600, height: 1000 } } : {}), ...(c.mac ? { userAgent: MAC } : {}) });
	try {
		const page = await context.newPage();
		const html = webviewPageHtml(c.page, c.name, c.data, { src: name => `${ORIGIN}/media/${name}`, cspSource: ORIGIN, nonce: 'render-smoke' });
		await page.route(`${ORIGIN}/**`, async route => {
			const path = decodeURIComponent(new URL(route.request().url()).pathname);
			const file = path === '/' ? undefined : path.startsWith('/media/') ? join(MEDIA, path.slice('/media/'.length)) : path.startsWith('/project/') ? join(c.root, path.slice('/project/'.length)) : undefined;
			if (path === '/') { return route.fulfill({ status: 200, contentType: 'text/html', body: html }); }
			try {
				await route.fulfill({ status: 200, contentType: TYPES[extname(file!).toLowerCase()] ?? 'application/octet-stream', body: readFileSync(file!) });
			} catch {
				await route.fulfill({ status: 404 });
			}
		});
		page.on('pageerror', error => problems.push(`page error: ${error.message}`));
		page.on('console', message => { if (message.type() === 'error') { problems.push(`console error: ${message.text()}`); } });
		// The webview API the pages call (acquireVsCodeApi): the page's messages come here, and 'ready' is answered with the
		// case's message, as the extension answers it. The answer comes back as the binding's result and is posted by the
		// init script, so nothing is evaluated in the page: the page's policy allows no eval, and Playwright's evaluate trips it.
		const posted: unknown[] = [];
		await page.exposeFunction('renderSmokeFromPage', value => {
			const m = value as { type?: string; message?: string; stageId?: string; version?: string | null };
			posted.push(m);
			if (m.type === 'failed') { problems.push(`the page said it failed: ${m.message}`); }
			return m.type === 'ready' ? c.message : c.interact ? c.interact.answer(m) : null;
		});
		await page.addInitScript(`window.acquireVsCodeApi = () => ({ postMessage: m => window.renderSmokeFromPage(m).then(reply => { if (reply) { window.postMessage(reply, '*'); } }), getState: () => undefined, setState: () => {} });`);
		if (process.env.PDS_RENDER_SHOTS) {
			// For review shots only: VS Code's Dark Modern colours, approximated; a webview gets them from the workbench.
			await page.addInitScript(`document.addEventListener('DOMContentLoaded', () => { document.body.classList.add('vscode-dark'); const s = document.createElement('style'); s.textContent = ':root{--vscode-editor-background:#1f1f1f;--vscode-foreground:#cccccc;--vscode-editorWidget-background:#202020;--vscode-widget-border:#313131;--vscode-editorWidget-border:#454545;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-focusBorder:#0078d4;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-editorWarning-foreground:#cca700;--vscode-editorWhitespace-foreground:#3b3b3b;--vscode-panel-border:#2b2b2b;--vscode-font-family:sans-serif}'; document.head.appendChild(s); });`);
		}
		await page.goto(`${ORIGIN}/`);
		const expect = c.expect;
		if ('text' in expect) {
			await page.getByText(expect.text).first().waitFor({ timeout: WAIT_MS }).catch(() => problems.push(`the page does not say: ${expect.text}`));
		} else if (expect.count === 0) {
			problems.push(`the message holds no card to render (${expect.selector}); this case shows nothing`);
		} else {
			const cards = page.locator(expect.selector);
			const until = Date.now() + WAIT_MS;
			let shown = await cards.count();
			while (shown < expect.count && Date.now() < until) {
				await new Promise(resolve => setTimeout(resolve, 100));
				shown = await cards.count();
			}
			if (shown !== expect.count) { problems.push(`${shown} of ${expect.count} cards rendered (${expect.selector})`); }
			if (process.env.PDS_RENDER_SHOTS) { mkdirSync(process.env.PDS_RENDER_SHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.PDS_RENDER_SHOTS, `shot-${c.name.replace(/[^\w]+/g, '-')}.png`) }); }
			if (c.interact && !problems.length) { problems.push(...await c.interact.check(page, posted)); }
		}
	} finally {
		await context.close();
	}
	return problems;
}

async function main(): Promise<number> {
	const started = Date.now();
	const require = createRequire(join(process.env.PDS_PLAYWRIGHT ?? '', 'node_modules', 'x.js'));
	const { chromium } = require('playwright-core') as { chromium: { launch(options: { headless: boolean }): Promise<Browser> } };
	// The protocol fixture (test-fixtures/protocol/README.md): the Project Chat's snapshot, then an episode session's.
	const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Snapshot;
	const root = join(FIXTURES, 'drama');
	const readFixture = () => readDrama(root, () => [
		{ scope: 'project', snapshot: read('snapshot-project.json'), task: 'task-1', sent: '2026-11-12T13:00:00Z', installed: '2026-11-12T13:01:00Z' },
		{ scope: 'episodes', snapshot: read('snapshot-episodes.json'), task: 'task-2', sent: '2026-11-12T13:02:00Z', installed: '2026-11-12T13:03:00Z' },
	]);
	const source: Source = { name: 'protocol fixture', root, drama: await readFixture() };
	const cases: Case[] = [
		await canvasCase(source, ASSETS_CANVAS), await boxCase(source), await faceCase(source), await toolsCase(source), await clickModelCase(source, ASSETS_CANVAS), await variantBoxCase(source), await longNameCase(source),
		await canvasCase(source, 'EP001'), await takeLinesCase({ ...source, drama: await readFixture() }), await openingCase(source, 'EP001'), await episodeBoxCase(source), await clickModelCase(source, 'EP001'),
		await wheelZoomCase(source, ASSETS_CANVAS), await wheelZoomCase(source, 'EP001'),
		await assetsFloorCase(source), await savedViewportCase(source, ASSETS_CANVAS), await savedViewportCase(source, 'EP001'),
		await galleryCase(source, 'characters'), await galleryCase(source, 'scenes'), await galleryCase(source, 'props'), await gridClickCase(source),
		await segCase(source, 'EP001'),
	];
	const browser = await chromium.launch({ headless: true });
	let failed = 0;
	try {
		for (const c of cases) {
			const t = Date.now();
			const problems = await render(browser, c);
			failed += problems.length ? 1 : 0;
			const what = 'text' in c.expect ? 'its error shown' : `${c.expect.count} cards`;
			console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}: ${what} (${Date.now() - t} ms)`);
			for (const p of problems) { console.log(`    ${p}`); }
		}
	} finally {
		await browser.close();
	}
	console.log(`render smoke: ${cases.length - failed} of ${cases.length} pages rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`);
	return failed ? 1 : 0;
}

main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });
