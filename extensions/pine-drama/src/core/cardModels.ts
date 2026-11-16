// A card's Model menu: the models the Computer's catalogue offers for what the card is (a picture or a take), what each
// costs, and the commands that make the card again with the one chosen. The commands are drama-cli's own: `make` for
// a picture (short_drama drama_cli/cli.py cmd_make, which runs the command drama-cli names for that object), and for a
// take, which `make` does not cover, `video-prompts --model` then `shoot`. No vscode import.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { takePrice, takesFit, type Catalog } from './catalog';
import type { ModelChoice } from './canvasProtocol';
import type { ProjectObject } from './project';
import { DRAMA_FOLDER, PAID_CALL_LEDGER, PINE_COMPUTER_RECORDS, RECEIPT_SUFFIX } from './protocol';

/** drama-cli's config at the drama's root on the Computer, from the session's working directory. */
const CONFIG = `${DRAMA_FOLDER}/drama-cli.cfg.yaml`;

/** What a take's shown video was made with: its paid call's model and its length and resolution. */
export interface MadeWith {
	readonly model: string;
	readonly seconds: number | null;
	readonly resolution: string | null;
}

/**
 * What `object`'s shown file was made with, from its receipt's paid call (doc/protocol.md 2.3) and that call's ledger in
 * Pine Computer's records (2.4), which the Studio shows and decides nothing from; null with no paid call or record.
 */
export async function madeWith(projectRoot: string, object: ProjectObject): Promise<MadeWith | null> {
	if (!object.shownFile) { return null; }
	try {
		const receipt = JSON.parse(await readFile(join(projectRoot, ...`${object.shownFile}${RECEIPT_SUFFIX}`.split('/')), 'utf8')) as { paid_call_id?: unknown };
		if (typeof receipt.paid_call_id !== 'string' || !/^[\w.-]+$/.test(receipt.paid_call_id)) { return null; }
		const ledger = JSON.parse(await readFile(join(projectRoot, PINE_COMPUTER_RECORDS, ...object.id.split('/'), receipt.paid_call_id, PAID_CALL_LEDGER), 'utf8')) as
			{ provider?: unknown; model?: unknown; params?: { duration?: unknown; resolution?: unknown } };
		if (typeof ledger.provider !== 'string' || typeof ledger.model !== 'string') { return null; }
		return {
			model: `${ledger.provider}:${ledger.model}`,
			seconds: typeof ledger.params?.duration === 'number' ? ledger.params.duration : null,
			resolution: typeof ledger.params?.resolution === 'string' ? ledger.params.resolution : null,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) { return null; }
		throw error;
	}
}

/** The models the catalogue offers for `object`, each with its cost; a take's says which cannot make it at its length. */
export function modelChoices(catalog: Catalog, object: ProjectObject, made: MadeWith | null): ModelChoice[] {
	const take = object.type === 'take';
	return catalog.models.filter(m => m.kind === (take ? 'video' : 'image')).map(m => {
		if (!take) { return { id: m.id, cost: 'included', unfit: null }; }
		if (made?.seconds == null || made.resolution === null) { return { id: m.id, cost: 'priced when shot', unfit: null }; }
		return {
			id: m.id, cost: takePrice(catalog, made.seconds, made.resolution) ?? 'not priced',
			unfit: takesFit(m, made.seconds, made.resolution) ? null : `cannot make ${made.seconds} s at ${made.resolution}`,
		};
	});
}

/** The commands that make `object` again with `model`, in order, each one turn. */
export function remakeCommands(object: ProjectObject, model: string): string[][] {
	if (object.type === 'take') {
		if (!object.episode || !object.segment) { throw new Error(`${object.id} is a take of no episode segment`); }
		return [
			['drama-cli', 'video-prompts', object.episode, object.segment, '--model', model, '--config', CONFIG],
			['drama-cli', 'shoot', object.episode, '--segments', object.segment, '--config', CONFIG],
		];
	}
	return [['drama-cli', 'make', `${DRAMA_FOLDER}/${object.id}`, '--model', model, '--config', CONFIG]];
}
