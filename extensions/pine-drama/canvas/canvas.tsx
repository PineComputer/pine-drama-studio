// The episode canvas on React Flow (@xyflow/react 12.12.0, MIT;
// spike S11), on the messages of core/canvasProtocol.ts. React Flow gives pan, zoom, selection and dragging; this file
// gives the cards, the frames, drama-cli's links (thin, on by default: the person), the layout's
// persistence and a layout-only undo/redo. The rest is the workbench's: a click shows the stage in the Versions
// view, a double-click opens the shown file in the native viewer. React Flow's attribution stays visible: removing it
// needs React Flow Pro (reactflow.dev/learn/troubleshooting/remove-attribution).
import { createRoot } from 'react-dom/client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	applyNodeChanges, Background, BackgroundVariant, Handle, MiniMap, NodeToolbar, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewport,
	type Edge, type Node, type NodeChange, type NodeProps, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// The workbench's own icons, at the version the pinned Code-OSS uses (its package.json: @vscode/codicons ^0.0.46-49).
import '@vscode/codicons/dist/codicon.css';
import './canvas.css';
import { NAME_MAX, TEXT_MAX, type EntryAction } from '../src/core/galleryProtocol';
import { ASSETS_CANVAS, CANVAS_PROTOCOL, opensFile, type CanvasCard, type CanvasPicture, type CanvasCommand, type CanvasViewport, type FromCanvas, type Point, type Size, type ToCanvas } from '../src/core/canvasProtocol';
import { CANVAS_WAIT_LIMIT_S, waitingText } from '../src/core/canvasWait';
import { PictureRef, RequestView } from './requestView';
import { cardSize, layoutAssets, layoutEpisode, layoutOf, onBoard, openingViewport, positionsFor } from '../src/core/canvasLayout';

declare function acquireVsCodeApi(): { postMessage(message: FromCanvas): void; setState(state: { episode: string }): void };
const vscode = acquireVsCodeApi();
vscode.setState({ episode: document.body.dataset.episode ?? '' });
const post = (message: FromCanvas) => vscode.postMessage(message);
const fail = (message: string) => post({ v: CANVAS_PROTOCOL, type: 'failed', message });
window.addEventListener('error', event => fail(`${event.message} (${event.filename}:${event.lineno})`));
window.addEventListener('unhandledrejection', event => fail(`unhandled rejection: ${String(event.reason)}`));
document.addEventListener('securitypolicyviolation', event => fail(`blocked by the content security policy: ${event.violatedDirective} ${event.blockedURI}`));

type Lineage = Extract<ToCanvas, { type: 'lineage' }>;
/** Board commands arrive from the extension (keybindings scoped to the focused canvas) as this window event. */
const COMMAND = 'pine-canvas-command';
/** A version's detail, for the picked card, arrives as this window event. */
const DETAIL = 'pine-canvas-detail';
/** A record panel's action ended (actionEnded): its key, drama-cli's words when it failed, and the line when it wrote nothing. */
const ACTION_ENDED = 'pine-canvas-action-ended';
/** The board's zoom range, React Flow's minZoom and maxZoom. */
const ZOOM = { min: 0.05, max: 4 };
// Generate with an unsaved edit: the request goes to the chat once that save is written, never after a refused one.
// Held here, not in the composer, so closing it or picking another card before the save ends drops no request: the composer is keyed by its card and unmounts with its listeners.
const generateOnceSaved = new Map<string, string>();
window.addEventListener(ACTION_ENDED, event => {
	const { key, error } = (event as CustomEvent<{ key: string; error: string | null }>).detail;
	const stageId = generateOnceSaved.get(key);
	if (stageId && generateOnceSaved.delete(key) && !error) { post({ v: CANVAS_PROTOCOL, type: 'generate', stageId }); }
});
type DetailMessage = Extract<ToCanvas, { type: 'detail' }>;
/** The zoom a board opens at, its frames' top-left corner near the top-left of the pane: readable, not fitted to dots. A starting value (open-pinedrama used 0.55). */
type Layout = Record<string, Point>;
/** A picture's own size, or why it could not be read. */
type Loaded = { size: Size } | { error: string };
type CardData = { card: CanvasCard; loaded: Loaded | undefined };
type CardNode = Node<CardData, 'card'>;
type FrameNode = Node<{ title: string }, 'frame'>;
type HeadingNode = Node<{ title: string }, 'heading'>;
type AnyNode = CardNode | FrameNode | HeadingNode;

/** Reads a picture's or video's own size from the file, as the browser decodes it. */
function measure(card: CanvasCard): Promise<Loaded> {
	return new Promise(resolve => {
		const done = (value: Loaded) => {
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => done({ error: 'did not load within 15 s' }), 15000);
		if (card.media === 'image') {
			const img = new Image();
			img.onload = () => done({ size: { w: img.naturalWidth, h: img.naturalHeight } });
			img.onerror = () => done({ error: 'could not be decoded or read' });
			img.src = card.src!;
		} else {
			const video = document.createElement('video');
			video.preload = 'metadata';
			video.muted = true;
			video.onloadedmetadata = () => done({ size: { w: video.videoWidth, h: video.videoHeight } });
			video.onerror = () => done({ error: video.error?.message || 'could not be decoded or read' });
			video.src = card.src!;
		}
	});
}

/**
 * A card's state in words, the same on both canvases: made and approved, made and not approved yet, or not made yet;
 * the parts it is written in; the episodes an asset is used in. No version numbers: those are the Versions view's.
 */
function statusOf(card: CanvasCard): string {
	const made = !!card.version && !card.planned;
	const state = !made ? (card.kind === 'take' || card.kind === 'cut' ? 'Not shot yet' : 'Not drawn yet') : card.accepted === card.version ? 'Approved' : 'Not approved yet';
	return [state, card.parts ? `written in ${card.parts} parts` : '', card.appearsIn?.length ? `used in ${card.appearsIn.join(', ')}` : ''].filter(Boolean).join(' · ');
}

