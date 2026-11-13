// New Project's and Open Project's folder checks. Read-only: nothing is written here.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHOICES_FILE } from './choices';
import { DramaProject } from './project';
import { projectIdentity } from './projectPlace';
import { projectsBelow } from './binding';

/**
 * New Project's and Open Project's choice: the chosen folder is the project. A folder that is a project
 * opens as that project; one that holds no drama, empty or with the person's files, becomes a new project's
 * root with no folder made inside it; one that holds projects below its root names them
 * (ProjectsInsideError) and opens none by itself. Read-only: nothing is written.
 */
export async function projectAt(folder: string): Promise<{ readonly root: string; readonly initialized: boolean }> {
	const root = await DramaProject.rootIn(folder);
	if (root) { return { root, initialized: true }; }
	const here = projectIdentity(folder);
	const inside = projectsBelow(here);
	if (inside.length) { throw new ProjectsInsideError(folder, inside); }
	if (existsSync(join(here, CHOICES_FILE))) { throw new Error(`${join(here, CHOICES_FILE)} is not a file, so ${folder} is neither a drama nor a folder for a new one. Nothing was written.`); }
	return { root: here, initialized: false };
}

/**
 * The chosen folder holds no project of its own, but projects below it do: for example the child "Untitled Project" that
 * New Project used to make, chosen by its parent. `projects` are their roots; the person picks one explicitly.
 */
export class ProjectsInsideError extends Error {
	constructor(readonly folder: string, readonly projects: readonly string[]) {
		super(projects.length === 1
			? `${folder} is not a drama itself; the drama is inside it: ${projects[0]}.`
			: `${folder} is not a drama itself; it holds ${projects.length} projects: ${projects.map(p => basename(p)).join(', ')}. Open the one you want.`);
	}
}

