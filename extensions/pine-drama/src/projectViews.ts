import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { Latest } from './core/latest';
import { PROJECT_VIEW_ID, startOnProduction } from './productionStart';
import { ProjectFinder, PROJECT_FILES } from './core/projectFinder';
import { actionsOf, DramaProject, describeStage, NOTE_ATTACH, NOTE_INTAKE, reviewText, versionHolding, versionRows, type Drama, type OutlineNode, type PreviewsOf, type Role, type SnapshotOf, type TasksOf, type StageDetail, type Version } from './core/project';
import { holdsNoProject } from './core/binding';
import { decomposition, detachedStage, kindRow, lockOf, openSteps, sectionLines } from './core/threeSteps';

// The Production view container, after the practice of the Docker, Kubernetes, GitLens and npm
// extensions: a project seen by what it holds rather than by its files. Project groups a
// drama-cli project's stages; Versions shows the selected stage's versions with their pointers,
// reviews and cost. Native Outline and Timeline keep their own meaning. Read-only.

/** The scheme of a locked row's resourceUri, which the Project view's decoration greys. */
const LOCKED_SCHEME = 'pine-locked';

const ICONS: Partial<Record<Role, string>> = {
	script: 'file-text', bible: 'book', assets: 'checklist', characters: 'organization', character: 'person', look: 'person', scenes: 'globe', location: 'location', view: 'eye',
	props: 'package', prop: 'package', episodes: 'folder-library', episode: 'play-circle', breakdown: 'list-ordered',
	storyboard: 'layout', segment: 'device-camera-video', cut: 'play',
	'script-episode': 'list-ordered', 'script-later': 'list-ordered', voices: 'mic', motion: 'run', note: 'info',
};

/** The roles of the asset rows (roleOf): characters, scenes and props, and their variants. */
const ASSET_ROLES: ReadonlySet<Role> = new Set<Role>(['character', 'look', 'location', 'view', 'prop']);

/** A project file's URI: a path in the project, or an absolute one (a downloaded preview, core/project.ts). */
function fileUri(root: string, path: string): vscode.Uri {
	return vscode.Uri.file(isAbsolute(path) ? path : join(root, ...path.split('/')));
}

/** The file a row opens, and the line to reveal in it: an episode's section of the screenplay. */
export interface RowFile {
	readonly uri: unknown;
	readonly line?: number;
}

/**
 * What a row opens on the person's click or Enter, never on a selection the Studio makes. A row that stands for a file
 * opens it with the editor's own open, as the Explorer does (`file`): 1. Script the screenplay, an episode under it the
 * screenplay at that episode's section (#73), any other stage but an asset its approved version, else its current one.
 * A group with nothing to open has no command, so clicking its label expands it.
 */
export function rowCommand(node: OutlineNode, initialized = true, file?: RowFile): vscode.Command | undefined {
	// An empty Script's next action: the project's main Chat, where the screenplay and brief are attached.
	if (node.id === NOTE_ATTACH || node.id === NOTE_INTAKE) {
		return { command: 'pineDrama.openSessionProject', title: 'Open the project Chat' };
	}
	// In the empty New Project folder only the next action opens something: the galleries and pages register once the
	// project's config exists (extension.ts), so the other rows are labels until then.
	if (!initialized) {
		return undefined;
	}
	if (node.role === 'characters' || node.role === 'scenes' || node.role === 'props') {
		return { command: 'pineDrama.openGallery', title: 'Open', arguments: [node.role] };
	}
	// Every asset row, a base or a variant (its own card, in its asset's frame), selects its card on the assets canvas, as
	// a layer selected in Figma's Layers panel is selected on the canvas; its file stays one context-menu entry away.
	if (node.stagePath && ASSET_ROLES.has(node.role)) {
		return { command: 'pineDrama.openAssetsCanvas', title: 'Open in the assets canvas', arguments: [node.stagePath] };
	}
	// An episode opens its seg editor, its main view; the editor's toggle opens its canvas.
	if (node.role === 'episode') {
		return { command: 'pineDrama.openSegEditor', title: 'Open Seg Editor', arguments: [node] };
	}
	if (!file) {
		return undefined;
	}
	const at = file.line === undefined ? {} : { selection: { start: { line: file.line, character: 0 }, end: { line: file.line, character: 0 } } };
	return { command: 'vscode.open', title: 'Open', arguments: [file.uri, { preview: true, ...at }] };
}

