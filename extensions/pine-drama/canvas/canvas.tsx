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
	type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// The workbench's own icons, at the version the pinned Code-OSS uses (its package.json: @vscode/codicons ^0.0.46-49).
import '@vscode/codicons/dist/codicon.css';
import './canvas.css';
import { NAME_MAX, TEXT_MAX, type EntryAction } from '../src/core/galleryProtocol';
import { ASSETS_CANVAS, CANVAS_PROTOCOL, opensFile, type CanvasCard, type CanvasPicture, type CanvasPrompt, type CanvasCommand, type FromCanvas, type Point, type Size, type ToCanvas } from '../src/core/canvasProtocol';
import { CANVAS_WAIT_LIMIT_S, waitingText } from '../src/core/canvasWait';
import { RequestView } from './requestView';
import { assetCardSize, cardSize, layoutAssets, layoutEpisode, layoutOf, onBoard, openingViewport, positionsFor } from '../src/core/canvasLayout';

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
// Generate with an unsaved edit: the request goes to the chat once that save is written, never after a refused one.
// Held here, not in the box, so closing the box or picking another card before the save ends drops no request: the box is keyed by its card and unmounts with its listeners.
const generateOnceSaved = new Set<string>();
window.addEventListener(ACTION_ENDED, event => {
	const { key, error } = (event as CustomEvent<{ key: string; error: string | null }>).detail;
	if (generateOnceSaved.delete(key) && !error) { post({ v: CANVAS_PROTOCOL, type: 'generate', stageId: key.slice('prompt:'.length) }); }
});
/** The window event an undrawn assets card's Import sends: pick the card, and import once its record is read. */
const FACE_IMPORT = 'pine-canvas-face-import';
type DetailMessage = Extract<ToCanvas, { type: 'detail' }>;
/** The zoom a board opens at, its frames' top-left corner near the top-left of the pane: readable, not fitted to dots. A starting value (open-pinedrama used 0.55). */
type Layout = Record<string, Point>;
/** A picture's own size, or why it could not be read. */
type Loaded = { size: Size } | { error: string };
type CardData = { card: CanvasCard; loaded: Loaded | undefined; assets?: boolean };
type CardNode = Node<CardData, 'card'>;
type FrameNode = Node<{ title: string }, 'frame'>;
type HeadingNode = Node<{ title: string }, 'heading'>;
type AnyNode = CardNode | FrameNode | HeadingNode;

const ICON: Readonly<Record<string, string>> = {
	character: 'person', scene: 'globe', prop: 'package', variant: 'person', keyframe: 'file-media', storyboard: 'layout',
	take: 'device-camera-video', cut: 'film',
};

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

/** The version line: drama-cli's working and accepted versions, and whether status calls it usable, as separate facts (review, clarification 2). */
/** The version line in words, for a tooltip. */
const versionText = (card: CanvasCard) => card.planned ? 'planned' : !card.version ? 'no version'
	: `${card.version}${card.accepted === card.version ? ' · approved' : card.accepted ? ` · approved ${card.accepted}` : ''}`;

function VersionLine({ card }: { card: CanvasCard }) {
	// A stage its episode plans and has not made yet (section 2d; Pippit's "To be set"; 552).
	if (card.planned) {
		return <span className="muted">Planned</span>;
	}
	if (!card.version) {
		return <span className="muted">no version</span>;
	}
	return (
		<>
			<span className={card.accepted === card.version ? 'accepted' : ''}>{card.version}</span>
			<span className="muted">{card.accepted === card.version ? ' · approved' : card.accepted ? ` · approved ${card.accepted}` : ' · not approved'}</span>
			{/* drama-cli status's judgement (stages.usable, #390): only none made, not accepted, or a changed acceptance (D308). */}
			{card.notUsable ? <span className="chip stale" title={card.notUsable}>Not usable</span> : null}
		</>
	);
}