/** What stands where the picture would: each state says what is actually known (review, finding 4). */
function Placeholder({ card, loaded }: CardData) {
	const text = card.planned || !card.version ? 'Not drawn yet'
		: !card.file ? `${card.version} names no picture`
		: card.missing ? `File missing: ${card.file}`
		: loaded && 'error' in loaded ? `Could not load ${card.file}: ${loaded.error}`
		: 'Loading…';
	return <div className="placeholder" title={text}>{text}</div>;
}

const hiddenHandle = { opacity: 0, pointerEvents: 'none' as const, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

/** An asset node listed with nothing drawn, the one case its face says in its footer; every failure stays in the picture. */
/** An assets card's full name, "<asset> · <node>": its tooltip's and its box's, where no frame title stands beside it. */
const fullName = (card: CanvasCard) => (card.name ? `${card.name.asset} · ${card.name.node}` : card.label);

/** The canvas's two tools, tldraw's select and hand, and their keys, tldraw's V and H. */
type Tool = 'select' | 'hand';
const TOOL_KEYS: Readonly<Record<string, Tool>> = { v: 'select', h: 'hand' };

/** A card's marks of the person's choices: the outgoing arrow, an add in flight, the last problem. */
function CardMarks({ card }: { card: CanvasCard }) {
	return (
		<>
			{card.outgoing && <span className="mark codicon codicon-arrow-up" title={card.outgoing} aria-label={card.outgoing} />}
			{card.inFlight && <div className="mark-line"><span className="codicon codicon-loading codicon-modifier-spin" /> {card.inFlight}</div>}
			{card.problem && <div className="mark-line warn">{[card.problem.message, card.problem.action].filter(Boolean).join(' ')}</div>}
		</>
	);
}

/**
 * A card, the same on both canvases (the person's design): the picture (a take plays on hover), its name, and its state
 * (statusOf). No version numbers, prompt or record labels: those are the composer's and the Versions view's.
 */
const CardView = memo(({ data, selected, width, height }: NodeProps<CardNode>) => {
	const { card, loaded } = data;
	const video = useRef<HTMLVideoElement>(null);
	const size = loaded && 'size' in loaded ? loaded.size : undefined;
	const shows = card.src && size;
	const status = statusOf(card);
	return (
		<div className={`card${card.notUsable ? ' stale' : ''}${selected ? ' selected' : ''}`} style={{ width, height }}
			title={`${fullName(card)}\n${status}${card.notUsable ? `\n${card.notUsable}` : ''}\nClick: its composer${opensFile(card) ? ` · Double-click: open ${card.file ?? 'nothing'}` : ''}`}>
			<Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} />
			<div className="media"
				onMouseEnter={() => void video.current?.play().catch(() => undefined)}
				onMouseLeave={() => video.current?.pause()}>
				{shows && card.media === 'image' && <img src={card.src!} draggable={false} />}
				{/* #t=0.5: frame 0 of a take is often black (canvas-scope #30). Hover plays muted; leaving pauses where it is (#31). */}
				{shows && card.media === 'video' && <><video ref={video} src={`${card.src}#t=0.5`} preload="metadata" muted playsInline loop /><span className="play codicon codicon-play" /></>}
				{!shows && <Placeholder card={card} loaded={loaded} />}
			</div>
			<CardMarks card={card} />
			<div className="card-foot">
				<div className="card-name">{card.label}</div>
				<div className={`card-status${card.version && !card.planned ? '' : ' warn'}`}>{status}</div>
			</div>
			<Handle type="source" position={Position.Right} isConnectable={false} style={hiddenHandle} />
		</div>
	);
});

const FrameView = memo(({ data }: NodeProps<FrameNode>) => <div className="frame"><div className="frame-title">{data.title}</div></div>);
const HeadingView = memo(({ data }: NodeProps<HeadingNode>) => <div className="region-heading">{data.title}</div>);
const nodeTypes = { card: CardView, frame: FrameView, heading: HeadingView };

const same = (a: Layout, b: Layout) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, p]) => b[k]?.x === p.x && b[k]?.y === p.y);

/** The nodes for a lineage at the given places; a frame is as large as its cards wherever they stand. */
function nodesFor(message: Lineage, loaded: Record<string, Loaded>, place: Layout): AnyNode[] {
	const sizes = sizesOf(message, loaded);
	const nodes: AnyNode[] = [];
	for (const title of message.sections) {
		const members = message.cards.filter(c => c.section === title && onBoard(c) && place[c.id]);
		const frameId = `frame:${title}`;
		if (!members.length) {
			continue;
		}
		const w = Math.max(...members.map(c => place[c.id].x + sizes[c.id].w)) + 20;
		const h = Math.max(...members.map(c => place[c.id].y + sizes[c.id].h)) + 20;
		nodes.push({ id: frameId, type: 'frame', position: place[frameId], data: { title: message.titles?.[title] ?? title }, width: w, height: h, style: { width: w, height: h }, zIndex: 0 });
		for (const card of members) {
			nodes.push({ id: card.id, type: 'card', parentId: frameId, position: place[card.id], data: { card, loaded: loaded[card.id] }, width: sizes[card.id].w, height: sizes[card.id].h, zIndex: 1 });
		}
	}
	// Each kind region's heading on the assets canvas (layoutAssets), named as drama-cli's folders.
	for (const [id, position] of Object.entries(place).filter(([id]) => id.startsWith('heading:'))) {
		nodes.push({ id, type: 'heading', position, data: { title: id.slice('heading:'.length) }, draggable: false, selectable: false, zIndex: 0 });
	}
	return nodes;
}

/**
 * The view a board opens at, and Lay out again takes (canvasLayout.ts openingViewport: fitted, 25 % to 55 %): from its
 * top-level nodes' boxes and the pane, which App draws before the board mounts (`.canvas`).
 */
function paneSize(): Size {
	const pane = document.querySelector('.canvas')?.getBoundingClientRect();
	return { w: pane?.width || window.innerWidth, h: pane?.height || window.innerHeight };
}

/** The view a canvas opens at: where the person left it (its middle kept in the middle, CanvasViewport), else openingViewport. */
function opening(nodes: readonly AnyNode[], left: CanvasViewport | null): Viewport {
	const pane = paneSize();
	return left
		? { x: pane.w / 2 - left.x * left.zoom, y: pane.h / 2 - left.y * left.zoom, zoom: left.zoom }
		: openingViewport(nodes.filter(n => !n.parentId).map(n => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 })), pane);
}

