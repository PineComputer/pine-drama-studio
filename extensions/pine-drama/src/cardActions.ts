// The card actions on the asset grid's cards and the canvas's record panel: what
// each asks the person, then the one choices.json write (core/entryActions.ts). One runner, so the two places never differ.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { runCardAction, type CardRequest, type EntryAsk, type EntryDone } from './core/entryActions';

/** A card action as a page sends it: a request, or an import of a picture dropped on the card (bytes, no path). */
export type CardAction = CardRequest | { readonly action: 'importDropped'; readonly object: string; readonly name: string; readonly bytes: Uint8Array };

/** The runner of card actions for the project at `root`. A cancelled action resolves undefined. */
export function cardActions(context: vscode.ExtensionContext, root: string): (action: CardAction) => Promise<EntryDone | undefined> {
	const ask: EntryAsk = {
		description: (object, current) => vscode.window.showInputBox({ title: `Description of ${object}`, value: current, prompt: 'What the image prompts read.', ignoreFocusOut: true }),
		file: async () => (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import', title: 'Your picture for this asset',
			filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] } }))?.[0]?.fsPath,
	};
	// A dropped picture comes as bytes: written once, by its hash, to the extension's storage, then cloned into imports/.
	const keepDropped = async (name: string, bytes: Uint8Array) => {
		const folder = join(context.globalStorageUri.fsPath, 'uploads', createHash('sha256').update(bytes).digest('hex'));
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, name), bytes);
		return join(folder, name);
	};
	return async action => runCardAction(root, action.action === 'importDropped'
		? { action: 'import', object: action.object, file: await keepDropped(action.name, action.bytes) }
		: action, ask);
}