class ProjectProvider implements vscode.TreeDataProvider<OutlineNode> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	/** Each node's parent, as the tree handed it out or as `locate` walked it; `reveal` asks for it. */
	private readonly parents = new Map<string, OutlineNode | undefined>();
	/** Undefined while the window's folder holds no project: the view is empty and shows its welcome. */
	project: DramaProject | undefined;
	/** The screenplay's section lines, by the drama read they belong to (fileOf). */
	private readonly sections = new WeakMap<Drama, Promise<number[]>>();
	/**
	 * The window's folders, for the empty folder New Project opened, which awaits its first request
	 * (core/projectEntry.ts): the three steps show there too.
	 */
	folders: () => readonly string[] = () => [];
	/** Draws the rows again, as the Live Preview poll does every few seconds; the drama is not read again for it. */
	refresh(): void {
		this.changed.fire();
	}

	/** The project's files changed, or the person asked: the drama is read again. */
	invalidate(): void {
		this.project?.forget();
		this.changed.fire();
	}

	/** The project the tree shows: the window's, else a new project's folder that holds no project yet, else none (the welcome shows). */
	shown(): DramaProject | undefined {
		if (this.project) { return this.project; }
		const [folder, ...more] = this.folders();
		try { return folder && !more.length && holdsNoProject(folder) ? new DramaProject(folder, undefined, true) : undefined; }
		catch { return undefined; }
	}

	async getChildren(node?: OutlineNode): Promise<OutlineNode[]> {
		if (node && await this.lock(node.id)) { return []; }
		const shown = this.shown();
		const children: OutlineNode[] = shown ? await shown.children(node) : [];
		for (const child of children) { this.parents.set(child.id, node); }
		return children;
	}

	getParent(node: OutlineNode): OutlineNode | undefined {
		return this.parents.get(node.id);
	}

	/** The deepest node that holds `path`, with its ancestors remembered for `getParent`. */
	async locate(path: string): Promise<OutlineNode | undefined> {
		if (!this.project) {
			return undefined;
		}
		const chain = await this.project.locate(path);
		chain.forEach((node, i) => this.parents.set(node.id, chain[i - 1]));
		return chain.at(-1);
	}

	/**
	 * The file a row opens: an episode under 1. Script the screenplay at its section (the Nth top-level section is the
	 * Nth episode, else the top), any other stage its approved version, else its current one, else its first.
	 */
	async fileOf(node: OutlineNode): Promise<RowFile | undefined> {
		const project = this.project!;
		const drama = await project.drama();
		const path = await this.stageOf(node);
		const detail = path ? await project.detail(path) : undefined;
		const name = detail && (detail.pointers.accepted ?? detail.pointers.current);
		const rel = detail && (detail.versions.find(v => v.name === name) ?? detail.versions[0])?.file;
		if (!rel) { return undefined; }
		const uri = fileUri(project.root, rel);
		if (!node.episode) { return { uri }; }
		// One read per drama read (DramaProject.drama: until the folder changes), not one per row and redraw.
		let sections = this.sections.get(drama);
		if (!sections) {
			sections = readFile(uri.fsPath, 'utf8').then(sectionLines, () => []);
			this.sections.set(drama, sections);
		}
		const episodes = [...drama.objects.values()].filter(o => o.type === 'episode').map(o => o.id).sort();
		return { uri, line: (await sections)[episodes.indexOf(node.episode)] ?? 0 };
	}

	/** The stage a row stands for: an episode under 1. Script the screenplay, any other row its own. */
	async stageOf(node: OutlineNode): Promise<string | undefined> {
		return node.episode ? [...(await this.project!.drama()).objects.values()].find(o => o.type === 'screenplay')?.id : node.stagePath;
	}

	/** The row's lock, when it is a step not reached or a feature not built (threeSteps.ts `lockOf`). */
	private async lock(id: string) {
		const shown = this.shown();
		return lockOf(id, shown ? openSteps(await shown.drama()) : { assets: false, episodes: false });
	}

	async getTreeItem(node: OutlineNode): Promise<vscode.TreeItem> {
		const lock = await this.lock(node.id);
		if (lock) {
			// TreeItem has no disabled state: no children, no command, a lock, and the label greyed by a file decoration
			// (LOCKED_SCHEME, below; Code-OSS treeView.ts:1436-1449 at 0959cbd8 colours a custom tree item's label by its
			// resourceUri's decoration, as git greys an ignored file).
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.iconPath = new vscode.ThemeIcon('lock');
			item.resourceUri = vscode.Uri.from({ scheme: LOCKED_SCHEME, path: `/${node.id}` });
			item.description = lock.description;
			item.tooltip = lock.tooltip;
			return item;
		}
		const item = new vscode.TreeItem(node.label, node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		item.id = node.id;
		item.iconPath = new vscode.ThemeIcon(ICONS[node.role] ?? 'circle-small');
		// A group's role lets a menu target it, e.g. "Open Canvas" on an episode.
		item.contextValue = node.kind === 'group' ? `group ${node.role}` : node.kind;
		if (node.stagePath && this.project) {
			const detail = await this.project.detail(node.stagePath);
			// Reveal in Files and Copy Path follow the object's actions (project.ts actionsOf): no version, no folder.
			const object = (await this.project.drama()).objects.get(node.stagePath);
			item.contextValue = object && actionsOf(object).reveal ? 'stage revealable' : 'stage';
			item.description = describeStage(detail);
			item.tooltip = `${node.stagePath}\n${item.description}`;
		}
		if (node.role === 'script-episode') {
			// No breakdown at all, not even one in review: Start Episode opens a session to make it (B8).
			item.contextValue = `${item.contextValue} startable`;
		}
		if (node.role === 'script') {
			// Open Bible: the bible has no row of its own; its file is one click from Script.
			item.contextValue = `${item.contextValue} scriptStep`;
		}
		if (node.episode && this.project) {
			// A Script episode: its decomposition.
			const drama = await this.project.drama();
			const state = decomposition(node.stagePath ? drama.objects.get(node.stagePath) : undefined);
			item.description = state.text;
			item.tooltip = `${node.label}\n\n${state.text}`;
			if (state.decomposed) { item.contextValue = `${item.contextValue} decomposed`; }
		} else if ((node.role === 'characters' || node.role === 'scenes' || node.role === 'props') && this.project) {
			// Its count (threeSteps.ts kindRow).
			Object.assign(item, kindRow(node.role, await this.project.drama()));
		} else if (node.description || node.tooltip) {
			item.description = node.description ?? item.description;
			item.tooltip = node.tooltip ?? item.tooltip;
		}
		if (node.role === 'note') {
			item.tooltip = node.label;
		}
		item.command = rowCommand(node, !!this.project, this.project && await this.fileOf(node));
		return item;
	}
}