/** What stands where the picture would: each state says what is actually known (review, finding 4). */
function Placeholder({ card, loaded }: CardData) {
	const text = card.appearsIn && !card.version ? 'Not drawn yet'
		: card.planned ? 'Planned: not made yet'
		: !card.version ? 'Not generated: no version yet'
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

const undrawn = (card: CanvasCard) => !!card.appearsIn && !card.version;

/**
 * An assets canvas card (section 3; Pippit 734): the picture, then a footer with the name, then the
 * state and the episodes, in sizes read zoomed out; no label row. An undrawn node's picture holds Import, Pippit's Upload.
 */
function AssetCardView({ card, loaded, selected, width, height }: CardData & { selected: boolean; width?: number; height?: number }) {
	const size = loaded && 'size' in loaded ? loaded.size : undefined;
	const shows = card.src && size;
	const none = undrawn(card);
	return (
		<div className={`card asset${card.notUsable ? ' stale' : ''}${selected ? ' selected' : ''}`} style={{ width, height }}
			title={`${fullName(card)}\n${versionText(card)}${size ? ` · ${size.w} × ${size.h}` : ''}${card.notUsable ? `\n${card.notUsable}` : ''}\nClick: its record${opensFile(card) ? ` · Double-click: open ${card.file ?? 'nothing'}` : ''}`}>
			<Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} />
			<div className="media">
				{shows && card.media === 'image' && <img src={card.src!} draggable={false} />}
				{!shows && none && (
					<button className="labeled face-import nodrag" onClick={event => { event.stopPropagation(); window.dispatchEvent(new CustomEvent(FACE_IMPORT, { detail: card.id })); }}
						title="Import your own picture for it"><span className="codicon codicon-file-add" />Import</button>
				)}
				{!shows && !none && <Placeholder card={card} loaded={loaded} />}
			</div>
			<CardMarks card={card} />
			<div className="asset-foot">
				<div className="asset-name">{card.label}</div>
				<div className="asset-line">
					{none ? <span className="warn">Not drawn yet</span> : <VersionLine card={card} />}
					{card.appearsIn?.length ? <span className="muted"> · {card.appearsIn.join(', ')}</span> : null}
				</div>
			</div>
			<Handle type="source" position={Position.Right} isConnectable={false} style={hiddenHandle} />
		</div>
	);
}

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

