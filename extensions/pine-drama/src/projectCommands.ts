import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { updateChoices } from './core/choices';
import { projectAt, ProjectsInsideError } from './core/projectEntry';

export const NEW_PROJECT_COMMAND = 'pineDrama.newProject';
const OPEN_PROJECT_COMMAND = 'pineDrama.openProject';

// Standard native controls; New Project is also a refused message's New Folder….
export function registerProjectCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
	const open = (root: string) => {
		// Consume an empty Welcome window, preserve an existing folder/workspace.
		// Explicit reuse also wins over window.openFoldersInNewWindow; native lookup owns existing destinations.
		const occupied = !!vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile !== undefined;
		return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: occupied, forceReuseWindow: !occupied });
	};
	const failed = (error: unknown) => {
		const detail = (error as Error).message;
		output.appendLine(`project entry: ${detail}`);
		void vscode.window.showErrorMessage(`Pine: ${detail}`);
	};
	// One project inside the chosen folder: offer it; opening it runs Open Project.
	const failedOrInside = async (error: unknown) => {
		if (!(error instanceof ProjectsInsideError && error.projects.length === 1)) { failed(error); return; }
		const inner = error.projects[0];
		output.appendLine(`project entry: ${error.message}`);
		const action = `Open ${basename(inner)}`;
		if (await vscode.window.showInformationMessage(`Pine: ${error.message}`, action) === action) {
			await vscode.commands.executeCommand(OPEN_PROJECT_COMMAND, inner);
		}
	};
	/**
	 * A drama opens as it is, and no check stands in front of the folder; a new one gets its empty choices.json first.
	 */
	const openRoot = async (project: { readonly root: string; readonly initialized: boolean }) => {
		// The empty choices.json makes the folder a drama to the Studio (doc/protocol.md, 3.1).
		if (!project.initialized) {
			await updateChoices(project.root, choices => choices);
		}
		await open(project.root);
	};
	context.subscriptions.push(
		// The folder the person chooses is the project, as Open Folder opens the folder chosen. The
		// native folder picker offers New Folder on macOS (Code-OSS fileDialogService.ts:197 sets createDirectory).
		vscode.commands.registerCommand(NEW_PROJECT_COMMAND, async () => {
			const current = vscode.workspace.workspaceFolders?.[0];
			const picked = (await vscode.window.showOpenDialog({ title: 'New Project', openLabel: 'Create Project', canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
				defaultUri: vscode.Uri.file(current ? dirname(current.uri.fsPath) : homedir()) }))?.[0]?.fsPath;
			if (!picked) { return; }
			try { await openRoot(await projectAt(picked)); }
			catch (error) { await failedOrInside(error); }
		}),
		vscode.commands.registerCommand(OPEN_PROJECT_COMMAND, async (folder?: string) => {
			const picked = folder ?? (await vscode.window.showOpenDialog({ title: 'Open Project', openLabel: 'Open Project', canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0]?.fsPath;
			if (!picked) { return; }
			try { await openRoot(await projectAt(picked)); }
			catch (error) { await failedOrInside(error); }
		}),
	);
}
