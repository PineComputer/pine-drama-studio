// The card actions as the person's choices (doc/protocol.md, section 3): each
// rewrites `choices.json` at once, so the card shows it at once and it survives a crash; the scope's next task carries it
// to the Computer. Nothing runs drama-cli here. No vscode import.

import { randomUUID } from 'node:crypto';
import { copyImport, updateChoices, withObject } from './choices';
import type { Add, Choices } from './protocol';
import type { CardRequest } from './galleryProtocol';

/** What Use as main records as the person's words: their own act of choosing the version, as they gave it. */
export const USE_AS_MAIN = 'Approve';

/** A card action, by the protocol's object ids (core/galleryProtocol.ts, where the pages read it too). */
export type { CardRequest } from './galleryProtocol';

/** What a card action did: `already` when the choices already said so, so nothing changed. */
export interface EntryDone {
	readonly already: boolean;
}

/** What a card action asks the person, in the window; undefined or false means the person cancelled. */
export interface EntryAsk {
	description(object: string, current: string): PromiseLike<string | undefined>;
	file(): PromiseLike<string | undefined>;
	/** A yes or no before an action the person may not have meant, as the Explorer asks before a delete (explorer.confirmDelete). */
	confirm(question: string, detail: string): PromiseLike<boolean>;
}

/** The line a card shows when nothing changed, so a press that changed nothing never looks lost. */
export function unchangedLine(done: EntryDone | undefined): string | null {
	return done === undefined ? 'Cancelled: nothing was changed.' : done.already ? 'Already so: nothing changed.' : null;
}

const clientId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, '')}`;

/** Runs one card action on the folder `root`'s choices; undefined when the person cancelled. */
export async function runCardAction(root: string, request: CardRequest, ask: EntryAsk): Promise<EntryDone | undefined> {
	let already = false;
	const change = (edit: (c: Choices) => Choices) => updateChoices(root, c => {
		const next = edit(c);
		already = JSON.stringify(next) === JSON.stringify(c);
		return next;
	});
	switch (request.action) {
		case 'choose':
			await change(c => withObject(c, request.object, e => e.chosen?.version === request.version ? e : { ...e, chosen: { version: request.version, words: USE_AS_MAIN } }));
			break;
		case 'discard':
			if (!await ask.confirm(`Delete ${request.version} of ${request.object}?`, 'It leaves the strip; its files stay in the folder.')) { return undefined; }
			await change(c => withObject(c, request.object, e => e.discarded?.includes(request.version) ? e : { ...e, discarded: [...(e.discarded ?? []), request.version] }));
			break;
		case 'describe': {
			const text = request.text ?? await ask.description(request.object, request.description);
			if (text === undefined) { return undefined; }
			await change(c => withObject(c, request.object, e => e.description === text ? e : { ...e, description: text }));
			break;
		}
		case 'prompt':
			await change(c => withObject(c, request.object, e => e.prompt === request.text ? e : { ...e, prompt: request.text }));
			break;
		case 'remove':
			await change(c => withObject(c, request.object, e => e.removed ? e : { ...e, removed: true }));
			break;
		case 'add': {
			const add: Add = { id: clientId('add'), type: request.type, name: request.name, description: request.text,
				...(request.from ? { from: request.from } : {}), ...(request.setting ? { setting: request.setting } : {}) };
			await change(c => ({ ...c, added: [...c.added, add] }));
			break;
		}
		case 'editAdd':
			await change(c => ({ ...c, added: c.added.map(a => a.id === request.id ? { ...a, name: request.name, description: request.text } : a) }));
			break;
		case 'removeAdd':
			await change(c => ({ ...c, added: c.added.filter(a => a.id !== request.id) }));
			break;
		case 'import': {
			const file = request.file ?? await ask.file();
			if (!file) { return undefined; }
			const id = clientId('imp');
			const rel = await copyImport(root, file, id);
			await change(c => withObject({ ...c, imports: [...c.imports, { id, object: request.object, file: rel }] }, request.object,
				e => ({ ...e, chosen: { import: id } })));
			break;
		}
	}
	return { already };
}