const CardView = memo(({ data, selected, width, height }: NodeProps<CardNode>) => {
	const { card, loaded } = data;
	const video = useRef<HTMLVideoElement>(null);
	const size = loaded && 'size' in loaded ? loaded.size : undefined;
	const shows = card.src && size;
	if (data.assets) {
		return <AssetCardView card={card} loaded={loaded} selected={selected} width={width} height={height} />;
	}
	return (
		<div className={`card${card.notUsable ? ' stale' : ''}${selected ? ' selected' : ''}`} style={{ width, height }} title={`${card.appearsIn ? `${card.label}\n${versionText(card)}` : card.id}${card.notUsable ? `\n${card.notUsable}` : ''}${`\nClick: ${card.appearsIn ? 'its record' : 'how it was made'}`}${opensFile(card) ? ` · Double-click: open ${card.file ?? 'nothing'}` : ''}`}>
			<Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} />
			<div className="label">
				<span className={`codicon codicon-${ICON[card.kind] ?? 'circle-small'}`} />
				<span className="name">{card.label}</span>
				{size && <span className="dims">{size.w} × {size.h}</span>}
			</div>
			<div className="media"
				onMouseEnter={() => void video.current?.play().catch(() => undefined)}
				onMouseLeave={() => video.current?.pause()}>
				{shows && card.media === 'image' && <img src={card.src!} draggable={false} />}
				{/* #t=0.5: frame 0 of a take is often black (canvas-scope #30). Hover plays muted; leaving pauses where it is (#31). */}
				{shows && card.media === 'video' && <><video ref={video} src={`${card.src}#t=0.5`} preload="metadata" muted playsInline loop /><span className="play codicon codicon-play" /></>}
				{!shows && <Placeholder card={card} loaded={loaded} />}
			</div>
			<CardMarks card={card} />
			{/* The assets canvas names the episodes an asset appears in (its record); its version is in the tooltip. */}
			<div className="foot">{card.appearsIn ? <span className="muted">{card.appearsIn.length ? `Appears in ${card.appearsIn.join(', ')}` : ''}</span> : <VersionLine card={card} />}</div>
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
		// An asset with one card has no frame on the assets canvas (layoutAssets): its card stands alone.
		if (!place[frameId]) {
			for (const card of members) {
				nodes.push({ id: card.id, type: 'card', position: place[card.id], data: { card, loaded: loaded[card.id], assets: message.episode === ASSETS_CANVAS }, width: sizes[card.id].w, height: sizes[card.id].h, zIndex: 1 });
			}
			continue;
		}
		const w = Math.max(...members.map(c => place[c.id].x + sizes[c.id].w)) + 20;
		const h = Math.max(...members.map(c => place[c.id].y + sizes[c.id].h)) + 20;
		nodes.push({ id: frameId, type: 'frame', position: place[frameId], data: { title: message.titles?.[title] ?? title }, width: w, height: h, style: { width: w, height: h }, zIndex: 0 });
		for (const card of members) {
			nodes.push({ id: card.id, type: 'card', parentId: frameId, position: place[card.id], data: { card, loaded: loaded[card.id], assets: message.episode === ASSETS_CANVAS }, width: sizes[card.id].w, height: sizes[card.id].h, zIndex: 1 });
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
function opening(nodes: readonly AnyNode[]): { x: number; y: number; zoom: number } {
	const pane = document.querySelector('.canvas')?.getBoundingClientRect();
	return openingViewport(nodes.filter(n => !n.parentId).map(n => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 })),
		{ w: pane?.width || window.innerWidth, h: pane?.height || window.innerHeight });
}

function sizesOf(message: Lineage, loaded: Record<string, Loaded>): Record<string, Size> {
	return Object.fromEntries(message.cards.map(c => {
		const l = loaded[c.id];
		return [c.id, (message.episode === ASSETS_CANVAS ? assetCardSize : cardSize)(l && 'size' in l ? l.size : undefined)];
	}));
}

function defaults(message: Lineage, loaded: Record<string, Loaded>): Layout {
	return message.episode === ASSETS_CANVAS
		? layoutAssets(message.sections, message.cards, sizesOf(message, loaded), message.links).positions
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
								{v.src ? <img src={v.src} draggable={false} /> : <span className="codicon codicon-file-media" />}
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
				<div className="record-actions">
					<button className="labeled" disabled={busy} onClick={() => { act({ key: `choose:${picture.object}`, request: { action: 'choose', object: picture.object, version: pick.version } }); setChosen(null); }}
						title={`Approve ${pick.version}`}>Approve</button>
				</div>
			)}
		</div>
	);
}

/**
 * A card's prompt edited in place: the text as typed, whether it changed or was emptied, its Save (`prompt set`,
 * a card action), and a Generate that waits for that save. The asset box and an episode card's box share it.
 */
function usePromptEdit(card: CanvasCard, prompt: CanvasPrompt | null, busy: boolean, act: (action: EntryAction) => void) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		const ended = (event: Event) => {
			const { key, error } = (event as CustomEvent<{ key: string; error: string | null }>).detail;
			if (!error && key === `prompt:${card.id}`) {
				setText(null);
			}
		};
		window.addEventListener(ACTION_ENDED, ended);
		return () => window.removeEventListener(ACTION_ENDED, ended);
	}, []);
	const current = prompt?.text ?? null;
	const shown = text ?? current ?? '';
	const changed = prompt !== null && text !== null && text !== (current ?? '');
	// An edit that empties the prompt can be neither saved nor drawn from (drama-cli refuses an empty prompt): Generate waits
	// too, so it never draws from the old text the box no longer shows.
	const blank = changed && !shown.trim();
	/** Whether a save was sent: a write waits while busy, and the field's ⌘Enter reaches here while busy too. */
	const save = () => {
		if (!prompt || !changed || busy || !shown.trim()) { return false; }
		act({ key: `prompt:${card.id}`, request: { action: 'prompt', object: prompt.object, text: shown } });
		return true;
	};
	return { current, byPerson: prompt?.byPerson ?? false, shown, changed, blank, save, cancel: () => setText(null), edit: setText };
}

