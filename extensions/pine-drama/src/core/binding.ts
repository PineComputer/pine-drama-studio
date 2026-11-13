// One explicit project root; no child-layout discovery or migration. No vscode import.

import { CHOICES_FILE } from './choices';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectIdentity, projectRootOf } from './projectPlace';
import { CLIENT_FOLDERS, clientFileList, transportedTree } from './taskRun';

export type Entry =
	/** An explicit send may adopt this initialized root only after local CLI validation. */
	| { readonly kind: 'adopt'; readonly folder: string }
	/** The session is bound to this folder already, or is new and will be bound on this message (`note`, said once). */
	| { readonly kind: 'go'; readonly bind: boolean; readonly note?: string }
	/** Associated history exists but the project has no Project Chat: nothing was admitted to work in it. */
	| { readonly kind: 'unassigned' }
	/** This session's drama is in another folder. */
	| { readonly kind: 'elsewhere'; readonly folder: string }
	/** This session's bound folder is missing, or its real path changed. */
	| { readonly kind: 'moved'; readonly folder: string }
	/** The folder holds a drama-cli project below its root (`project`): it is that project's, and nothing is written into it. */
	| { readonly kind: 'inside'; readonly folder: string; readonly project: string };

interface Conv {
	readonly key: string;
	readonly label: string;
	readonly folder: string | null;
	readonly project_role?: 'main' | null;
}

/** What makes a folder a drama: choices.json at its root (core/project.ts, DramaProject.isProject). */
const CONFIG = CHOICES_FILE;

/**
 * The dramas below `folder`, by their roots: every folder a task would carry (transportedTree) that is a drama as Open
 * Project tells one (DramaProject.isProject: a choices.json that is a file, a linked one too), so its files would be
 * swept into this one's upload and get a second writer.
 */
export function projectsBelow(folder: string): string[] {
	return transportedTree(folder).folders.filter(dir => statSync(join(dir, CONFIG), { throwIfNoEntry: false })?.isFile()).map(projectIdentity).sort();
}

/**
 * New Project, Open Project and the first send share this one rule: a folder that holds no drama, at its root or
 * below, is used as a new project, whatever else it holds. An entry named like
 * choices.json at the root that is not a file (a folder, say) is not one either.
 */
export function holdsNoProject(folder: string): boolean { return !existsSync(join(folder, CONFIG)) && !projectsBelow(folder).length; }

/** The first send's one note: where results arrive, and what of the folder goes with each task: its client files alone
 * (taskRun.ts, CLIENT_FOLDERS; doc/protocol.md, 3.3 and 4.2). */
function bindingNote(root: string): string {
	const files = clientFileList(root).map(f => ({ rel: f.rel, bytes: statSync(f.path).size }));
	const said = `This project's root is \`${root}\`. The Pine Computer's returned results are published here.`;
	if (!files.length) { return said; }
	const mb = files.reduce((sum, f) => sum + f.bytes, 0) / 1e6; // decimal megabytes
	const one = files.length === 1;
	return `${said} Its ${one ? '1 file' : `${files.length} files`} under ${CLIENT_FOLDERS.map(top => `${top}/`).join(', ')} (${mb < 0.1 ? 'under 0.1' : mb.toFixed(1)} MB) ${one ? 'goes' : 'go'} to the Pine Computer with each task, and no result replaces ${one ? 'it' : 'them'}.`;
}

/** What the window's one folder means for a message in session `key`. */
export function entryFor(chats: readonly Conv[], projectsRoot: string, key: string, folder: string): Entry {
	const here = projectIdentity(folder);
	const own = chats.find(c => c.key === key);
	if (own?.folder) {
		const root = projectRootOf(projectsRoot, own);
		if (!existsSync(root) || projectIdentity(root) !== root) { return { kind: 'moved', folder: root }; }
		if (root !== here) { return { kind: 'elsewhere', folder: root }; }
	}
	const associated = chats.filter(c => projectIdentity(projectRootOf(projectsRoot, c)) === here);
	// The Project Chat and every other session of the project work in it (sessions are peers). A Chat of no project
	// yet, such as New Session's, joins it as a session on its first send (bindFolder).
	if (associated.some(c => c.project_role === 'main')) {
		return { kind: 'go', bind: !associated.some(c => c.key === key) };
	}
	if (associated.length) {
		return { kind: 'unassigned' };
	}
	if (existsSync(join(here, CONFIG))) {
		return { kind: 'adopt', folder: here };
	}
	const [project] = projectsBelow(here);
	if (project) {
		return { kind: 'inside', folder: here, project };
	}
	return { kind: 'go', bind: true, note: bindingNote(here) };
}