type TimelineEntry =
	| { kind: 'version'; version: Version; detail: StageDetail; parts: readonly Version[]; parent?: string }
	| { kind: 'review'; text: string; tooltip: string }
	| { kind: 'note'; text: string };

class TimelineProvider implements vscode.TreeDataProvider<TimelineEntry> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private selection: { detail: StageDetail } | undefined;
	/** The project the selection is of; undefined while the folder holds none (the selection is then cleared). */
	project: DramaProject | undefined;

	show(detail: StageDetail): void {
		this.selection = { detail };
		this.changed.fire();
	}

	clear(): void {
		this.selection = undefined;
		this.changed.fire();
	}

	/** The row of the shown stage's version `name`, for `reveal`: its own, or a part's under the one it continues into. */
	entryOf(name: string): TimelineEntry | undefined {
		const detail = this.selection?.detail;
		const row = detail && versionRows(detail).find(r => r.version.name === name);
		// A part folded under more than one entry (two versions continue it) is revealed under the newest.
		const under = detail && !row ? versionRows(detail).find(r => r.parts.some(p => p.name === name)) : undefined;
		return row ? { kind: 'version', ...row, detail: detail! }
			: under ? { kind: 'version', version: under.parts.find(p => p.name === name)!, parts: [], detail: detail!, parent: under.version.name } : undefined;
	}

	/** `reveal` needs it (vscode.d.ts, TreeView.reveal): a part's parent is the entry it was listed under. */
	getParent(entry: TimelineEntry): TimelineEntry | undefined {
		const detail = this.selection?.detail;
		const row = entry.kind === 'version' && entry.parent && detail ? versionRows(detail).find(r => r.version.name === entry.parent) : undefined;
		return row && { kind: 'version', ...row, detail: detail! };
	}

	getChildren(entry?: TimelineEntry): TimelineEntry[] {
		if (!this.selection) {
			return [];
		}
		if (!entry) {
			return versionRows(this.selection.detail).map(row => ({ kind: 'version', ...row, detail: this.selection!.detail }));
		}
		if (entry.kind !== 'version') {
			return [];
		}
		// A version written in parts holds its earlier parts, each its own version (doc/protocol.md 2.1, `continues`).
		const out: TimelineEntry[] = [...entry.parts.map(version => ({ kind: 'version' as const, version, parts: [], detail: entry.detail, parent: entry.version.name })),
			...entry.version.reviews.map(r => ({ kind: 'review' as const, ...reviewText(r, shortDate(r.acceptedAt)) }))];
		if (entry.version.discarded) {
			out.push({ kind: 'note', text: 'Deleted by you' });
		}
		return out;
	}

	getTreeItem(entry: TimelineEntry): vscode.TreeItem {
		if (entry.kind === 'version') {
			const { version, detail } = entry;
			const tags = [
				detail.pointers.accepted === version.name ? 'accepted' : '',
				detail.pointers.current === version.name ? 'working' : '',
				version.own ? 'your import' : '',
			].filter(Boolean);
			const item = new vscode.TreeItem(version.name, entry.parts.length ? vscode.TreeItemCollapsibleState.Collapsed
				: version.reviews.length || version.discarded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
			const written = entry.parts.length ? `written in ${entry.parts.length + 1} parts` : '';
			item.description = [[...tags, written].filter(Boolean).join(' · '), shortDate(version.createdAt)].filter(Boolean).join('  ');
			item.iconPath = new vscode.ThemeIcon(tags.includes('accepted') ? 'pass-filled' : 'circle-small');
			item.tooltip = version.path;
			if (version.file && this.project) {
				item.command = { command: 'vscode.open', title: 'Open', arguments: [fileUri(this.project.root, version.file), { preview: true }] };
			}
			return item;
		}
		if (entry.kind === 'review') {
			const item = new vscode.TreeItem(entry.text);
			item.tooltip = entry.tooltip;
			item.iconPath = new vscode.ThemeIcon('comment');
			return item;
		}
		const item = new vscode.TreeItem(entry.text);
		item.iconPath = new vscode.ThemeIcon('warning');
		return item;
	}
}