/**
 * A box's Generate, an asset card's and an episode card's alike: a request for this one picture, or this one
 * take (a take is shot, takeStage), in the Chat's input, secondary, since the batch is the person's reply in the chat. With an edit it saves first and the request goes
 * once the save is written, so the picture is drawn from the text shown.
 */
function GenerateButton({ stageId, take, edit, busy }: { stageId: string; take: boolean; edit: ReturnType<typeof usePromptEdit>; busy: boolean }) {
	const generate = () => {
		if (edit.blank) { return; }
		if (edit.save()) { generateOnceSaved.add(`prompt:${stageId}`); } else { post({ v: CANVAS_PROTOCOL, type: 'generate', stageId }); }
	};
	return (
		<button className="labeled" disabled={busy || edit.blank} onClick={generate}
			title={edit.blank ? 'The prompt is empty: write it, or press Esc to keep the one shown before' : `${take ? 'Shoot only this segment' : 'Draw only this picture'}: puts a request in the Chat, saving your edit first`}>
			<span className="codicon codicon-play" />Generate
		</button>
	);
}

/** The prompt itself: Planned or Edited by you, and its text. */
function PromptField({ edit, working }: { edit: ReturnType<typeof usePromptEdit>; working: boolean }) {
	const { current, shown, byPerson } = edit;
	if (current === null) {
		return null;
	}
	return (
		<>
			<div className="prompt-head" title="Its next draw starts from this text">{byPerson ? 'Edited by you' : 'Planned'}</div>
			<textarea className="record-text" value={shown} disabled={working} rows={8} aria-label="Prompt"
				title={`${byPerson ? 'Edited by you' : "The agent's"}. Save keeps your text for its next draw (⌘Enter)`}
				onChange={event => edit.edit(event.target.value)}
				onKeyDown={event => {
					if (event.key === 'Escape') { event.stopPropagation(); edit.cancel(); }
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); edit.save(); }
				}} />
		</>
	);
}

/**
 * The box under an asset card (section 1; Pippit 727/734): one text, the picture's prompt
 * as its next draw sends it, edited in place and saved as a new prompt version (`prompt set`, a card action in cardActions.ts). The picture's versions are above it, and one row: + Variant,
 * Import (`entry import`) and Generate, a secondary action for this one picture that puts a request in the Chat's input
 * for the person to send. No description: it is the node's record, changed through the chat.
 */
