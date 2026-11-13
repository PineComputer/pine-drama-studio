// Native account controls; the domain's connection policy is in core/pineConnection.ts.
import * as vscode from 'vscode';
import { Client } from '@pinesandbox/computer';
import { connectKey, keyProblem, PINE_KEY_SECRET } from './core/pineConnection';
import { keyPrefix, type PineConfig } from './pineConfig';
import type { SecretVault } from './core/pinePort';

export const CONNECTION_COMMAND = 'pineDrama.connection';

export function registerPineConnection(context: vscode.ExtensionContext, config: PineConfig, vault: SecretVault, log: (line: string) => void, changed: () => void, current: () => boolean, disconnectProblem: () => string | undefined): void {
	let busy = false;
	context.subscriptions.push(vscode.commands.registerCommand(CONNECTION_COMMAND, async () => {
		if (busy) { return; }
		busy = true;
		try {
			if (!current()) {
				const action = await vscode.window.showWarningMessage('The Pine connection changed. Reload this window to continue.', 'Reload Window');
				if (action) { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
				return;
			}
			if (config.kind !== 'disconnected' && !(config.kind === 'set' && config.saved)) {
				await vscode.window.showInformationMessage('Pine Computer uses the connection file selected by the development launcher. No endpoint or key can be changed here.');
				return;
			}
			if (config.kind === 'set') {
				const action = await vscode.window.showInformationMessage(`Pine Computer · key ${keyPrefix(config.pine.apiKey)}`, { modal: true, detail: 'Your key is saved on this device. Disconnect keeps your files and history, and does not revoke the key at Pine. Stop any running Computers before disconnecting.' }, 'Disconnect');
				if (action !== 'Disconnect') { return; }
				const problem = disconnectProblem();
				if (problem) { await vscode.window.showWarningMessage(problem); return; }
				try { await vault.delete(PINE_KEY_SECRET); } catch {
					throw new Error('Could not remove the Pine key from the system credential store. The connection has not been confirmed as disconnected.');
				}
			} else {
				const key = await vscode.window.showInputBox({ title: 'Connect to Pine Computer', prompt: 'Paste your Pine project key. Connecting checks access without starting a Computer or generating content.', password: true, ignoreFocusOut: true, placeHolder: 'pk_…', validateInput: keyProblem });
				if (key === undefined) { return; }
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Pine project access…' }, () => connectKey(vault, key, pine => new Client(pine).projectPolicy({ signal: AbortSignal.timeout(15_000) })));
			}
			changed();
			log('Pine connection credentials changed; reload required.');
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		} catch (error) {
			// Errors from the check and credential store have already been replaced with secret-free text.
			const text = error instanceof Error ? error.message : 'The Pine connection could not be updated.';
			log(`Pine connection: ${text}`);
			await vscode.window.showErrorMessage(text);
		} finally { busy = false; }
	}));
	// No notification at startup: it covered the bottom of the Chat message box until closed. Code-OSS shows a needed
	// sign-in as a badge on Accounts, not as a notification (authenticationExtensionsService.ts, NumberBadge "Sign in
	// requested"); here the status bar's "Pine · not connected" opens this command, Accounts → Pine Computer… does too, and
	// a send says how to connect (pineConfig.ts, notSetUpText).
}
