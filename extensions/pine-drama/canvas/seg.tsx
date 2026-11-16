// The seg editor's webview: a strip of the episode's segs at the bottom, and in the centre the chosen seg's take
// playing and what it was made with (its receipt), or before any take its prompt; Full episode plays the cut. Generate
// and Regenerate put the request in the Chat's input for the person to send. The toggle opens the episode's canvas.
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import '@vscode/codicons/dist/codicon.css';
import './seg.css';
import { RequestView } from './requestView';
import { SEG_PROTOCOL, type FromSegEditor, type Poster, type Seg, type SegEditorModel, type ToSegEditor } from '../src/core/segEditorProtocol';
import { stripDelta } from '../src/core/segStrip';

declare function acquireVsCodeApi(): { postMessage(message: FromSegEditor): void; getState(): Record<string, string> | undefined; setState(state: Record<string, string>): void };
const vscode = acquireVsCodeApi();
const kept = vscode.getState();
vscode.setState({ ...document.body.dataset, ...(kept?.seg ? { seg: kept.seg } : {}) } as Record<string, string>);
const post = (message: FromSegEditor) => vscode.postMessage(message);
window.addEventListener('error', event => post({ v: SEG_PROTOCOL, type: 'failed', message: `${event.message} (${event.filename}:${event.lineno})` }));

/** The full episode's place in the page state, which keeps strings only. */
const FULL = '#full';

function Editor({ model, chosen, choose }: { model: SegEditorModel; chosen: string | undefined; choose: (id: string) => void }) {
	const full = chosen === FULL;
	const seg = full ? undefined : model.segs.find(s => s.id === chosen) ?? model.segs[0];
	const strip = useRef<HTMLElement>(null);
	// The chosen tile is scrolled into view, at opening too (a seg chosen before a reload).
	useEffect(() => {
		strip.current?.querySelector('.seg.chosen')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [full, seg?.id]);
	return (
		<div className="editor">
			<header>
				<h1>{model.episode}{full ? ' · Full episode' : seg ? ` · ${seg.id}` : ''}</h1>
				<span className="actions">
					{seg && (
						<button onClick={() => post({ v: SEG_PROTOCOL, type: 'generate', seg: seg.id, again: seg.src !== null })} title="Put the request in the Chat for you to send">
							<span className="codicon codicon-device-camera-video" /> {seg.src !== null ? 'Regenerate' : 'Generate'}
						</button>
					)}
					<button onClick={() => post({ v: SEG_PROTOCOL, type: 'canvas' })} title="Open this episode's canvas">
						<span className="codicon codicon-type-hierarchy" /> Canvas
					</button>
				</span>
			</header>
			<main>
				{full ? (model.cut ? <Player src={model.cut.src} />
					: <p className="muted">No cut yet: it is made once the takes are shot.</p>)
					: !seg ? <p className="muted">No segs yet: they appear once this episode's breakdown is made.</p>
						: <>
							{seg.src && <Player src={seg.src} />}
							<Prompt seg={seg} />
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
					{!model.cut && <span className="badge">No cut yet</span>}
				</button>
				{model.segs.map(s => (
					<button key={s.id} className={s.id === seg?.id ? 'seg chosen' : 'seg'} onClick={() => choose(s.id)}>
						<Thumb poster={s.poster} icon="device-camera-video" />
						<span className="name">{s.id}</span>
						{s.badge && <span className="badge">{s.badge}</span>}
					</button>
				))}
			</nav>
		</div>
	);
}

/** The take or the cut, playing: the local file in its version folder. */
function Player({ src }: { src: string }) {
	return <video key={src} className="player" src={src} controls playsInline />;
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

/** A seg's own prompt (section 12c; Pippit's clip view; 760.png), which the agent writes. Read-only. */
function PlannedView({ text }: { text: string }) {
	return (
		<div className="planned">
			<div className="planned-head">Your own prompt</div>
			<pre className="planned-text">{text}</pre>
		</div>
	);
}

/** The take's own prompt, which its next shoot sends as written (prompt.md), else none, and what the shown take was made with behind its disclosure. */
function Prompt({ seg }: { seg: Seg }) {
	return (
		<section className="request">
			{seg.prompt !== null ? <PlannedView text={seg.prompt} />
				: <p className="muted">The automatic prompt: composed when the take is shot.</p>}
			{seg.request && (
				<details className="made">
					<summary>How it was made</summary>
					<RequestView detail={seg.request} onGo={stageId => post({ v: SEG_PROTOCOL, type: 'go', stageId })} />
				</details>
			)}
		</section>
	);
}

function App() {
	const [model, setModel] = useState<SegEditorModel>();
	const [error, setError] = useState<string>();
	const [chosen, setChosen] = useState<string | undefined>(kept?.seg);
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
				setError(undefined);
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
	return model ? <Editor model={model} chosen={chosen} choose={choose} /> : <p className="muted">Reading the episode…</p>;
}

createRoot(document.getElementById('root')!).render(<App />);