function sizesOf(message: Lineage, loaded: Record<string, Loaded>): Record<string, Size> {
	return Object.fromEntries(message.cards.map(c => {
		const l = loaded[c.id];
		return [c.id, cardSize(l && 'size' in l ? l.size : undefined)];
	}));
}

function defaults(message: Lineage, loaded: Record<string, Loaded>): Layout {
	return message.episode === ASSETS_CANVAS
		? layoutAssets(message.sections, message.cards, sizesOf(message, loaded)).positions
		: layoutEpisode(message.sections, message.cards, sizesOf(message, loaded)).positions;
}

/**
 * An asset picture's standing and its versions as Pippit's strip ("The record panel's picture versions"):
 * status's own words for why it is not usable; one thumbnail per version the person has not discarded, the accepted one
 * marked Main; a click on another offers Approve, and Delete on hover discards one (it deletes no
 * file). An import is Main at once: drama-cli accepts it itself.
 */
function PictureState({ picture, busy, act }: { picture: CanvasPicture; busy: boolean; act: (action: EntryAction) => void }) {
	const [chosen, setChosen] = useState<string | null>(null);
	const shown = picture.versions.find(v => v.version === picture.current);
	const by = (v: { own: boolean }) => v.own ? 'imported by you' : 'drawn';
	const pick = chosen && picture.versions.find(v => v.version === chosen && !v.accepted);
	return (
		<div className="picture-state">
			<span>{[picture.current, shown ? by(shown) : null, picture.accepted === picture.current ? 'Main' : null].filter(Boolean).join(' · ')}</span>
			{picture.why && <div className="detail-note">{picture.why}</div>}
			{picture.versions.length > 0 && (
				<div className="strip" role="list">
					{picture.versions.map(v => (
						<div key={v.version} role="listitem" className={`version${v.version === chosen ? ' chosen' : ''}`} title={`${v.version} · ${by(v)}${v.accepted ? ' · Main' : ''}`}>
							<button className="thumb" onClick={() => setChosen(v.version === chosen ? null : v.version)} aria-label={`${v.version}${v.accepted ? ', Main' : ''}`}>
								{v.media === 'image' && <img src={v.src!} draggable={false} />}
								{/* #t=0.5, as the card: frame 0 of a take is often black. */}
								{v.media === 'video' && <video src={`${v.src}#t=0.5`} preload="metadata" muted playsInline />}
								{!v.media && <span className="codicon codicon-file-media" />}
								{v.accepted && <span className="main">Main</span>}
							</button>
							<button className="delete" disabled={busy} title={`Delete ${v.version}: it leaves the strip, its files are kept`} aria-label={`Delete ${v.version}`}
								onClick={() => act({ key: `discard:${picture.object}`, request: { action: 'discard', object: picture.object, version: v.version } })}><span className="codicon codicon-trash" /></button>
							<span className="label">{v.version}</span>
						</div>
					))}
				</div>
			)}
			{pick && (
				<div className="composer-row">
					<button className="labeled" disabled={busy} onClick={() => { act({ key: `choose:${picture.object}`, request: { action: 'choose', object: picture.object, version: pick.version } }); setChosen(null); }}
						title={`Approve ${pick.version}`}>Approve</button>
				</div>
			)}
		</div>
	);
}

/**
 * A text the composer edits in place, flat on the composer's surface: what is shown (the person's edit, else the
 * current text), whether it changed or was emptied, and its save, a card action under `key`.
 */
function useTextEdit(key: string, current: string | null, busy: boolean, act: (action: EntryAction) => void, request: (text: string) => EntryAction['request']) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		const ended = (event: Event) => {
			const done = (event as CustomEvent<{ key: string; error: string | null }>).detail;
			if (!done.error && done.key === key) { setText(null); }
		};
		window.addEventListener(ACTION_ENDED, ended);
		return () => window.removeEventListener(ACTION_ENDED, ended);
	}, [key]);
	const shown = text ?? current ?? '';
	const changed = current !== null && text !== null && text !== current;
	// An empty text, emptied or saved so, can be neither saved nor drawn from (drama-cli refuses an empty prompt or
	// description).
	const blank = !shown.trim();
	/** Whether a save was sent: a write waits while busy, and ⌘Enter reaches here while busy too. */
	const save = () => {
		if (!changed || busy || !shown.trim()) { return false; }
		act({ key, request: request(shown) });
		return true;
	};
	return { key, current, shown, changed, blank, save, cancel: () => setText(null), edit: setText };
}
type TextEdit = ReturnType<typeof useTextEdit>;

/** The text itself, flat on the composer's surface (no box around it), growing with its lines; Esc drops the edit, ⌘Enter saves it. */
function FlatText({ edit, busy, label }: { edit: TextEdit; busy: boolean; label: string }) {
	return (
		<textarea className="flat-text" value={edit.shown} disabled={busy} aria-label={label} rows={Math.min(12, Math.max(2, edit.shown.split('\n').length + Math.floor(edit.shown.length / 90)))}
			onChange={event => edit.edit(event.target.value)}
			onKeyDown={event => {
				if (event.key === 'Escape') { event.stopPropagation(); edit.cancel(); }
				if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); edit.save(); }
			}} />
	);
}

/** A setting the Computer cannot take yet: shown, greyed, with no value (nothing invented). */
const notYet = 'Not available yet';

/**
 * The composer: one floating dialog under the picked card, the same on both canvases (the person's design). A top row
 * (Upload, + Variant, Reference, Style, Full prompt), the references, the text specific to this picture, and a bottom
 * bar (model, settings, Generate). An asset's text is its description, its full prompt one click away; an episode
 * card's is its prompt, the only text it has; a storyboard has none. The text is for the next draw, so a picture the
 * person uploaded keeps it; how the picture on the card was made (no prompt, for an upload) is behind "How it was made".
 * The picture's versions sit above the text. The model and settings are greyed, as the Computer cannot take a choice
 * yet, and show the shown version's own (madeWith), the planned ones before it is drawn (plannedWith), or their
 * names when unknown.
 */
