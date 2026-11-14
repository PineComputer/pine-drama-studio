// The seg editor's webview: a strip of the episode's segs at
// the bottom, "seg01 · 14s", and in the centre the chosen seg's take playing, its takes to switch between, and what the
// take was made with (or, before any take, its planned prompt); Full episode plays the accepted cut. Generate and
// Regenerate put the request in the Chat's input for the person to send. The toggle opens the episode's canvas.
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import '@vscode/codicons/dist/codicon.css';
import './seg.css';
import { RequestView } from './requestView';
import type { CanvasDetail } from '../src/core/canvasProtocol';
import { SEG_PROTOCOL, type FromSegEditor, type Poster, type Seg, type SegEditorModel, type ToSegEditor } from '../src/core/segEditorProtocol';
import { stripDelta } from '../src/core/segStrip';

declare function acquireVsCodeApi(): { postMessage(message: FromSegEditor): void; getState(): Record<string, string> | undefined; setState(state: Record<string, string>): void };
const vscode = acquireVsCodeApi();
const kept = vscode.getState();
vscode.setState({ ...document.body.dataset, ...(kept?.seg ? { seg: kept.seg } : {}) } as Record<string, string>);
const post = (message: FromSegEditor) => vscode.postMessage(message);
window.addEventListener('error', event => post({ v: SEG_PROTOCOL, type: 'failed', message: `${event.message} (${event.filename}:${event.lineno})` }));

/** This page's own name for its asks: a page drawn again after its panel was hidden never reads an answer to the one before. */
const PAGE = crypto.randomUUID();

/** The full episode's place in the page state, which keeps strings only. */
const FULL = '#full';

/**
 * What each take on screen was made with, as the extension read it (undefined while asked), by `<page>:<model>:<take>@<version>`:
 * each new model asks again, and an answer to an ask from an older one lands under a key no longer read.
 */
type Requests = Readonly<Record<string, CanvasDetail | null>>;

