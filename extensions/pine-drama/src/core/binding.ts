// One explicit project root; no child-layout discovery or migration. No vscode import.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectIdentity, projectRootOf } from './projectPlace';
import { readProjectMajor } from './project';

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
	| { readonly kind: 'inside'; readonly folder: string; readonly project: string }
	/** The folder is a drama of another format (doc/protocol.md, section 7): nothing is written into it. */
	| { readonly kind: 'otherFormat'; readonly folder: string; readonly schema: number };

interface Conv {
	readonly key: string;
	readonly label: string;
	readonly folder: string | null;
	readonly project_role?: 'main' | null;
}

/** Every folder below `dir`, outside hidden ones, which no turn carries (doc/protocol.md 4.2); a link is not followed. */
function foldersBelow(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).flatMap(e => [join(dir, e.name), ...foldersBelow(join(dir, e.name))]);
}

/**
 * The dramas below `folder`, by their roots: every folder a turn would carry (foldersBelow) that is a drama as Open
 * Project tells one, of any format (project.ts readProjectMajor: a marker that is a file, a linked one too), so its files would be
 * swept into this one's upload and get a second writer.
 */
export function projectsBelow(folder: string): string[] {
	return foldersBelow(folder).filter(dir => readProjectMajor(dir) !== undefined).map(projectIdentity).sort();
}

/**
 * New Project, Open Project and the first send share this one rule: a folder that holds no drama, at its root or
 * below, is used as a new project, whatever else it holds. An entry named like
 * marker at the root that is not a file (a folder, say) is not one either.
 */
export function holdsNoProject(folder: string): boolean { return readProjectMajor(folder) === undefined && !projectsBelow(folder).length; }

/** The first send's one note: where the project is, and that its files go with each turn (doc/protocol.md 4.2). */
function bindingNote(root: string): string {
	return `This project's root is \`${root}\`. Its files go to the Pine Computer with each turn, and the turn's results land here as they finish; the project's history keeps whatever they replace.`;
}

/** What the window's one folder means for a message in session `key`. */
export function entryFor(chats: readonly Conv[], projectsRoot: string, key: string, folder: string): Entry {
	const here = projectIdentity(folder);
	// A drama of another major is never written (doc/protocol.md, section 7), whichever Chat worked in it before.
	const schema = readProjectMajor(here);
	if (schema !== undefined && schema !== 2) {
		return { kind: 'otherFormat', folder: here, schema };
	}
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
	if (schema === 2) {
		return { kind: 'adopt', folder: here };
	}
	const [project] = projectsBelow(here);
	if (project) {
		return { kind: 'inside', folder: here, project };
	}
	return { kind: 'go', bind: true, note: bindingNote(here) };
}