function RecordPanel({ card, cards, reply, onGo, onClose, importNow, onImport }: { card: CanvasCard; cards: readonly CanvasCard[]; reply: DetailMessage | undefined; onGo: (target: string) => void; onClose: () => void; importNow: boolean; onImport: () => void }) {
	const record = reply?.record ?? null;
	// The object it derives from, by its card.
	const parent = record?.from ? cards.find(c => c.id === record.from) : undefined;
	// + Variant (section 14; the person's option A): a draft with a name and a description only.
	const [draft, setDraft] = useState<{ name: string; text: string } | null>(null);
	const [outcome, setOutcome] = useState<{ key: string; busy: boolean; error: string | null; unchanged: string | null } | null>(null);
	useEffect(() => {
		const ended = (event: Event) => {
			const { key, error, unchanged } = (event as CustomEvent<{ key: string; error: string | null; unchanged: string | null }>).detail;
			setOutcome(now => (now?.key === key ? { key, busy: false, error, unchanged } : now));
			if (!error && key.startsWith('variant:')) {
				setDraft(null);
			}
		};
		window.addEventListener(ACTION_ENDED, ended);
		return () => window.removeEventListener(ACTION_ENDED, ended);
	}, []);
	const busy = outcome?.busy ?? false;
	// The picture's prompt: null for an object with none to edit.
	const prompt = reply?.prompt ?? null;
	const importOwn = () => act({ key: `import:${card.id}`, request: { action: 'import', object: card.id, file: null } });
	const act = (action: EntryAction) => {
		setOutcome({ key: action.key, busy: true, error: null, unchanged: null });
		post({ v: CANVAS_PROTOCOL, type: 'entry', stageId: card.id, ...action });
	};
	// The card's own Import (its face, section 3): run once its record has arrived.
	useEffect(() => {
		if (importNow && (record || reply?.picture) && !busy) {
			onImport();
			importOwn();
		}
	}, [importNow, record, reply?.picture]);
	const edit = usePromptEdit(card, prompt, busy, act);
	const { current, shown, changed, save } = edit;
	// The new variant derives from this object (doc/protocol.md, section 3.1: an add's `from`).
	const addVariant = () => record && draft && draft.name.trim() && draft.text.trim() && !busy
		&& act({ key: `variant:${card.id}`, request: { action: 'add', type: 'variant', from: card.id, name: draft.name.trim(), text: draft.text.trim() } });
	return (
		<div className="detail box nowheel nodrag nopan" onDoubleClick={event => event.stopPropagation()}>
			{/* Which card this is, as the card's footer cannot say it in full (canvas-card.md, section 1c; the person, 753). */}
			<div className="box-head">
				<span className="box-title">{[fullName(card), ...(card.appearsIn?.length ? [card.appearsIn.join(', ')] : [])].join(' · ')}</span>
				{record?.from && <button className="link from" onClick={() => onGo(record.from!)} title="Show what it derives from">from {parent?.name?.node ?? parent?.label ?? record.from} ↗</button>}
				<button className="icon box-close" onClick={onClose} title="Close (Esc)" aria-label="Close"><span className="codicon codicon-close" /></button>
			</div>
			{reply?.picture && <PictureState picture={reply.picture} busy={busy} act={act} />}
			{!reply && <div className="detail-note">Reading its record…</div>}
			{reply?.error && <div className="detail-note">{reply.error}</div>}
			{(record || reply?.picture) && (
				<>
					{current === null && <div className="detail-note">Its prompt is written at the batch stop, or when it is drawn.</div>}
					<PromptField edit={edit} working={busy} />
					<div className="record-actions">
						{changed && <button className="labeled" disabled={busy || !shown.trim()} onClick={save} title="Save as a new prompt version, by you (⌘Enter)">Save</button>}
						{changed && <button className="labeled" disabled={busy} onClick={edit.cancel} title="Discard your edit (Esc)">Cancel</button>}
						<span className="spacer" />
						{record && <button className="labeled" disabled={draft !== null} onClick={() => setDraft({ name: '', text: '' })}
							title="A new variant drawn from this one: a look, a view, a state or a time, with its name and description"><span className="codicon codicon-add" />Variant</button>}
						<button className="labeled" disabled={busy} onClick={importOwn} title="Import your own picture for it"><span className="codicon codicon-file-add" />Import</button>
						<GenerateButton stageId={card.id} take={false} edit={edit} busy={busy} />
					</div>
					{draft && (
						<div className="variant-draft" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); } }}>
							<input className="record-text" autoFocus value={draft.name} maxLength={NAME_MAX} placeholder="Variant name" aria-label="Variant name" disabled={busy}
								onChange={event => setDraft({ ...draft, name: event.target.value })} />
							<textarea className="record-text" value={draft.text} rows={3} maxLength={TEXT_MAX} placeholder="What differs from this one" aria-label="Variant description" disabled={busy}
								onChange={event => setDraft({ ...draft, text: event.target.value })}
								onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); addVariant(); } }} />
							<div className="record-actions">
								<button className="labeled" disabled={busy || !draft.name.trim() || !draft.text.trim()} onClick={addVariant} title="Add it to the project's assets, by you (⌘Enter)">Add</button>
								<button className="labeled" disabled={busy} onClick={() => setDraft(null)} title="Leave nothing behind (Esc)">Cancel</button>
							</div>
						</div>
					)}
				</>
			)}
			{outcome?.busy && <div className="detail-note">Working…</div>}
			{outcome?.error && <div className="detail-note error-text">{outcome.error}</div>}
			{outcome?.unchanged && <div className="detail-note">{outcome.unchanged}</div>}
		</div>
	);
}

