// The card actions as the person's changes to the project's files (doc/protocol.md section 3): each lands exactly the
// files it changes as one person change, through the one landing (applyChange.ts applyPersonChange), so the card shows
// it at once and its history keeps what it replaced. "Use" brings a past result back the same way (section 5). Nothing
// runs drama-cli here. No vscode import.

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { applyPersonChange, type ChangeApplied } from './applyChange';
import type { CardRequest } from './galleryProtocol';
import { unusedName } from './placement';
import { ASSET_GROUPS, readObjectFile } from './project';
import { listHistoryOfShownFile, readChangeOfObject, readFileAtCommit } from './projectHistory';
import { DESCRIPTION_FILE, OBJECT_FILE, PROMPT_FILE, RECEIPT_SUFFIX } from './protocol';

/** A card action, by the protocol's object ids (core/galleryProtocol.ts, where the pages read it too). */
export type { CardRequest } from './galleryProtocol';

/** What a card action did: `already` when the files held it already, so nothing changed. */
export interface EntryDone {
	readonly already: boolean;
}

/** What a card action asks the person, in the window; undefined means the person cancelled. */
export interface EntryAsk {
	description(object: string, current: string): PromiseLike<string | undefined>;
	file(): PromiseLike<string | undefined>;
}

/** The line a card shows when nothing changed, so a press that changed nothing never looks lost. */
export function unchangedLine(done: EntryDone | undefined): string | null {
	return done === undefined ? 'Cancelled: nothing was changed.' : done.already ? 'Already so: nothing changed.' : null;
}

/**
 * A new object's folder in `parent`: its name in lower case, spaces and slashes as dashes, letters and digits of any
 * script kept (an object id is a path of the protocol, section 1); a number after it while the name is taken.
 */
function newFolder(root: string, parent: string, name: string, type: string): string {
	const slug = name.normalize('NFC').trim().toLowerCase().replace(/[\s/\\]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/^-+|-+$/g, '') || type;
	return `${parent}/${unusedName(join(root, ...parent.split('/')), slug, n => `${slug}-${n}`)}`;
}

/** What the landing did, as the card says it. */
const done = (applied: ChangeApplied): EntryDone => ({ already: applied === 'already on disk' });
const json = (value: object) => `${JSON.stringify(value, null, '\t')}\n`;

/**
 * Makes `file`, a path in `object`'s folder, its shown file (doc/protocol.md section 3): its object.json, `raw`, names
 * it, and the file it replaces goes with its receipt. Nothing when it is shown already.
 */
function showing(object: string, raw: Record<string, unknown>, file: string): [string, string | null][] {
	const old = typeof raw.shown_file === 'string' ? `${object}/${raw.shown_file}` : null;
	return old === file ? [] : [
		...old ? [[old, null], [`${old}${RECEIPT_SUFFIX}`, null]] as [string, null][] : [],
		[`${object}/${OBJECT_FILE}`, json({ ...raw, shown_file: file.slice(object.length + 1) })],
	];
}

/** Runs one card action on the project at `root`; undefined when the person cancelled. */
export async function runCardAction(root: string, request: CardRequest, ask: EntryAsk): Promise<EntryDone | undefined> {
	// What the change writes is read and named inside the write queue (applyPersonChange), as the folder is then.
	const change = async (message: string, files: () => Promise<Iterable<readonly [string, Buffer | string | null]>>) => done(await applyPersonChange(root, message, files));
	switch (request.action) {
		case 'describe': {
			const text = request.text ?? await ask.description(request.object, request.description);
			return text === undefined ? undefined : change(`Description of ${request.object}`, async () => [[`${request.object}/${DESCRIPTION_FILE}`, text]]);
		}
		case 'prompt':
			return change(`Prompt of ${request.object}`, async () => [[`${request.object}/${PROMPT_FILE}`, request.text]]);
		case 'remove':
			// Its folder goes, with every variant below it (doc/protocol.md 2.2).
			return change(`Removed ${request.object}`, async () => [[request.object, null]]);
		case 'add':
			return change(`Added ${request.name}`, async () => {
				// Where an object of each kind lives (doc/protocol.md 2.2); a variant lives below what it derives from.
				const parent = request.type === 'variant' ? `${request.from}/variants` : ASSET_GROUPS.find(([, , , type]) => type === request.type)![0];
				const id = newFolder(root, parent, request.name, request.type);
				return [
					[`${id}/${OBJECT_FILE}`, json({
						schema: 2, type: request.type, name: request.name, shown_file: null,
						...request.type === 'variant' ? { variant_of: request.from, objects_sent_by_draw_request: [request.from] } : {},
						...request.setting ? { setting: request.setting } : {},
					})],
					[`${id}/${DESCRIPTION_FILE}`, request.text],
				];
			});
		case 'import': {
			const file = request.file ?? await ask.file();
			if (!file) { return undefined; }
			return change(`Your own file for ${request.object}`, async () => {
				// The person's file becomes the shown file, under its name with the person's extension, and has no receipt,
				// since no paid call made it (doc/protocol.md section 3). Its bytes are read before anything is written, so
				// the shown file itself can be the one picked.
				const raw = await readObjectFile(root, request.object);
				const old: string | null = typeof raw.shown_file === 'string' ? raw.shown_file : null;
				const shown = `${request.object}/${old ? old.slice(0, old.length - extname(old).length) : 'picture'}${extname(file).toLowerCase()}`;
				return [[`${shown}${RECEIPT_SUFFIX}`, null], ...showing(request.object, raw, shown), [shown, await readFile(file)]];
			});
		}
		case 'use':
			return change(`Used an earlier result of ${request.object}`, async () => {
				// Every file the result's commit wrote in the object's own folder comes back, and its file is the shown one
				// again with its receipt as it was then, none where it had none (doc/protocol.md section 5); what the commit
				// wrote wins over the lines that show it.
				const result = (await listHistoryOfShownFile(root, request.object)).find(entry => entry.commit === request.commit);
				if (!result) { throw new Error(`${request.commit} is no result of ${request.object}`); }
				const receipt = `${result.file}${RECEIPT_SUFFIX}`;
				return [
					...showing(request.object, await readObjectFile(root, request.object), result.file),
					[receipt, await readFileAtCommit(root, result.commit, receipt)],
					...await readChangeOfObject(root, result.commit, request.object),
				];
			});
	}
}
