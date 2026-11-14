// An asset grid (characters, scenes, props: one card per asset, as Pippit's asset grid) of the drama's objects. A click
// opens the assets canvas on the card (galleries.ts). Workbench colours only.
import { createRoot } from 'react-dom/client';
import { createContext, useContext, useEffect, useState } from 'react';
import '@vscode/codicons/dist/codicon.css';
import './gallery.css';
import { GALLERY_PROTOCOL, NAME_MAX, TEXT_MAX, visualsLine, type AddType, type EntryAction, type FromGallery, type PageTile, type Setting, type ToGallery } from '../src/core/galleryProtocol';

declare function acquireVsCodeApi(): { postMessage(message: FromGallery): void; getState(): Record<string, string> | undefined; setState(state: Record<string, string>): void };
const vscode = acquireVsCodeApi();
// The page's identity (its data attributes) is what the serializer revives.
vscode.setState({ ...document.body.dataset } as Record<string, string>);
const post = (message: FromGallery) => vscode.postMessage(message);
window.addEventListener('error', event => post({ v: GALLERY_PROTOCOL, type: 'failed', message: `${event.message} (${event.filename}:${event.lineno})` }));
document.addEventListener('securitypolicyviolation', event => post({ v: GALLERY_PROTOCOL, type: 'failed', message: `blocked by the content security policy: ${event.violatedDirective} ${event.blockedURI}` }));

/**
 * Card actions: each writes the person's choices in the extension (cardActions.ts). A card or
 * section with an action under way is busy until the extension says it ended, with its words when it failed; the page
 * itself then reads the drama again.
 */
type Outcomes = Readonly<Record<string, { readonly busy: boolean; readonly error: string | null; readonly unchanged?: string | null }>>;
const Actions = createContext<{ outcomes: Outcomes; run: (action: EntryAction) => void }>({ outcomes: {}, run: () => undefined });

function Outcome({ at }: { at: string }) {
	const outcome = useContext(Actions).outcomes[at];
	return outcome?.busy ? <div className="action-line muted">Working…</div> : outcome?.error ? <div className="action-line error">{outcome.error}</div>
		: outcome?.unchanged ? <div className="action-line muted">{outcome.unchanged}</div> : null;
}

/** The key a card's actions report their outcome under: its object's. */
const cardKey = (tile: PageTile) => `card:${tile.stagePath}`;

/**
 * A grid card's actions behind its ⋯ button, as Pippit's card menu: Import of the person's own picture, which a
 * file dropped on the card does too, Change description and Delete, as its object's actions allow (actionsOf).
 */
function CardMenu({ tile }: { tile: PageTile }) {
	const { outcomes, run } = useContext(Actions);
	const [open, setOpen] = useState(false);
	const object = tile.stagePath;
	const remove = tile.actions.delete;
	const key = cardKey(tile);
	const busy = outcomes[key]?.busy ?? false;
	const act = (action: EntryAction) => { setOpen(false); run(action); };
	return (
		<div className="card-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); } }}>
			<button className="more" disabled={busy} aria-haspopup="menu" aria-expanded={open} title="Actions" onClick={() => setOpen(!open)}><span className="codicon codicon-ellipsis" /></button>
			{open && (
				<div className="menu" role="menu">
					{tile.actions.edit && <button role="menuitem" title="Import your picture; or drop it on the card"
						onClick={() => act({ key, request: { action: 'import', object, file: null } })}>Import</button>}
					{tile.actions.edit && <button role="menuitem" title={`Change the description of ${tile.name}`}
						onClick={() => act({ key, request: { action: 'describe', object, description: tile.description } })}>Change description</button>}
					{remove && <button role="menuitem" title={`Delete ${tile.name} from the project's assets`}
						onClick={() => act({ key, request: remove })}>Delete</button>}
				</div>
			)}
		</div>
	);
}