/**
 * An episode card's prompt in its box: a keyframe's or a take's, the one its
 * next draw sends, edited and saved as a new version in the project's one local writer (ChatService.writeLocally). Its Generate
 * is the asset box's (amended 2026-11-11): one picture, while the batch stays the person's reply in the chat.
 */
function EpisodePrompt({ card, prompt }: { card: CanvasCard; prompt: CanvasPrompt }) {
	const [outcome, setOutcome] = useState<{ busy: boolean; error: string | null } | null>(null);
	useEffect(() => {
		const ended = (event: Event) => {
			const { key, error } = (event as CustomEvent<{ key: string; error: string | null }>).detail;
			if (key === `prompt:${card.id}`) { setOutcome({ busy: false, error }); }
		};
		window.addEventListener(ACTION_ENDED, ended);
		return () => window.removeEventListener(ACTION_ENDED, ended);
	}, []);
	const working = outcome?.busy ?? false;
	const act = (action: EntryAction) => {
		setOutcome({ busy: true, error: null });
		post({ v: CANVAS_PROTOCOL, type: 'entry', stageId: card.id, ...action });
	};
	const edit = usePromptEdit(card, prompt, working, act);
	if (edit.current === null) {
		return <div className="detail-note">Its prompt is written at the batch stop, or when it is drawn.</div>;
	}
	return (
		<div className="episode-prompt">
			<PromptField edit={edit} working={working} />
			<div className="record-actions">
				{edit.changed && <button className="labeled" disabled={working || edit.blank} onClick={edit.save} title="Save as a new prompt version, by you (⌘Enter)">Save</button>}
				{edit.changed && <button className="labeled" disabled={working} onClick={edit.cancel} title="Discard your edit (Esc)">Cancel</button>}
				<span className="spacer" />
				<GenerateButton stageId={card.id} take={card.kind === 'take'} edit={edit} busy={working} />
			</div>
			{working && <div className="detail-note">Working…</div>}
			{outcome?.error && <div className="detail-note error-text">{outcome.error}</div>}
		</div>
	);
}

/**
 * The read-only detail of the picked card's version (detail panel): the versions it was made from and
 * its prompt, from its record (versionDetail.ts). Nothing here changes anything: a change is asked of the agent.
 * Version history stays in the Versions view.
 */