function Composer({ card, cards, reply, onGo, onClose }: { card: CanvasCard; cards: readonly CanvasCard[]; reply: DetailMessage | undefined; onGo: (stageId: string) => void; onClose: () => void }) {
	const record = reply?.record ?? null;
	const prompt = reply?.prompt ?? null;
	// What the shown version was made with, or what is planned for a card not drawn yet, read for display only.
	const made = reply?.made ?? null;
	const picture = reply?.picture ?? null;
	const [draft, setDraft] = useState<{ name: string; text: string } | null>(null);
	const [full, setFull] = useState(false);
	const [outcome, setOutcome] = useState<{ key: string; busy: boolean; error: string | null; unchanged: string | null } | null>(null);
	useEffect(() => {
		const ended = (event: Event) => {
			const { key, error, unchanged } = (event as CustomEvent<{ key: string; error: string | null; unchanged: string | null }>).detail;
			setOutcome(now => (now?.key === key ? { key, busy: false, error, unchanged } : now));
			if (!error && key === `variant:${card.id}`) { setDraft(null); }
		};
		window.addEventListener(ACTION_ENDED, ended);
		return () => window.removeEventListener(ACTION_ENDED, ended);
	}, []);
	const busy = outcome?.busy ?? false;
	const act = (action: EntryAction) => {
		setOutcome({ key: action.key, busy: true, error: null, unchanged: null });
		post({ v: CANVAS_PROTOCOL, type: 'entry', stageId: card.id, ...action });
	};
	const description = useTextEdit(`describe:${card.id}`, record?.description ?? null, busy, act,
		text => ({ action: 'describe', object: card.id, description: record?.description ?? '', text }));
	const promptEdit = useTextEdit(`prompt:${card.id}`, prompt?.text ?? null, busy, act, text => ({ action: 'prompt', object: prompt?.object ?? card.id, text }));
	// The picture shown is the person's own upload: it was made from no prompt.
	// An asset's own text is its description, its full prompt behind Full prompt; an episode card's is its prompt, the only
	// text it has (the person's decision). One text is edited at a time, so Save and Generate act on the one shown.
	const main = record ? (full ? promptEdit : description) : prompt?.text != null ? promptEdit : null;
	const references = record?.from
		? cards.filter(c => c.id === record.from).map(c => ({ label: c.label, src: c.src, stageId: c.id }))
		: reply?.detail?.pictures ?? [];
	const generate = () => {
		if (!main || main.blank) { return; }
		if (main.save()) { generateOnceSaved.set(main.key, card.id); } else { post({ v: CANVAS_PROTOCOL, type: 'generate', stageId: card.id }); }
	};
	const addVariant = () => record && draft && draft.name.trim() && draft.text.trim() && !busy
		&& act({ key: `variant:${card.id}`, request: { action: 'add', type: 'variant', from: card.id, name: draft.name.trim(), text: draft.text.trim() } });
	return (
		// React Flow's opt-outs for an interactive element inside the flow (noDragClassName, noWheelClassName, noPanClassName):
		// without nopan a press here starts a pan and its text cannot be selected (@xyflow/system createFilter).
		<div className="composer nowheel nodrag nopan" onDoubleClick={event => event.stopPropagation()}>
			<div className="composer-row">
				{record && <button className="chip-button" disabled={busy} onClick={() => act({ key: `import:${card.id}`, request: { action: 'import', object: card.id, file: null } })}
					title="Upload your own picture for it"><span className="codicon codicon-add" />Upload</button>}
				{record && <button className="chip-button" disabled={draft !== null} onClick={() => setDraft({ name: '', text: '' })}
					title="A new variant drawn from this one: a look, a view, a state or a time"><span className="codicon codicon-add" />Variant</button>}
				<button className="chip-button" disabled title={notYet}>Reference</button>
				<button className="chip-button" disabled title={notYet}>Style</button>
				<span className="spacer" />
				{card.segment && <button className="quiet" onClick={() => post({ v: CANVAS_PROTOCOL, type: 'segEditor', seg: card.segment })} title={`Open ${card.segment} in the seg editor`}>Seg editor ⤢</button>}
				{record && prompt?.text != null && <button className="quiet" aria-expanded={full} disabled={main?.changed} onClick={() => setFull(v => !v)}
					title={main?.changed ? 'Save or cancel your edit first' : full ? 'Back to its description' : 'The whole prompt its next draw sends'}>{full ? 'Description ⤡' : 'Full prompt ⤢'}</button>}
				<button className="icon" onClick={onClose} title="Close (Esc)" aria-label="Close"><span className="codicon codicon-close" /></button>
			</div>
			{references.length > 0 && (
				<div className="composer-refs">
					{references.map((r, i) => <PictureRef key={i} r={r} onGo={onGo} />)}
					{record?.from && <span className="muted">Base, sent with it</span>}
				</div>
			)}
			{picture && <PictureState picture={picture} busy={busy} act={act} />}
			{!reply && <div className="detail-note">Reading its record…</div>}
			{reply?.error && <div className="detail-note">{reply.error}</div>}
			{main && <FlatText key={main.key} edit={main} busy={busy} label={!record ? 'Prompt' : full ? 'Full prompt' : 'Description'} />}
			{main?.changed && (
				<div className="composer-row">
					<span className="muted">Unsaved changes · ⌘Enter to save</span>
					<span className="spacer" />
					<button className="labeled" disabled={busy} onClick={main.cancel} title="Discard your edit (Esc)">Cancel</button>
					<button className="labeled" disabled={busy || main.blank} onClick={main.save}>Save</button>
				</div>
			)}
			{reply?.detail && (
				// How the version on the card was made: what it was made from and the prompt it was made with (versionDetail.ts).
				<details className="made">
					<summary>How it was made</summary>
					<RequestView detail={reply.detail} onGo={onGo} />
				</details>
			)}
			{draft && (
				<div className="variant-draft" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); } }}>
					<input className="flat-text" autoFocus value={draft.name} maxLength={NAME_MAX} placeholder="Variant name" aria-label="Variant name" disabled={busy}
						onChange={event => setDraft({ ...draft, name: event.target.value })} />
					<textarea className="flat-text" value={draft.text} rows={3} maxLength={TEXT_MAX} placeholder="What differs from this one" aria-label="Variant description" disabled={busy}
						onChange={event => setDraft({ ...draft, text: event.target.value })}
						onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); addVariant(); } }} />
					<div className="composer-row">
						<span className="spacer" />
						<button className="labeled" disabled={busy} onClick={() => setDraft(null)} title="Leave nothing behind (Esc)">Cancel</button>
						<button className="labeled" disabled={busy || !draft.name.trim() || !draft.text.trim()} onClick={addVariant} title="Add it to the project's assets, by you (⌘Enter)">Add</button>
					</div>
				</div>
			)}
			{outcome?.busy && <div className="detail-note">Working…</div>}
			{outcome?.error && <div className="detail-note error-text">{outcome.error}</div>}
			{outcome?.unchanged && <div className="detail-note">{outcome.unchanged}</div>}
			<div className="composer-bar">
				<button className="quiet" disabled title={notYet}>{made?.model ?? 'Model'} ▾</button>
				<span className="bar-sep" />
				<button className="chip-button" disabled title={notYet}>{made?.settings.length ? made.settings.join(' · ') : 'Ratio · Quality · Resolution · Count'} ▾</button>
				<span className="spacer" />
				{/* Generate draws from the text shown, so a card with none (a storyboard, a cut) offers none. */}
				{main && (
					<button className="generate" disabled={busy || main.blank} onClick={generate}
						title={`${card.kind === 'take' ? 'Shoot only this segment' : 'Draw only this picture'}: puts a request in the Chat, saving your edit first`} aria-label="Generate">
						<span className="codicon codicon-arrow-up" />
					</button>
				)}
			</div>
		</div>
	);
}

