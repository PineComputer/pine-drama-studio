import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { commitPathsToHistory, runInProjectWriteQueue } from './core/projectHistory';
import { writeProjectMarker } from './core/project';
import { PROJECT_MARKER_FILE } from './core/protocol';
import { projectAt, ProjectOfAnotherMajorError, ProjectsInsideError } from './core/projectEntry';
import { convertMajor1ProjectToMajor2, LAST_MAJOR_1_STUDIO } from './core/convertMajor1ProjectToMajor2';
import { RefusedWithUpgradeInstructions } from './core/protocol';

export const NEW_PROJECT_COMMAND = 'pineDrama.newProject';
export const CONVERT_MAJOR_1_PROJECT_COMMAND = 'pineDrama.convertMajor1Project';
const OPEN_PROJECT_COMMAND = 'pineDrama.openProject';

// Standard native controls; New Project is also a refused message's New Folder….
/** `heldRoot`: the folder whose project window lock this window holds (core/projectWindowLock.ts), by its real path. */
export function registerProjectCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel, heldRoot: string | undefined): void {
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
	/** A refusal for another major (core/protocol.ts, refuseWithUpgradeInstructions), with its download when it names one. */
	const showRefusal = async (error: RefusedWithUpgradeInstructions) => {
		output.appendLine(`project entry: ${error.message}`);
		if (await vscode.window.showWarningMessage(`Pine: ${error.message}`, ...error.downloadLabel ? [error.downloadLabel] : [])) { await vscode.env.openExternal(vscode.Uri.parse(error.downloadUrl!)); }
	};
	// One project inside the chosen folder: offer it; opening it runs Open Project. A major-1 drama opens as its folder,
	// whose Project view offers its conversion there, under that window's project lock (core/projectWindowLock.ts).
	const failedOrInside = async (error: unknown) => {
		if (error instanceof ProjectOfAnotherMajorError) { await open(error.folder); return; }
		if (error instanceof RefusedWithUpgradeInstructions) { await showRefusal(error); return; }
		if (!(error instanceof ProjectsInsideError && error.projects.length === 1)) { failed(error); return; }
		const inner = error.projects[0];
		output.appendLine(`project entry: ${error.message}`);
		const action = `Open ${basename(inner)}`;
		if (await vscode.window.showInformationMessage(`Pine: ${error.message}`, action) === action) {
			await vscode.commands.executeCommand(OPEN_PROJECT_COMMAND, inner);
		}
	};
	/**
	 * A drama opens as it is, and no check stands in front of the folder; a new one gets its pine-drama-project.json first, the
	 * person's first commit.
	 */
	const openRoot = async (project: { readonly root: string; readonly initialized: boolean }) => {
		// pine-drama-project.json makes the folder a drama to the Studio (doc/protocol.md 2.1).
		if (!project.initialized) {
			await runInProjectWriteQueue(project.root, async () => {
				await writeProjectMarker(project.root);
				await commitPathsToHistory(project.root, 'person', [PROJECT_MARKER_FILE], 'New project');
			});
		}
		await open(project.root);
	};
	/**
	 * The one way into the conversion of a major-1 drama (core/convertMajor1ProjectToMajor2.ts): the folder whose project
	 * window lock this window holds, by the real path it locked, so no other window writes there meanwhile. The person says yes to what it
	 * does first, it runs with its progress shown, and a refusal names the Studio to use, with its download. Once it is
	 * done, the folder's project marker opens the project in this window (projectViews.ts, the finder's watcher).
	 */
	const convert = async (): Promise<void> => {
		if (!heldRoot) { return; }
		const root = heldRoot;
		const today = new Date().toISOString().slice(0, 10);
		const go = 'Back Up and Convert';
		const asked = await vscode.window.showWarningMessage(`${basename(root)} was made by Pine Drama Studio ${LAST_MAJOR_1_STUDIO.version} or earlier. To open it here, the Studio converts it to its own format.`,
			{ modal: true, detail: `First the folder is copied beside itself as ${basename(root)}.backup-${today}, which Studio ${LAST_MAJOR_1_STUDIO.version} still opens. Then every version is kept in the project's history, and each card shows the version it showed before. This can take a few minutes for a large project.` }, go);
		if (asked !== go) { return; }
		try {
			const backup = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converting ${basename(root)}…` },
				() => convertMajor1ProjectToMajor2(root, context.globalStorageUri.fsPath, today));
			output.appendLine(`conversion: ${root} is major 2; its backup is ${backup}`);
			void vscode.window.showInformationMessage(`Pine: ${basename(root)} is converted. The folder as it was is kept as ${basename(backup)}.`);
		} catch (error) {
			if (error instanceof RefusedWithUpgradeInstructions) { await showRefusal(error); } else { failed(error); }
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand(CONVERT_MAJOR_1_PROJECT_COMMAND, convert),
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