function DetailPanel({ card, cards, assets, reply, onGo, onClose, importNow = false, onImport = () => undefined }: { card: CanvasCard; cards: readonly CanvasCard[]; assets: boolean; reply: DetailMessage | undefined; onGo: (stageId: string) => void; onClose: () => void; importNow?: boolean; onImport?: () => void }) {
	// Every card on the assets canvas is an asset's: its record, or its picture.
	if (assets) {
		return <RecordPanel key={card.id} card={card} cards={cards} reply={reply} onGo={onGo} onClose={onClose} importNow={importNow} onImport={onImport} />;
	}
	const detail = reply?.detail;
	return (
		// React Flow's own opt-outs for an interactive element inside the flow (ReactFlow props noDragClassName, noWheelClassName
		// and noPanClassName, defaults nodrag, nowheel and nopan): without nopan a press here started a pan of the canvas, and
		// d3-zoom's drag took the gesture, so the prompt could not be selected or copied (@xyflow/system 12.12.0
		// createFilter, the noPanClassName check). Its text is then selectable as any page's: Copy and ⌘C are the webview's own
		// (Code-OSS webview.contribution.ts, overrideCommandForWebview(CopyAction) and the WebviewContext Copy item).
		<div className="detail nowheel nodrag nopan" onDoubleClick={event => event.stopPropagation()}>
			<div className="detail-head">
				<span className="detail-title">{card.label}</span>
				<span className="detail-version"><VersionLine card={card} /></span>
				{card.segment && (
					<button className="labeled" onClick={() => post({ v: CANVAS_PROTOCOL, type: 'segEditor', seg: card.segment })} title={`Open ${card.segment} in the seg editor`}>
						<span className="codicon codicon-device-camera-video" />Open in Seg Editor
					</button>
				)}
				<button className="icon" onClick={onClose} title="Close (Esc)" aria-label="Close"><span className="codicon codicon-close" /></button>
			</div>
			{!reply && <div className="detail-note">Reading {card.version ? `${card.id}/${card.version}` : 'its records'}…</div>}
			{reply?.error && <div className="detail-note">{reply.error}</div>}
			{reply?.prompt && <EpisodePrompt key={card.id} card={card} prompt={reply.prompt} />}
			{reply && !reply.error && !detail && !reply.prompt && (
				<div className="detail-note">{card.kind === 'storyboard' ? 'Its prompt is written when it is drawn: drama-cli plans no board prompt.'
					: card.planned ? 'Planned: not made yet.' : 'Not generated: no version to describe.'}</div>
			)}
			{detail && <RequestView detail={detail} onGo={onGo} />}
		</div>
	);
}