/** A file dropped on a card that takes uploads: its bytes go to the extension, which imports them (the webview has no path). */
function useDrop(tile: PageTile) {
	const { outcomes, run } = useContext(Actions);
	const [over, setOver] = useState(false);
	const object = tile.stagePath;
	if (!tile.actions.edit) {
		return { over: false, handlers: {} };
	}
	const key = cardKey(tile);
	return {
		over,
		handlers: {
			onDragOver: (event: React.DragEvent) => { event.preventDefault(); setOver(true); },
			onDragLeave: () => setOver(false),
			onDrop: (event: React.DragEvent) => {
				event.preventDefault();
				setOver(false);
				const file = event.dataTransfer.files[0];
				if (!file || outcomes[key]?.busy) {
					return;
				}
				void file.arrayBuffer().then(buffer => run({ key, request: { action: 'importDropped', object, name: file.name, bytes: new Uint8Array(buffer) } }));
			},
		},
	};
}

const SINGULAR: Record<string, string> = { characters: 'character', scenes: 'scene', props: 'prop' };

/**
 * The grid's last card, Create New, as Pippit and LibTV do it (668-670): a click shows a new empty card at
 * once, "Unnamed character", with its name field focused and its description under it; a scene also states whether it
 * is an interior or an exterior (doc/protocol.md, section 3.1: an add's `setting`). Save adds it to the person's
 * choices at once, with no model and no chat; its card shows at once and stays as the object a task makes of it. Closing it without a name
 * leaves nothing behind.
 */
function CreateNew({ kind, type }: { kind: string; type: AddType }) {
	const { outcomes, run } = useContext(Actions);
	const key = `add:${kind}`;
	const outcome = outcomes[key];
	const busy = outcome?.busy ?? false;
	const [draft, setDraft] = useState<{ name: string; description: string; setting: Setting | null } | null>(null);
	const [sent, setSent] = useState(false);
	useEffect(() => {
		if (sent && outcome && !outcome.busy) {
			setSent(false);
			if (!outcome.error) {
				setDraft(null);
			}
		}
	}, [sent, outcome]);
	const scene = type === 'scene';
	const ready = !!draft && !!draft.name.trim() && !!draft.description.trim() && (!scene || draft.setting !== null);
	const save = () => {
		if (draft && ready && !busy) {
			setSent(true);
			run({ key, request: { action: 'add', type, name: draft.name.trim(), text: draft.description.trim(), ...(scene && draft.setting ? { setting: draft.setting } : {}) } });
		}
	};
	const close = () => { if (!busy) { setDraft(null); } };
	return (
		<>
			{draft && (
				<div className="card draft" onKeyDown={event => { if (event.key === 'Escape') { close(); } }}
					onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !draft.name.trim() && !draft.description.trim()) { close(); } }}>
					<div className="thumb"><span className={`codicon codicon-${KIND_ICON[kind] ?? 'circle-large'} kind`} /></div>
					<input className="draft-name" autoFocus value={draft.name} maxLength={NAME_MAX} placeholder={`Unnamed ${SINGULAR[kind] ?? kind}`} aria-label="Name" disabled={busy}
						onChange={event => setDraft({ ...draft, name: event.target.value })}
						onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
					<textarea className="draft-text" value={draft.description} rows={4} maxLength={TEXT_MAX} placeholder="Description" aria-label="Description" disabled={busy}
						onChange={event => setDraft({ ...draft, description: event.target.value })}
						onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); } }} />
					{scene && (
						<div className="draft-actions" role="radiogroup" aria-label="Setting">
							{(['interior', 'exterior'] as const).map(setting => (
								<button key={setting} role="radio" aria-checked={draft.setting === setting} className={draft.setting === setting ? 'primary' : undefined} disabled={busy}
									onClick={() => setDraft({ ...draft, setting })}>{setting === 'interior' ? 'Interior' : 'Exterior'}</button>
							))}
						</div>
					)}
					<div className="draft-actions">
						<button className="primary" disabled={!ready || busy} onClick={save} title="Add it to the project's assets (Enter)">Save</button>
						<button onClick={close} disabled={busy} title="Leave nothing behind (Esc)">Cancel</button>
					</div>
					<Outcome at={key} />
				</div>
			)}
			<div className="card">
				<button className="tile" disabled={draft !== null} onClick={() => setDraft({ name: '', description: '', setting: null })} title={`A new ${SINGULAR[kind] ?? kind}`}>
					<div className="thumb"><span className="codicon codicon-add create" /></div>
					<div className="name">Create New</div>
				</button>
			</div>
		</>
	);
}

/**
 * A card's marks of the person's choices: the outgoing arrow while the Computer has not seen the
 * choice, the spinner and its line while a task creates an add, and the last return's problem for it.
 */