function Editor({ model, read, chosen, choose, requests }: { model: SegEditorModel; read: number; chosen: string | undefined; choose: (id: string) => void; requests: Requests }) {
	const full = chosen === FULL;
	const seg = full ? undefined : model.segs.find(s => s.id === chosen) ?? model.segs[0];
	// The take the person switched to, per seg; a seg not switched, or whose switched take is gone, plays its shown take.
	const [picked, setPicked] = useState<Record<string, string>>({});
	const take = seg && (seg.takes.find(t => t.version === picked[seg.id]) ?? seg.takes.find(t => t.version === seg.shown));
	const strip = useRef<HTMLElement>(null);
	// The chosen tile is scrolled into view, at opening too (a seg chosen before a reload).
	useEffect(() => {
		strip.current?.querySelector('.seg.chosen')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [full, seg?.id]);
	return (
		<div className="editor">
			<header>
				<h1>{model.episode}{full ? ' · Full episode' : seg ? ` · ${seg.id}` : ''}</h1>
				<span className="muted" title="Versions and your choices are current; the badges are as of the last return">{model.observedAt ? `As of ${new Date(model.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'No return yet'}</span>
				<span className="actions">
					{seg && seg.takes.length > 0 && (
						<select value={take?.version ?? ''} onChange={event => setPicked({ ...picked, [seg.id]: event.target.value })} title="The take that plays">
							{seg.takes.map(t => <option key={t.version} value={t.version}>{`${t.version} · ${t.label}`}</option>)}
						</select>
					)}
					{seg && (
						<button onClick={() => post({ v: SEG_PROTOCOL, type: 'generate', seg: seg.id, again: seg.takes.length > 0 })} title="Put the request in the Chat for you to send">
							<span className="codicon codicon-device-camera-video" /> {seg.takes.length > 0 ? 'Regenerate' : 'Generate'}
						</button>
					)}
					<button onClick={() => post({ v: SEG_PROTOCOL, type: 'canvas' })} title="Open this episode's canvas">
						<span className="codicon codicon-type-hierarchy" /> Canvas
					</button>
				</span>
			</header>
			<main>
				{full ? (model.cut ? <Player src={model.cut.src} missing={`${model.cut.version} shows no file.`} />
					: <p className="muted">No cut is approved yet: it is made once the takes are approved.</p>)
					: !seg ? <p className="muted">No segs yet: they appear once this episode's breakdown is made.</p>
						: <>
							{take && <Player src={take.src} missing={`${take.version} shows no file.`} />}
							<Prompt seg={seg} take={take} ask={seg.take && take ? `${PAGE}:${read}:${seg.take}@${take.version}` : null} requests={requests} />
						</>}
			</main>
			<nav className="strip" ref={strip} onWheel={event => {
				const by = stripDelta(event.deltaX, event.deltaY);
				if (by && strip.current) {
					strip.current.scrollLeft += by;
				}
			}}>
				<button className={full ? 'seg chosen' : 'seg'} onClick={() => choose(FULL)}>
					<Thumb poster={model.cut?.src ? { media: 'video', src: model.cut.src } : null} icon="film" />
					<span className="name">Full episode</span>
					<span className={model.cut ? 'badge accepted' : 'badge'}>{model.cut ? `Cut ${model.cut.version}` : 'No cut yet'}</span>
				</button>
				{model.segs.map(s => (
					<button key={s.id} className={s.id === seg?.id ? 'seg chosen' : 'seg'} onClick={() => choose(s.id)}>
						<Thumb poster={s.poster} icon="device-camera-video" />
						<span className="name">{s.id}</span>
						<span className={`badge ${s.badge === 'Approved' ? 'accepted' : s.badge === 'Waiting for review' ? 'review' : ''}`}>{s.badge}</span>
					</button>
				))}
			</nav>
		</div>
	);
}

/** The take or the cut, playing: the local file in its version folder. */
function Player({ src, missing }: { src: string | null; missing: string }) {
	return src ? <video key={src} className="player" src={src} controls playsInline /> : <p className="muted">{missing}</p>;
}

/** A tile's picture: the take's frame at 0.5 s (a take's first frame is often black), a keyframe, or the icon. */
function Thumb({ poster, icon }: { poster: Poster | null; icon: string }) {
	return (
		<span className="thumb">
			{poster?.media === 'video' ? <video src={`${poster.src}#t=0.5`} preload="metadata" muted playsInline />
				: poster?.media === 'image' ? <img src={poster.src} draggable={false} loading="lazy" decoding="async" />
					: <span className={`codicon codicon-${icon}`} />}
		</span>
	);
}

/** A seg's planned prompt, before its take (section 12c; Pippit's clip view; 760.png). Read-only. */
function PlannedView({ planned }: { planned: NonNullable<Seg['planned']> }) {
	return (
		<div className="planned">
			<div className="planned-head">{planned.by === 'person' ? 'Edited by you' : 'Planned'}</div>
			<pre className="planned-text">{planned.text}</pre>
		</div>
	);
}

function Prompt({ seg, take, ask, requests }: { seg: Seg; take: Seg['takes'][number] | undefined; ask: string | null; requests: Requests }) {
	// The take shown asks once per model for what it was made with; the answer arrives as a 'request' message (App).
	useEffect(() => {
		if (ask && seg.take && take) { post({ v: SEG_PROTOCOL, type: 'request', take: seg.take, version: take.version, key: ask }); }
	}, [ask]);
	const request = ask ? requests[ask] : undefined;
	return (
		<section className="request">
			{ask && request === undefined ? <p className="muted">Reading its request…</p>
				: request ? <RequestView detail={request} onGo={stageId => post({ v: SEG_PROTOCOL, type: 'go', stageId })} />
				: seg.planned ? <PlannedView planned={seg.planned} />
				: <p className="muted">No prompt yet: it is written when the take is planned, and shows here before any take.</p>}
		</section>
	);
}

function App() {
	const [model, setModel] = useState<SegEditorModel>();
	const [error, setError] = useState<string>();
	const [chosen, setChosen] = useState<string | undefined>(kept?.seg);
	const [requests, setRequests] = useState<Requests>({});
	// Which read of the episode the page shows: each model message is a new one.
	const [read, setRead] = useState(0);
	const choose = (id: string) => {
		setChosen(id);
		vscode.setState({ ...document.body.dataset, seg: id } as Record<string, string>);
	};
	useEffect(() => {
		const listener = (event: MessageEvent<ToSegEditor>) => {
			const message = event.data;
			if (message?.v !== SEG_PROTOCOL) {
				return;
			}
			if (message.type === 'model') {
				setModel(message.model);
				// A new read of the episode: each take shown is asked again, as its files may have changed.
				setRead(n => n + 1);
				setError(undefined);
			} else if (message.type === 'request') {
				setRequests(now => ({ ...now, [message.key]: message.request }));
			} else if (message.type === 'show') {
				choose(message.seg);
			} else if (message.type === 'error') {
				setError(message.message);
			}
		};
		window.addEventListener('message', listener);
		post({ v: SEG_PROTOCOL, type: 'ready' });
		return () => window.removeEventListener('message', listener);
	}, []);
	if (error) {
		return <p className="error">{error}</p>;
	}
	return model ? <Editor model={model} read={read} chosen={chosen} choose={choose} requests={requests} /> : <p className="muted">Reading the episode…</p>;
}

createRoot(document.getElementById('root')!).render(<App />);