function Canvas({ message, loaded }: { message: Lineage; loaded: Record<string, Loaded> }) {
	const [nodes, setNodes] = useState<AnyNode[]>(() => nodesFor(message, loaded, positionsFor(defaults(message, loaded), message.layout, {}, message.cards, sizesOf(message, loaded), message.episode)));
	// Fixed at mount from the first nodes, which stand somewhere: App mounts the board only when the measured lineage has a card.
	const [openViewport] = useState(() => opening(nodes));
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
	// Where the detail panel opens beside the picked card, and the least panning that shows both: the panel never
	// covers the picture it describes (detail panel).
	const [side, setSide] = useState<Position>(Position.Right);
	const PANEL = { w: 460, h: 420, gap: 14 };
	const reveal = (id: string) => {
		const node = flow.getInternalNode(id);
		const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
		if (!node || !pane) {
			return;
		}
		const { x: vx, y: vy, zoom: z } = flow.getViewport();
		const at = node.internals.positionAbsolute;
		const box = { x1: at.x * z + vx, y1: at.y * z + vy, x2: (at.x + (node.measured.width ?? 0)) * z + vx, y2: (at.y + (node.measured.height ?? 0)) * z + vy };
		const right = box.x2 + PANEL.gap + PANEL.w <= pane.width - 16;
		const left = box.x1 - PANEL.gap - PANEL.w >= 16;
		// An asset card's box is always right under it, centred (section 1; Pippit 727).
		const assetsBox = message.episode === ASSETS_CANVAS;
		const chosen = assetsBox ? Position.Bottom : right ? Position.Right : left ? Position.Left : (box.x2 - box.x1) > PANEL.w ? Position.Bottom : Position.Right;
		setSide(chosen);
		const middle = (box.x1 + box.x2) / 2;
		const area = chosen === Position.Right ? { ...box, x2: box.x2 + PANEL.gap + PANEL.w, y2: Math.max(box.y2, box.y1 + PANEL.h) }
			: chosen === Position.Left ? { ...box, x1: box.x1 - PANEL.gap - PANEL.w, y2: Math.max(box.y2, box.y1 + PANEL.h) }
			: assetsBox ? { x1: Math.min(box.x1, middle - PANEL.w / 2), x2: Math.max(box.x2, middle + PANEL.w / 2), y1: box.y1, y2: box.y2 + PANEL.gap + PANEL.h }
			: { ...box, x2: Math.max(box.x2, box.x1 + PANEL.w), y2: box.y2 + PANEL.gap + PANEL.h };
		const margin = 24;
		const dx = area.x2 > pane.width - margin ? pane.width - margin - area.x2 : area.x1 < margin ? margin - area.x1 : 0;
		const dy = area.y2 > pane.height - 72 ? pane.height - 72 - area.y2 : area.y1 < 48 ? 48 - area.y1 : 0;
		if (dx || dy) {
			void flow.setViewport({ x: vx + dx, y: vy + dy, zoom: z }, { duration: 250 });
		}
	};
	// An undrawn card's Import on its face (AssetCardView): select it, open its box, and import once its record is read.
	const [importFor, setImportFor] = useState<string | null>(null);
	useEffect(() => {
		const faceImport = (event: Event) => {
			const card = message.cards.find(c => c.id === (event as CustomEvent<string>).detail);
			if (!card) {
				return;
			}
			setNodes(current => current.map(n => ({ ...n, selected: n.id === card.id })));
			setImportFor(card.id);
			pick(card);
		};
		window.addEventListener(FACE_IMPORT, faceImport);
		return () => window.removeEventListener(FACE_IMPORT, faceImport);
	});
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
			const panel = document.querySelector('.detail')?.getBoundingClientRect();
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
		const view = opening(nodesFor(message, loaded, to));
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
		// On the assets canvas a link is a variant drawn from its base, dashed as Pippit draws it.
		className: `${picked && (l.from === picked || l.to === picked) ? 'link lit' : 'link'}${message.episode === ASSETS_CANVAS ? ' dashed' : ''}`,
		zIndex: picked && (l.from === picked || l.to === picked) ? 2 : 0,
	})), [message.links, nodes, picked]);

	const shown = (card: CanvasCard) => ({ stageId: card.id, version: card.version, file: card.file });

	return (
		<ReactFlow
			className={`tool-${tool}${assets ? ' assets-canvas' : ''}`}
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
			minZoom={0.05}
			maxZoom={4}
			// The opening view is a prop, not a call after mount: React Flow's `defaultViewport` is the initial pan and zoom (reactflow.dev/api-reference/react-flow#default-viewport).
			defaultViewport={openViewport}
			// The assets canvas opens fitted to the view: `fitView` fits the nodes first given
			// (reactflow.dev/api-reference/react-flow#fitview); a clicked card is then centred (the focus effect above).
			fitView={message.episode === ASSETS_CANVAS}
			fitViewOptions={{ padding: 0.1 }}
			// The workbench marks its theme on the webview body (vscode-light, vscode-dark, vscode-high-contrast).
			colorMode={document.body.classList.contains('vscode-light') ? 'light' : 'dark'}
		>
			{/* A dot grid that reads as a canvas at a glance (the person, 658; React Flow's default gap is 20): the dots take a
			    workbench colour meant to be seen faintly over the editor, in every theme (canvas.css). */}
			<Background variant={BackgroundVariant.Dots} gap={20} size={1.5} className="dots" />
			{minimap && <MiniMap pannable zoomable nodeClassName={node => `mini-${node.type}`} nodeStrokeWidth={0} />}
			{pickedCard && (
				<NodeToolbar nodeId={pickedCard.id} isVisible position={side} align={message.episode === ASSETS_CANVAS ? 'center' : 'start'} offset={14}>
					<DetailPanel card={pickedCard} cards={message.cards} assets={message.episode === ASSETS_CANVAS} reply={detail?.stageId === pickedCard.id ? detail : undefined} onGo={goTo} onClose={() => { pick(undefined); setNodes(current => current.map(n => ({ ...n, selected: false }))); }}
						importNow={importFor === pickedCard.id} onImport={() => setImportFor(null)} />
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
