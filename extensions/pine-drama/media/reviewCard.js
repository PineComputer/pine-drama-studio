// @ts-check
/* Host-confirmed review drafts. No natural-language interpretation or optimistic submission. */
/** @typedef {import('../src/core/reviewCardProtocol').ReviewCardUpdate} ReviewCardUpdate */
/** @typedef {import('../src/core/reviewCardProtocol').ReviewCardAction} ReviewCardAction */
(() => {
	/** @type {import('vscode-webview').WebviewApi<{ open?: boolean; notes?: Record<string, string>; words?: string; last?: Exclude<ReviewCardUpdate, { error: string }> }>} */
	const api = acquireVsCodeApi();
	const root = /** @type {HTMLElement} */ (document.getElementById('review'));
	const error = /** @type {HTMLElement} */ (document.getElementById('error'));
	let wasSubmitted = false;
	const notes = { ...(api.getState()?.notes || {}) };
	// The Anything else field (Decisions in Chat): the person's own words for no single item, sent with Submit.
	const WORDS = '__words';
	let words = api.getState()?.words ?? '';
	// The card the host last confirmed, kept in the webview's state: when Chat is hidden and shown again, upstream reloads
	// the webview and gives it back that state (chatMarkdownContentPart.ts, onDidUpdateState and reinitialize;
	// chatOutputItemRenderer.ts, webview.state), so the card paints from it at once instead of an empty frame, then asks the
	// host for the current one (VS Code webview guide, "getState and setState").
	let last = api.getState()?.last;
	const saveState = open => api.setState({ open, notes, words, last });
	/** @param {ReviewCardAction} message */
	const send = message => api.postMessage(message);
	const el = (tag, text, parent = root) => { const e = document.createElement(tag); e.textContent = text; parent.append(e); return e; };
	const button = (parent, text, action, disabled = false) => {
		const b = el('button', text, parent); b.type = 'button'; b.disabled = disabled; b.onclick = action; return b;
	};
	// A webview has no log in Output: its failures and an empty paint go to the host, which writes the line (reviewCard.ts).
	/** @param {string} message */
	const report = message => send({ version: 1, action: 'report', message });
	window.addEventListener('error', e => report(`${e.message} at ${e.filename}:${e.lineno}`));
	window.addEventListener('unhandledrejection', e => report(`unhandled rejection: ${String(e.reason)}`));
	window.addEventListener('message', (/** @type {MessageEvent<ReviewCardUpdate>} */ { data }) => {
		if (data.version !== 1) { return; }
		if ('error' in data) { error.textContent = data.error; return; }
		error.textContent = '';
		last = data;
		saveState(api.getState()?.open);
		try { render(data); } catch (e) { report(`render failed: ${String(e)}`); return; }
		if (!root.children.length && !root.textContent) { report('the card rendered with no content'); }
	});
	// From Submit until the host replies, nothing on the card can be changed or sent (PR C, fix-plan item 3).
	const submit = () => {
		root.querySelectorAll('button, textarea').forEach(control => { /** @type {HTMLButtonElement | HTMLTextAreaElement} */ (control).disabled = true; });
		send({ version: 1, action: 'submit', notes, words });
	};
	/** @param {Exclude<ReviewCardUpdate, { error: string }>} data */
	const render = data => {
		const review = data.review;
		if (!review) { root.textContent = 'This review is unavailable.'; return; }
		// Preserve focused note and selection while the host confirms another edit.
		const active = /** @type {HTMLTextAreaElement | null} */ (document.activeElement);
		const focused = active?.dataset.note;
		const selection = active && focused ? [active.selectionStart, active.selectionEnd] : undefined;
		// A host acknowledgement must not replace an active IME composition or an unblurred draft.
		if (focused && !data.locked && (focused === WORDS || review.verdicts[focused]?.verdict === 'revise')) { return; }
		root.replaceChildren();
		const details = el('details', '');
		const saved = api.getState() || {};
		details.open = review.submitted && !wasSubmitted ? false : saved.open ?? !review.submitted;
		wasSubmitted = !!review.submitted;
		details.ontoggle = () => saveState(details.open);
		el('summary', `${review.submitted ? '✓ Reviewed' : 'Review'} · ${review.subject} · ${review.items.length} ${review.items.length === 1 ? 'item' : 'items'}`, details);
		if (!data.locked && review.items.length > 1) { button(details, 'Approve all', () => send({ version: 1, action: 'approveAll' })); }
		const grid = el('div', '', details); grid.className = 'items';
		for (const item of review.items) {
			const card = el('section', '', grid); const verdict = review.verdicts[item.key];
			el('h3', item.label, card);
			let supporting;
			item.files.forEach((file, index) => {
				if (index > 0 && !data.thumbnails?.[item.key]?.[index] && !supporting) { supporting = el('details', '', card); el('summary', 'Details and changes', supporting); }
				const parent = index > 0 && !data.thumbnails?.[item.key]?.[index] ? supporting : card;
				const b = button(parent, file.relPath.split('/').at(-1), () => send({ version: 1, action: 'open', item: item.key, file: index }), file.here === false);
				b.className = 'file-link';
				const src = data.thumbnails?.[item.key]?.[index];
				if (src) { const img = document.createElement('img'); img.src = src; img.alt = item.label; b.prepend(img); b.className = 'thumbnail'; }
			});
			const actions = el('div', '', card); actions.className = 'actions';
			for (const [value, label] of /** @type {const} */ ([['approve', 'Approve'], ['revise', 'Change']])) {
				const selected = verdict?.verdict === value;
				const title = selected ? (value === 'approve' ? 'Approved' : 'Changes requested') : label;
				const b = button(actions, title, () => send({ version: 1, action: 'decide', item: item.key, verdict: value }), data.locked);
				b.setAttribute('aria-pressed', String(selected));
				b.dataset.verdict = value;
				if (selected) { const mark = document.createElement('span'); mark.textContent = value === 'approve' ? '✓ ' : '↩ '; mark.setAttribute('aria-hidden', 'true'); b.prepend(mark); }
			}
			if (verdict?.verdict === 'revise') {
				const label = el('label', 'What should change? (optional)', card);
				const note = el('textarea', '', label); note.value = data.locked ? verdict.reason : notes[item.key] ?? verdict.reason; note.dataset.note = item.key; note.disabled = data.locked;
				note.placeholder = 'Leave blank to request a redo';
				// Typing only keeps the draft in webview state; the note is sent when it changes (blur) and with Submit, so a
				// keystroke writes nothing on the host and redraws no card (fix plan, item 4).
				note.oninput = () => { notes[item.key] = note.value; saveState(details.open); };
				note.onchange = () => send({ version: 1, action: 'decide', item: item.key, verdict: 'revise', reason: note.value });
				if (focused === item.key && selection) { note.focus(); note.setSelectionRange(selection[0], selection[1]); }
			}
		}
		// An item deleted or removed since the review was made takes no verdict; the answer tells the agent (reviews.ts standing).
		// A card state an earlier Studio saved (the reloaded receipt) has no `withdrawn`.
		for (const item of review.withdrawn ?? []) { el('p', `${item.label}: ${item.why === 'deleted' ? 'Deleted by you on the canvas' : 'Removed by you'}`, details).className = 'withdrawn'; }
		if (review.state === 'open' && !review.submitted) {
			const label = el('label', 'Anything else for the agent? (optional)', details); label.className = 'words';
			const field = el('textarea', '', label); field.value = words; field.dataset.note = WORDS; field.disabled = data.locked;
			field.placeholder = 'Not about one item: a rule for the rest of the run, something to skip…';
			field.oninput = () => { words = field.value; saveState(details.open); };
			if (focused === WORDS && selection) { field.focus(); field.setSelectionRange(selection[0], selection[1]); }
		}
		const approved = review.items.filter(i => review.verdicts[i.key]?.verdict === 'approve').length;
		const changes = review.items.filter(i => review.verdicts[i.key]?.verdict === 'revise').length;
		el('p', `${approved} approved · ${changes} changes · ${review.items.length - approved - changes} undecided`, root);
		if (review.state === 'open') {
			if (approved && !review.submitted) { el('p', data.approvalStatement, root); }
			// A continuation being sent is shown in progress, as Chat shows work in progress ("Working...", agentSessionsViewer.ts:604;
			// "Sending to chat...", voiceToolDispatchService.ts:135), never as one to retry (the person's run).
			if (data.continuing) { el('p', 'Sending your decisions to the agent…', root).className = 'progress'; }
			else { button(root, review.submitted ? 'Retry continuation' : 'Submit and continue', submit, !data.ready).className = 'primary'; }
		}
	};
	if (last) { render(last); }
	send({ version: 1, action: 'ready' });
})();
