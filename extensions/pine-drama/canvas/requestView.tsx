// What a version was made with (detail panel; section 12c): the versions it was
// made from, numbered in their order, with their pictures; and its prompt, its "Image N" shown as chips with the Nth
// input's picture. One view for the canvas's panel and the seg editor, over one reader (src/core/versionDetail.ts).
// Read-only.
import type { CanvasDetail } from '../src/core/canvasProtocol';
import './requestView.css';

/** "Image 3" in a prompt, as drama-cli writes the references' order into a request (Image 1). */
const MENTION = /(Image \d+)/g;

/** @param onGo a reference that is a stage's file was clicked: show that stage's card */
export function RequestView({ detail, onGo }: { detail: CanvasDetail; onGo: (stageId: string) => void }) {
	const ref = (n: number) => detail.references.find(r => r.n === n);
	return (
		<>
			{detail.references.length > 0 && (
				<div className="refs">
					{detail.references.map(r => (
						<button key={r.n} className="ref" disabled={!r.stageId} onClick={() => r.stageId && onGo(r.stageId)}
							title={`Image ${r.n}: ${r.file ?? r.raw}${r.stageId ? '\nClick: go to its card' : ''}`}>
							{r.src ? <img src={r.src} draggable={false} loading="lazy" decoding="async" /> : <span className="codicon codicon-file-media" />}
							<span className="n">{r.n}</span>
						</button>
					))}
				</div>
			)}
			{detail.prompt && (
				<div className="prompt">
					{detail.prompt.split(MENTION).map((part, i) => {
						const mentioned = /^Image \d+$/.test(part) ? ref(Number(part.slice(6))) : undefined;
						return mentioned ? <span key={i} className="mention">{mentioned.src && <img src={mentioned.src} loading="lazy" decoding="async" />}{part}</span> : <span key={i}>{part}</span>;
					})}
				</div>
			)}
			<div className="meta"><span className="pill" title="When it was finished">{new Date(detail.madeAt).toLocaleString()}</span></div>
		</>
	);
}