function Marks({ tile }: { tile: PageTile }) {
	return (
		<>
			{tile.outgoing && <span className="mark codicon codicon-arrow-up" title={tile.outgoing} aria-label={tile.outgoing} />}
			{tile.inFlight && <div className="action-line muted"><span className="codicon codicon-loading codicon-modifier-spin" /> {tile.inFlight}</div>}
			{tile.problem && <div className="action-line error">{[tile.problem.message, tile.problem.action].filter(Boolean).join(' ')}</div>}
		</>
	);
}

const KIND_ICON: Record<string, string> = { characters: 'person', scenes: 'location', props: 'package' };

/**
 * One asset's card (Pippit's asset grid): its picture, or the kind's icon while it has none; its name; and its stages
 * counted, in the accent colour while some are to be set. The record's description is the card's tooltip.
 */
function GridCard({ tile, kind }: { tile: PageTile; kind: string }) {
	// Every click on an asset goes one way, as in Pippit: the assets canvas, with the asset's root selected and its box open
	// (galleries.ts; AC1; the person's 751.png). A picture opens from its canvas card, never from here.
	const open = () => post({ v: GALLERY_PROTOCOL, type: 'open', stagePath: tile.stagePath });
	const src = tile.src;
	const line = tile.visuals && visualsLine(tile.visuals);
	const drop = useDrop(tile);
	return (
		<div className={drop.over ? 'card dropping' : 'card'} {...drop.handlers}>
			<button className="tile" onClick={open} title={tile.description || tile.name}>
				<div className="thumb">
					{src ? <img src={src} draggable={false} loading="lazy" /> : <span className={`codicon codicon-${KIND_ICON[kind] ?? 'circle-large'} kind`} />}
				</div>
				<div className="name">{tile.name}</div>
				{/* One kind of caption on every card (751.png): its count, or nothing; a live picture's words are in the tooltip. */}
				{line && <div className={tile.visuals!.needed ? 'visuals needed' : 'visuals'}>{line}</div>}
			</button>
			<Marks tile={tile} />
			{(tile.actions.edit || tile.actions.delete) && <CardMenu tile={tile} />}
			<Outcome at={cardKey(tile)} />
		</div>
	);
}

function App() {
	const [page, setPage] = useState<Exclude<ToGallery, { type: 'actionEnded' }> | null>(null);
	const [outcomes, setOutcomes] = useState<Outcomes>({});
	const run = (action: EntryAction) => {
		setOutcomes(now => ({ ...now, [action.key]: { busy: true, error: null } }));
		post({ v: GALLERY_PROTOCOL, type: 'entry', ...action });
	};
	useEffect(() => {
		const listen = (event: MessageEvent<ToGallery>) => {
			const message = event.data;
			if (message?.v !== GALLERY_PROTOCOL) {
				return;
			}
			if (message.type === 'actionEnded') {
				setOutcomes(now => ({ ...now, [message.key]: { busy: false, error: message.error, unchanged: message.unchanged } }));
			} else {
				setPage(message);
				// The kind shown is what a reload revives (galleries.ts, the serializer).
				if (message.type === 'page' && message.kind) {
					vscode.setState({ ...vscode.getState(), gallery: message.kind });
				}
			}
		};
		window.addEventListener('message', listen);
		post({ v: GALLERY_PROTOCOL, type: 'ready' });
		return () => window.removeEventListener('message', listen);
	}, []);
	if (!page) {
		return <div className="page muted">Reading the project…</div>;
	}
	if (page.type === 'error') {
		return <div className="page"><h1>Not available</h1><p>{page.message}</p></div>;
	}
	// An asset grid: just the cards, Create New last; the tree's row says how many. Its kind is
	// the message's own, so its cards and their icon always come from one read.
	const kind = page.kind ?? '';
	const grid = page.sections[0];
	return (
		<Actions.Provider value={{ outcomes, run }}>
		<div className="page">
			{page.note && <p className="muted">{page.note}</p>}
			<div className={`grid assets ${kind}`}>
				{grid?.tiles.map(tile => <GridCard key={tile.stagePath} tile={tile} kind={kind} />)}
				{grid?.add && <CreateNew kind={kind} type={grid.add} />}
			</div>
		</div>
		</Actions.Provider>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