function Canvas({ message, loaded }: { message: Lineage; loaded: Record<string, Loaded> }) {
	const [nodes, setNodes] = useState<AnyNode[]>(() => nodesFor(message, loaded, positionsFor(defaults(message, loaded), message.layout, {}, message.cards, sizesOf(message, loaded), message.episode)));
	// Fixed at mount: where the person last left this canvas, else from the first nodes, which stand somewhere (App mounts
	// the board only when the measured lineage has a card).
	const [openViewport] = useState(() => opening(nodes, message.viewport));
	const [picked, setPicked] = useState<string | null>(null);
	// Layout-only history: each entry is every node's position; nothing else is undoable here.
	const past = useRef<Layout[]>([]);
	const future = useRef<Layout[]>([]);
	const before = useRef<Layout | null>(null);
	const [, rerender] = useState(0);
	const flow = useReactFlow();
	const first = useRef(true);
	const [minimap, setMinimap] = useState(true);
	const [more, setMore] = useState(false);
	// The canvas's tool; every canvas opens with Hand, the person's choice.
	const [tool, setTool] = useState<Tool>('hand');
	const [notice, setNotice] = useState<string | null>(null);
	const [detail, setDetail] = useState<DetailMessage | undefined>(undefined);
	const { zoom } = useViewport();
	const pickedCard = picked ? message.cards.find(c => c.id === picked) : undefined;

	useEffect(() => {
		const got = (event: Event) => {
			const reply = (event as CustomEvent<DetailMessage>).detail;
			setDetail(reply);
		};
		window.addEventListener(DETAIL, got);
		return () => window.removeEventListener(DETAIL, got);
	}, []);
	// The composer opens under the picked card, centred (the person's design); the board pans the least that shows both.
	const PANEL = { w: 560, h: 420, gap: 14 };
	const reveal = (id: string) => {
		const node = flow.getInternalNode(id);
		const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
		if (!node || !pane) {
			return;
		}
		const { x: vx, y: vy, zoom: z } = flow.getViewport();
		const at = node.internals.positionAbsolute;
		const box = { x1: at.x * z + vx, y1: at.y * z + vy, x2: (at.x + (node.measured.width ?? 0)) * z + vx, y2: (at.y + (node.measured.height ?? 0)) * z + vy };
		const middle = (box.x1 + box.x2) / 2;
		const area = { x1: Math.min(box.x1, middle - PANEL.w / 2), x2: Math.max(box.x2, middle + PANEL.w / 2), y1: box.y1, y2: box.y2 + PANEL.gap + PANEL.h };
		const margin = 24;
		const dx = area.x2 > pane.width - margin ? pane.width - margin - area.x2 : area.x1 < margin ? margin - area.x1 : 0;
		const dy = area.y2 > pane.height - 72 ? pane.height - 72 - area.y2 : area.y1 < 48 ? 48 - area.y1 : 0;
		if (dx || dy) {
			void flow.setViewport({ x: vx + dx, y: vy + dy, zoom: z }, { duration: 250 });
		}
	};
	const pick = (card: CanvasCard | undefined) => {
		setPicked(card?.id ?? null);
		if (card) {
			reveal(card.id);
		}
		setDetail(undefined);
		post(card ? { v: CANVAS_PROTOCOL, type: 'inspect', stageId: card.id, version: card.version, file: card.file } : { v: CANVAS_PROTOCOL, type: 'unpick' });
	};
	// Once the panel is drawn, its real size is known: if it reaches the bar or an edge of the pane, the board moves
	// the least to clear it (the first placement assumed PANEL's size).
	useEffect(() => {
		if (!pickedCard) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			const panel = document.querySelector('.composer')?.getBoundingClientRect();
			const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
			const bar = document.querySelector('.bar')?.getBoundingClientRect();
			if (!panel || !pane) {
				return;
			}
			const floor = (bar ? bar.top - pane.top : pane.height) - 12;
			const dy = panel.bottom - pane.top > floor ? floor - (panel.bottom - pane.top) : panel.top - pane.top < 48 ? 48 - (panel.top - pane.top) : 0;
			const dx = panel.right - pane.left > pane.width - 16 ? pane.width - 16 - (panel.right - pane.left) : panel.left - pane.left < 16 ? 16 - (panel.left - pane.left) : 0;
			if (dx || dy) {
				const { x, y, zoom: z } = flow.getViewport();
				void flow.setViewport({ x: x + dx, y: y + dy, zoom: z }, { duration: 200 });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [pickedCard?.id, detail]);

	// The picked card's version changed on a refresh: its detail is read again, for the version now on the card.
	useEffect(() => {
		if (pickedCard && detail && detail.stageId === pickedCard.id && detail.version !== pickedCard.version) {
			pick(pickedCard);
		}
	}, [pickedCard?.version]);
	// A card's id: an object's, or what a variant derives from (`from`).
	const goTo = (target: string) => {
		const node = flow.getInternalNode(target);
		if (!node) {
			return;
		}
		const stageId = node.id;
		const at = node.internals.positionAbsolute;
		void flow.setCenter(at.x + (node.measured.width ?? 0) / 2, at.y + (node.measured.height ?? 0) / 2, { zoom: flow.getZoom(), duration: 300 }).then(() => {
			setNodes(current => current.map(n => ({ ...n, selected: n.id === stageId })));
			pick(message.cards.find(c => c.id === stageId));
		});
	};

	// The card the person clicked elsewhere (an asset card opens the assets canvas on it): centred and selected once the
	// cards are measured. A card drama-cli draws no node for yet (no version) is not on the board, and nothing moves.
	useEffect(() => {
		const focus = message.focus;
		if (!focus) {
			return;
		}
		let tries = 0;
		const timer = setInterval(() => {
			tries += 1;
			if (flow.getInternalNode(focus)?.measured.width || tries > 20) {
				clearInterval(timer);
				goTo(focus);
			}
		}, 100);
		return () => clearInterval(timer);
	}, [message]);

	useEffect(() => {
		const run = (event: Event) => {
			const name = (event as CustomEvent<CanvasCommand>).detail;
			if (name === 'zoomIn') {
				void flow.zoomIn({ duration: 200 });
			} else if (name === 'zoomOut') {
				void flow.zoomOut({ duration: 200 });
			} else if (name === 'fit') {
				void flow.fitView({ duration: 200, padding: 0.08 });
			} else if (name === 'selectAll') {
				setNodes(current => current.map(n => ({ ...n, selected: n.type === 'card' })));
			}
		};
		window.addEventListener(COMMAND, run);
		return () => window.removeEventListener(COMMAND, run);
	}, [flow]);

	// ⌘+wheel zooms at the pointer, read from the wheel event itself, as tldraw reads it (useGestureEvents.ts, ctrlKey:
	// event.metaKey || event.ctrlKey): every WheelEvent carries the modifiers held (UI Events, MouseEvent.metaKey), while
	// a key's keydown reaches the webview only when it has the keyboard focus. React Flow's zoomActivationKeyCode is that
	// keydown (useKeyPress), so it is off below; Ctrl+wheel and a pinch already zoom from event.ctrlKey (@xyflow/system
	// createPanOnScrollHandler). The step is React Flow's own (wheelDelta). The listener is on the element React Flow
	// pans and zooms (ZoomPane, .react-flow__renderer), capturing before its handler there; the minimap and the bar sit
	// outside it and keep their own wheel.
	const wrapper = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const pane = wrapper.current?.querySelector<HTMLElement>('.react-flow__renderer');
		if (!pane) {
			return;
		}
		const wheel = (event: WheelEvent) => {
			if (!event.metaKey || event.ctrlKey || (event.target instanceof Element && event.target.closest('.nowheel'))) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const { x, y, zoom: z } = flow.getViewport();
			const to = Math.min(ZOOM.max, Math.max(ZOOM.min, z * 2 ** (-event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002))));
			const box = pane.getBoundingClientRect();
			const [px, py] = [event.clientX - box.left, event.clientY - box.top];
			void flow.setViewport({ x: px - (px - x) * to / z, y: py - (py - y) * to / z, zoom: to });
		};
		pane.addEventListener('wheel', wheel, { capture: true, passive: false });
		return () => pane.removeEventListener('wheel', wheel, { capture: true });
	}, [flow]);

	// A new lineage (the project changed) or newly measured pictures update the cards; nothing on screen moves.
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		setNodes(current => nodesFor(message, loaded, positionsFor(defaults(message, loaded), message.layout, layoutOf(current), message.cards, sizesOf(message, loaded), message.episode)));
	}, [message, loaded]);

	// The assets canvas keeps no arrangement (positionsFor): nothing of it is saved.
	const assets = message.episode === ASSETS_CANVAS;
	const save = (layout: Layout) => !assets && post({ v: CANVAS_PROTOCOL, type: 'layout', episode: message.episode, positions: layout });
	const move = (to: Layout, into: Layout[]) => setNodes(current => {
		into.push(layoutOf(current));
		save(to);
		rerender(n => n + 1);
		return nodesFor(message, loaded, to);
	});
	const undo = useCallback(() => { const to = past.current.pop(); if (to) move(to, future.current); }, [message, loaded]);
	const redo = useCallback(() => { const to = future.current.pop(); if (to) move(to, past.current); }, [message, loaded]);
	// Lay out again: drama-cli's grouping and order at the pictures' sizes; one step of the history (review, clarification 1).
	const layOutAgain = () => setNodes(current => {
		past.current.push(layoutOf(current));
		future.current = [];
		const to = defaults(message, loaded);
		save(to);
		rerender(n => n + 1);
		const view = opening(nodesFor(message, loaded, to), null);
		setTimeout(() => void flow.setViewport(view, { duration: 200 }), 0);
		setNotice('Laid out again · ⌘Z brings your arrangement back');
		setTimeout(() => setNotice(null), 5000);
		return nodesFor(message, loaded, to);
	});

	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			const mod = event.metaKey || event.ctrlKey;
			const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
			if (!mod && !event.altKey && !typing && TOOL_KEYS[event.key.toLowerCase()]) {
				setTool(TOOL_KEYS[event.key.toLowerCase()]);
			} else if (mod && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				(event.shiftKey ? redo : undo)();
			} else if (mod && event.key.toLowerCase() === 'y') {
				event.preventDefault();
				redo();
			} else if (mod && event.key.toLowerCase() === 'a' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
				// The board's select-all is the scoped command (pineDrama.canvas.selectAll); the page's own text selection is not.
				event.preventDefault();
			} else if (event.key === 'Escape') {
				setNodes(current => current.map(n => (n.selected ? { ...n, selected: false } : n)));
				pick(undefined);
				setMore(false);
			}
		};
		window.addEventListener('keydown', key);
		// A take keeps no sound or decoding running while its tab is hidden (review, clarification 5).
		const hidden = () => document.hidden && document.querySelectorAll('video').forEach(v => v.pause());
		document.addEventListener('visibilitychange', hidden);
		return () => {
			window.removeEventListener('keydown', key);
			document.removeEventListener('visibilitychange', hidden);
		};
	}, [undo, redo]);

	// Only positions and selection change: a card is a stage drama-cli has; the canvas cannot delete one.
	const onNodesChange = useCallback((changes: NodeChange<AnyNode>[]) => {
		setNodes(current => applyNodeChanges(changes.filter(c => c.type === 'position' || c.type === 'select'), current));
	}, []);

	// drama-cli's recorded links: thin and light; the picked card's own links stand out.
	const edges: Edge[] = useMemo(() => message.links.filter(l => nodes.some(n => n.id === l.from) && nodes.some(n => n.id === l.to)).map(l => ({
		id: `${l.from}->${l.to}`, source: l.from, target: l.to, selectable: false, focusable: false,
		// On the assets canvas a link is a variant drawn from its base, dashed.
		className: `${picked && (l.from === picked || l.to === picked) ? 'link lit' : 'link'}${message.episode === ASSETS_CANVAS ? ' dashed' : ''}`,
		zIndex: picked && (l.from === picked || l.to === picked) ? 2 : 0,
	})), [message.links, nodes, picked]);

	const shown = (card: CanvasCard) => ({ stageId: card.id, version: card.version, file: card.file });

	return (
		<ReactFlow
			ref={wrapper}
			className={`tool-${tool}`}
			nodes={nodes}
			edges={edges}
			nodeTypes={nodeTypes}
			onNodesChange={onNodesChange}
			onNodeDragStart={() => { before.current = layoutOf(nodes); }}
			onNodeDragStop={() => {
				setNodes(current => {
					const after = layoutOf(current);
					if (before.current && !same(before.current, after)) {
						past.current.push(before.current);
						future.current = [];
						save(after);
						rerender(n => n + 1);
					}
					before.current = null;
					return current;
				});
			}}
			onNodeClick={(_event, node) => {
				if (node.type === 'card') {
					pick((node as CardNode).data.card);
				}
			}}
			onNodeDoubleClick={(_event, node) => {
				if (node.type === 'card' && opensFile((node as CardNode).data.card)) {
					post({ v: CANVAS_PROTOCOL, type: 'open', ...shown((node as CardNode).data.card) });
				}
			}}
			onPaneClick={() => { pick(undefined); setMore(false); }}
			nodesConnectable={false}
			edgesFocusable={false}
			deleteKeyCode={null}
			// Two tools, after tldraw's select and hand; they differ in what a drag does, and in
			// both a click picks a card. Select: a drag on a card moves it, a drag on empty space draws a selection box, the
			// middle button drags to pan (React Flow's design-tool controls). Hand: any drag pans. In both, scroll pans and
			// Space held pans (React Flow's panActivationKeyCode, 'Space' by default), tldraw's spacebar panning.
			panOnDrag={tool === 'hand' ? true : [1]}
			selectionOnDrag={tool === 'select'}
			selectionKeyCode={tool === 'select' ? 'Shift' : null}
			nodesDraggable={tool === 'select'}
			panOnScroll
			zoomOnPinch
			zoomActivationKeyCode={null}
			minZoom={ZOOM.min}
			maxZoom={ZOOM.max}
			// The opening view is a prop, not a call after mount: React Flow's `defaultViewport` is the initial pan and zoom (reactflow.dev/api-reference/react-flow#default-viewport).
			defaultViewport={openViewport}
			// Wherever the board comes to rest is where it opens next time (reactflow.dev/api-reference/react-flow#onmoveend).
			onMoveEnd={(_event, { x, y, zoom: z }) => {
				const pane = paneSize();
				post({ v: CANVAS_PROTOCOL, type: 'viewport', episode: message.episode, viewport: { x: (pane.w / 2 - x) / z, y: (pane.h / 2 - y) / z, zoom: z } });
			}}
			// The workbench marks its theme on the webview body (vscode-light, vscode-dark, vscode-high-contrast).
			colorMode={document.body.classList.contains('vscode-light') ? 'light' : 'dark'}
		>
			{/* A dot grid that reads as a canvas at a glance (the person, 658; React Flow's default gap is 20): the dots take a
			    workbench colour meant to be seen faintly over the editor, in every theme (canvas.css). */}
			<Background variant={BackgroundVariant.Dots} gap={20} size={1.5} className="dots" />
			{minimap && <MiniMap pannable zoomable nodeClassName={node => `mini-${node.type}`} nodeStrokeWidth={0} />}
			{pickedCard && (
				<NodeToolbar nodeId={pickedCard.id} isVisible position={Position.Bottom} align="center" offset={14}>
					<Composer key={pickedCard.id} card={pickedCard} cards={message.cards} reply={detail?.stageId === pickedCard.id ? detail : undefined} onGo={goTo}
						onClose={() => { pick(undefined); setNodes(current => current.map(n => ({ ...n, selected: false }))); }} />
				</NodeToolbar>
			)}
			{/* The board's own bar (canvas-scope.md): the two tools (canvas-tools.md), zoom and fit; the minimap and Lay out again under More. Undo is ⌘Z. */}
			<div className="bar" role="toolbar" aria-label="Canvas">
				<button className="icon" aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Select (V): click picks a card, drag moves it or draws a selection box" aria-label="Select"><span className="codicon codicon-cursor" /></button>
				<button className="icon" aria-pressed={tool === 'hand'} onClick={() => setTool('hand')} title="Hand (H): drag pans, click picks a card; hold Space to pan with Select" aria-label="Hand"><span className="codicon codicon-move" /></button>
				<span className="sep" />
				<button className="icon" onClick={() => void flow.zoomOut({ duration: 200 })} title="Zoom out (⌘−)" aria-label="Zoom out"><span className="codicon codicon-remove" /></button>
				<button className="zoom" onClick={() => void flow.zoomTo(1, { duration: 200 })} title="Zoom to 100 %" aria-label={`Zoom ${Math.round(zoom * 100)} %, set to 100 %`}>{Math.round(zoom * 100)}%</button>
				<button className="icon" onClick={() => void flow.zoomIn({ duration: 200 })} title="Zoom in (⌘=)" aria-label="Zoom in"><span className="codicon codicon-add" /></button>
				<span className="sep" />
				<button className="icon" onClick={() => void flow.fitView({ duration: 200, padding: 0.08 })} title="Fit the board (⌘0)" aria-label="Fit"><span className="codicon codicon-screen-full" /></button>
				<button className="icon" onClick={() => setMore(v => !v)} aria-expanded={more} title="More" aria-label="More"><span className="codicon codicon-ellipsis" /></button>
				{more && (
					<div className="menu" role="menu">
						<button role="menuitem" onClick={() => { setMinimap(v => !v); setMore(false); }}><span className="codicon codicon-map" />{minimap ? 'Hide minimap' : 'Show minimap'}</button>
						{!assets && <button role="menuitem" onClick={() => { setMore(false); layOutAgain(); }}><span className="codicon codicon-layout" />Lay out again</button>}
					</div>
				)}
				{notice && <div className="notice" role="status">{notice}</div>}
			</div>
		</ReactFlow>
	);
}

