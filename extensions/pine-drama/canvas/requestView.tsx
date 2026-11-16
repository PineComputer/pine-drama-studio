// What a version was made with (detail panel; section 12c): the versions it was made from, the pictures as pictures,
// the videos (a take's motion reference) as videos and the others by name, and its prompt. One view for the canvas's panel and the seg editor, over one reader
// (src/core/versionDetail.ts). Read-only.
import type { CanvasDetail, MadeFrom } from '../src/core/canvasProtocol';
import './requestView.css';

/** A picture it was made from: its thumbnail, its "Image N" where known, its card a click away. */
export function PictureRef({ r, onGo }: { r: MadeFrom; onGo: (stageId: string) => void }) {
	const name = r.n ? `Image ${r.n}: ${r.label}` : r.label;
	return (
		<button className="ref" disabled={!r.stageId} onClick={() => r.stageId && onGo(r.stageId)} title={`${name}${r.stageId ? '\nClick: go to its card' : ''}`}>
			{r.src ? <img src={r.src} draggable={false} loading="lazy" decoding="async" /> : <span className="codicon codicon-file-media" />}
			{r.n && <span className="n">{r.n}</span>}
		</button>
	);
}

/** @param onGo a version it was made from was clicked: show that version's card */
export function RequestView({ detail, onGo }: { detail: CanvasDetail; onGo: (stageId: string) => void }) {
	const go = (stageId: string | null) => () => stageId && onGo(stageId);
	return (
		<>
			{detail.pictures.length > 0 && (
				<div className="refs">
					{detail.pictures.map((r, i) => <PictureRef key={i} r={r} onGo={onGo} />)}
				</div>
			)}
			{detail.videos.map((r, i) => (
				<div key={i} className="video-ref" title={`Video ${r.n}: ${r.label}`}>
					{r.src ? <video src={r.src} muted loop controls preload="metadata" /> : <span className="codicon codicon-file-media" />}
					<button className="pill" disabled={!r.stageId} onClick={go(r.stageId)}>{`Video ${r.n}: ${r.label}`}</button>
				</div>
			))}
			{detail.madeFrom.length > 0 && (
				<div className="meta">
					{detail.madeFrom.map((r, i) => <button key={i} className="pill" disabled={!r.stageId} onClick={go(r.stageId)} title={`${r.label}${r.stageId ? '\nClick: go to its card' : ''}`}>{r.label}</button>)}
				</div>
			)}
			{detail.prompt && <div className="prompt">{detail.prompt}</div>}
			{detail.madeAt && <div className="meta"><span className="pill" title="When it was finished">{new Date(detail.madeAt).toLocaleString()}</span></div>}
		</>
	);
}
