// What a version was made with (detail panel; section 12c): the versions it was made from, the pictures as pictures
// and the others by name, and its prompt. One view for the canvas's panel and the seg editor, over one reader
// (src/core/versionDetail.ts). Read-only.
import type { CanvasDetail } from '../src/core/canvasProtocol';
import './requestView.css';

/** @param onGo a version it was made from was clicked: show that version's card */
export function RequestView({ detail, onGo }: { detail: CanvasDetail; onGo: (stageId: string) => void }) {
	const go = (stageId: string | null) => () => stageId && onGo(stageId);
	return (
		<>
			{detail.pictures.length > 0 && (
				<div className="refs">
					{detail.pictures.map((r, i) => (
						<button key={i} className="ref" disabled={!r.stageId} onClick={go(r.stageId)} title={`${r.label}${r.stageId ? '\nClick: go to its card' : ''}`}>
							<img src={r.src!} draggable={false} loading="lazy" decoding="async" />
						</button>
					))}
				</div>
			)}
			{detail.madeFrom.length > 0 && (
				<div className="meta">
					{detail.madeFrom.map((r, i) => <button key={i} className="pill" disabled={!r.stageId} onClick={go(r.stageId)} title={`${r.label}${r.stageId ? '\nClick: go to its card' : ''}`}>{r.label}</button>)}
				</div>
			)}
			{detail.prompt && <div className="prompt">{detail.prompt}</div>}
			<div className="meta"><span className="pill" title="When it was finished">{new Date(detail.madeAt).toLocaleString()}</span></div>
		</>
	);
}