function App() {
	const [message, setMessage] = useState<ToCanvas | null>(null);
	// Never blank: until the lineage comes, the canvas says it is reading it, with the seconds (canvasWait.ts).
	const [waited, setWaited] = useState(0);
	useEffect(() => {
		if (message) {
			return;
		}
		const started = Date.now();
		const timer = setInterval(() => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			setWaited(seconds);
			if (seconds === CANVAS_WAIT_LIMIT_S) {
				post({ v: CANVAS_PROTOCOL, type: 'failed', message: `no lineage came within ${CANVAS_WAIT_LIMIT_S} s of asking` });
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [message]);
	// The lineage and its pictures' sizes arrive together: a card is placed only once its real size is known, never at an assumed one.
	const [measured, setMeasured] = useState<{ message: Lineage; loaded: Record<string, Loaded> } | null>(null);
	useEffect(() => {
		const listen = (event: MessageEvent<ToCanvas>) => {
			if (event.data?.v !== CANVAS_PROTOCOL) {
				return;
			}
			if (event.data.type === 'command') {
				window.dispatchEvent(new CustomEvent(COMMAND, { detail: event.data.name }));
			} else if (event.data.type === 'detail') {
				window.dispatchEvent(new CustomEvent(DETAIL, { detail: event.data }));
			} else if (event.data.type === 'actionEnded') {
				window.dispatchEvent(new CustomEvent(ACTION_ENDED, { detail: event.data }));
			} else {
				setMessage(event.data);
			}
		};
		window.addEventListener('message', listen);
		post({ v: CANVAS_PROTOCOL, type: 'ready' });
		return () => window.removeEventListener('message', listen);
	}, []);
	// Pictures are measured before the first arrangement, so rows fit them; later ones are measured as they come.
	useEffect(() => {
		if (message?.type !== 'lineage') {
			return;
		}
		let live = true;
		const todo = message.cards.filter(c => onBoard(c) && c.src);
		void Promise.all(todo.map(async c => [c.id, await measure(c)] as const)).then(entries => {
			if (live) {
				setMeasured({ message, loaded: Object.fromEntries(entries) });
			}
		});
		return () => { live = false; };
	}, [message]);

	if (message?.type === 'error') {
		return (
			<div className="error">
				<h2>{message.episode}: the canvas has no data</h2>
				<p>{message.message}</p>
				{message.code && <p className="detail">code {message.code}{message.action ? ` · action ${message.action}` : ''}</p>}
			</div>
		);
	}
	const board = message?.type === 'lineage' ? message.cards.filter(onBoard) : [];
	// `measured` can be of an earlier lineage than `message` (measuring is asynchronous): a board mounted from one with no card has no frame to open at.
	const measuredBoard = !!measured && measured.message.cards.some(onBoard);
	if (!message) {
		return <div className="shell"><div className="canvas"><div className="empty">{waitingText(document.body.dataset.episode ?? 'this episode', waited)}</div></div></div>;
	}
	return (
		<div className="shell">
			{message?.type === 'lineage' && (
				<div className="origin live" title={message.origin.observedAt
					? `Versions and your choices are current; readiness and links are as of the last return, ${new Date(message.origin.observedAt).toLocaleString()}`
					: 'No return yet: readiness and links come with the first'}>
					<span className="dot" />{message.origin.observedAt ? `As of ${new Date(message.origin.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'No return yet'}
				</div>
			)}
			{/* The episode's other view, as the seg editor's own "Canvas" button opens this one (production-assets.md, section 12c).
			    The assets canvas belongs to no episode, so it has none. */}
			{document.body.dataset.episode !== ASSETS_CANVAS && (
				<button className="labeled to-seg" onClick={() => post({ v: CANVAS_PROTOCOL, type: 'segEditor', seg: null })} title="Open this episode's seg editor">
					<span className="codicon codicon-device-camera-video" />Seg Editor
				</button>
			)}
			<div className="canvas">
				{/* Before its breakdown an episode plans nothing (bone-veil-v046): say what comes next (episode-canvas-layout.md, section 2d). */}
				{message?.type === 'lineage' && !board.length && <div className="empty">{message.episode === ASSETS_CANVAS ? 'No asset yet: they appear once the bible is made.'
					: `${message.episode}'s plan appears once its breakdown is approved; its references are on the assets canvas.`}</div>}
				{message?.type === 'lineage' && board.length > 0 && !measuredBoard && <div className="empty">Reading {board.filter(c => c.src).length} pictures and takes…</div>}
				{message?.type === 'lineage' && board.length > 0 && measured && measuredBoard && <ReactFlowProvider><Canvas message={measured.message} loaded={measured.loaded} /></ReactFlowProvider>}
			</div>
		</div>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