function shortDate(iso?: string): string {
	return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

/** A stage to show in Versions: its path, and the label for the title. */
export interface StageRef {
	readonly stagePath: string;
	readonly label: string;
}

/**
 * What an active webview tab shows (sections 4 and 7): the tree node it maps to, and what Versions
 * shows: that node's stage, nothing (a collection, a canvas with no card picked), or the card picked on a canvas.
 */
export interface Subject {
	readonly path: string;
	readonly versions: 'node' | 'none' | StageRef;
}

/** What the Production views offer the rest of the extension. */
export interface ProjectViews {
	readonly project: DramaProject;
	/** Shows a stage in Versions; the person picked it, so it wins over a lookup still running. */
	readonly inspect: (stagePath: string, label: string) => Promise<unknown>;
	/** Adds what a kind of webview panel shows while one of its panels is active. */
	readonly follow: (source: () => Subject | undefined) => void;
	/** The active tab may have changed: select its item in the tree, and its stage in Versions. */
	readonly followActive: () => void;
	/** The Project view's selected node. */
	readonly selection: () => OutlineNode | undefined;
	/** Says where the project's files come from, in the view's description. */
	readonly setOrigin: (text: string) => void;
	/** The project's files changed (a stop was settled): read them again. */
	readonly refresh: () => void;
}

/**
 * Registers the Production views, once, for the first workspace folder that holds a drama-cli project: the folder, or
 * its drama/. A project that arrives after activation, as a session's first stop writes the folder's
 * drama/, is shown without a reload, and one whose config file goes is no longer shown (core/projectFinder.ts;
 * Step 5). The tree views are created once; only their providers' project changes.
 * `opened` is told the views when the window's project first appears.
 */
export async function registerProjectViews(context: vscode.ExtensionContext, output: vscode.OutputChannel, opened: (views: ProjectViews) => void,
	snapshots: (root: string) => SnapshotOf = () => () => [], downloaded: (root: string) => PreviewsOf = () => () => [],
	tasks: (root: string) => TasksOf | undefined = () => undefined): Promise<ProjectFinder> {
	const projectTree = new ProjectProvider();
	const versions = new TimelineProvider();
	projectTree.folders = () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
	const projectView = vscode.window.createTreeView(PROJECT_VIEW_ID, { treeDataProvider: projectTree, showCollapseAll: true });
	context.subscriptions.push(vscode.window.registerFileDecorationProvider({
		provideFileDecoration: uri => uri.scheme === LOCKED_SCHEME ? new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('disabledForeground')) : undefined,
	}));
	const versionsView = vscode.window.createTreeView('pine.versions', { treeDataProvider: versions });
	const selected = () => projectView.selection[0];
	/** The project the views show now; the commands act on it. */
	const current = (): DramaProject => {
		if (!projectTree.project) {
			throw new Error('No drama is open: this folder has no choices.json.');
		}
		return projectTree.project;
	};
	const uri = (path: string) => fileUri(current().root, path);
	const latest = new Latest();
	// Shows a stage in Versions without opening anything, unless a newer request came first.
	const show = async (stage: StageRef, latestOnly: () => boolean) => {
		const detail = await current().detail(stage.stagePath);
		if (latestOnly()) {
			versions.show(detail);
			await vscode.commands.executeCommand('setContext', 'pineDrama.versionsShown', true);
			versionsView.title = `Versions · ${stage.label}`;
			versionsView.description = describeStage(detail);
		}
		return detail;
	};
	const inspect = (stagePath: string, label: string) => show({ stagePath, label }, latest.next());
	const clearVersions = async () => {
		versions.clear();
		await vscode.commands.executeCommand('setContext', 'pineDrama.versionsShown', false);
		versionsView.title = 'Versions';
		versionsView.description = undefined;
	};

	// The tree follows the active tab, as the Explorer follows the active file.
	const sources: (() => Subject | undefined)[] = [];
	const activeSubject = (): Subject | undefined => {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		if (input instanceof vscode.TabInputWebview) {
			for (const source of sources) {
				const subject = source();
				if (subject) {
					return subject;
				}
			}
			return undefined;
		}
		const file = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri
			: input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
		const root = projectTree.project?.root;
		const rel = root && file?.scheme === 'file' ? relative(root, file.fsPath) : undefined;
		return rel && !rel.startsWith('..') && !isAbsolute(rel) ? { path: rel.split(sep).join('/'), versions: 'node' } : undefined;
	};
	const followActive = async () => {
		// Leaving a tab ends the lookups started for it, even when the new tab names no project item.
		const current = latest.next();
		const subject = activeSubject();
		if (!subject) {
			return; // Not a project item (Settings, a file elsewhere): the tree stays as it is, as the Explorer's does.
		}
		// The bible has no row, but its tab still shows its versions: Versions follows it with no
		// tree selection.
		const node = await projectTree.locate(subject.path) ?? (subject.versions === 'node' && projectTree.project ? detachedStage(await projectTree.project.drama(), subject.path) : undefined);
		if (!current() || !node) {
			return;
		}
		const stage = subject.versions === 'node' ? (node.stagePath ? { stagePath: node.stagePath, label: node.label } : undefined)
			: subject.versions === 'none' ? undefined : subject.versions;
		if (stage) {
			const detail = await show(stage, current);
			// The file's own version, as the Explorer selects the active file; only while the
			// view is visible, for reveal would otherwise open the side bar, and not again when that row is already selected.
			const held = subject.versions === 'node' ? versionHolding(detail.versions, subject.path) : undefined;
			const row = held && versions.entryOf(held.name);
			const chosen = versionsView.selection[0];
			const already = chosen?.kind === 'version' && chosen.version.name === held?.name;
			if (current() && row && versionsView.visible && !already) {
				await versionsView.reveal(row, { select: true, focus: false });
			}
		} else {
			await clearVersions();
		}
		// Only while the view is visible: reveal would otherwise open the side bar (vscode.d.ts, TreeView.reveal).
		if (current() && !('detached' in node) && projectView.visible && projectView.selection[0]?.id !== node.id) {
			await projectView.reveal(node, { select: true, focus: false });
		}
	};
	const follow = () => void followActive().catch(error => output.appendLine(`project: following the active tab: ${(error as Error).message}`));

	context.subscriptions.push(
		projectView,
		versionsView,
		// Versions shows the row the person selects, as it did when a row's click inspected it; a row with no file too.
		projectView.onDidChangeSelection(async ({ selection: [node] }) => {
			const path = node && await projectTree.stageOf(node);
			if (path) { await inspect(path, node.episode ? '1. Script' : node.label).catch(error => output.appendLine(`project: ${(error as Error).message}`)); }
		}),
		vscode.commands.registerCommand('pineDrama.refreshProject', () => projectTree.invalidate()),
		// The same episode under Episodes, where it is produced (section 11a: one id, two steps).
		vscode.commands.registerCommand('pineDrama.goToEpisode', async (node?: OutlineNode) => {
			const ep = node?.episode;
			const found = ep && await projectTree.locate(ep);
			if (found) { await projectView.reveal(found, { select: true, focus: true, expand: true }); }
			else if (ep) { void vscode.window.showInformationMessage(`Pine: ${ep} has nothing under Episodes yet.`); }
		}),
		// The bible has no row of its own; Script's menu opens its file as a row would.
		vscode.commands.registerCommand('pineDrama.openBible', async () => {
			const bible = [...(await current().drama()).objects.values()].find(o => o.type === 'bible');
			const file = bible && await projectTree.fileOf({ id: bible.id, label: 'Bible', kind: 'stage', role: 'bible', stagePath: bible.id, hasChildren: false });
			if (file) { await vscode.commands.executeCommand('vscode.open', file.uri, { preview: true }); }
		}),
		vscode.commands.registerCommand('pineDrama.revealInFiles', (node?: OutlineNode) => {
			const target = node ?? selected();
			return target?.stagePath && vscode.commands.executeCommand('revealInExplorer', uri(target.stagePath));
		}),
		vscode.commands.registerCommand('pineDrama.copyPath', (node?: OutlineNode) => {
			const target = node ?? selected();
			return target?.stagePath && vscode.env.clipboard.writeText(target.stagePath);
		}),
		vscode.window.tabGroups.onDidChangeTabs(follow),
		vscode.window.tabGroups.onDidChangeTabGroups(follow),
		projectView.onDidChangeVisibility(({ visible }) => visible && follow()),
		// Versions shown again after the active file changed under it: its selection is of the file it was last visible for.
		versionsView.onDidChangeVisibility(({ visible }) => visible && follow()),
	);
	/** The window's project: the first one found, kept for the window, because the pages opened from it read its files. */
	let first: ProjectViews | undefined;
	const finder = new ProjectFinder(
		() => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
		async root => {
			if (root && first && root !== first.project.root) {
				// A choices.json made at the folder's top after its drama/ arrived: rootIn now prefers the folder.
				output.appendLine(`project: ${root} is now this folder's drama project; this window shows ${first.project.root} until it is reloaded`);
				// Not awaited: a scan waiting on the person would hold back every later scan.
				void vscode.window.showWarningMessage(`Pine: ${root} is now this folder's drama project. Production shows ${first.project.root} until you reload the window.`, 'Reload Window')
					.then(reload => reload && vscode.commands.executeCommand('workbench.action.reloadWindow'));
				return;
			}
			const project = root ? first?.project ?? new DramaProject(root, snapshots(root), false, downloaded(root), tasks(root)) : undefined;
			projectTree.project = project;
			versions.project = project;
			await vscode.commands.executeCommand('setContext', 'pineDrama.projectOpen', !!project);
			if (!project) {
				output.appendLine(`project: ${first?.project.root} is no longer a drama (its choices.json is gone)`);
				latest.next();
				await clearVersions();
				projectTree.refresh();
				return;
			}
			if (first) {
				output.appendLine(`project: ${project.root} is a drama-cli project again`);
				first.refresh();
				return;
			}
			output.appendLine(`project: ${project.root}`);
			first = {
				project, inspect, follow: source => void sources.push(source), followActive: follow, selection: selected,
				setOrigin: text => { projectView.description = text; },
				refresh: () => { projectTree.invalidate(); follow(); },
			};
			projectTree.refresh();
			opened(first);
			void startOnProduction(projectView, (command, options) => vscode.commands.executeCommand(command, options))
				.catch(error => output.appendLine(`project: showing Production: ${(error as Error).message}`));
			follow();
		},
		error => output.appendLine(`project: looking for this folder's drama-cli project: ${error.message}`),
	);
	// Each folder's watcher sees only the files that can make or end a project, as git's sees only .git paths.
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme === 'file') {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, PROJECT_FILES));
			context.subscriptions.push(watcher, watcher.onDidCreate(() => finder.possibleChange()), watcher.onDidDelete(() => finder.possibleChange()));
		}
	}
	context.subscriptions.push(finder);
	await vscode.commands.executeCommand('setContext', 'pineDrama.projectOpen', false);
	if (!await finder.scan()) {
		output.appendLine('project: no workspace folder is a drama yet (no choices.json); watching for one');
	}
	return finder;
}

