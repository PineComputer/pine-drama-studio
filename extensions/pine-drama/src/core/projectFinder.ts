// One explicit project root; no child-layout discovery or migration. No vscode import.

import { CHOICES_FILE } from './choices';
import { DramaProject } from './project';

/** The files whose arrival or removal can change a folder's project, relative to the folder (DramaProject.rootIn). */
export const PROJECT_FILES = CHOICES_FILE;

/** How long a burst of file events settles before the folders are looked at again: git's debounce. */
const RESCAN_MS = 500;

export class ProjectFinder {
	private root: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Scans run one at a time, so an older scan never reports after a newer one. */
	private scans: Promise<unknown> = Promise.resolve();

	/**
	 * @param folders the window's folders, read at each scan.
	 * @param changed told the project's root each time it differs from the last scan's: a root, or undefined when gone.
	 * @param failed told why a scan or `changed` failed; the next file event scans again.
	 */
	constructor(
		private readonly folders: () => readonly string[],
		private readonly changed: (root: string | undefined) => void | Promise<void>,
		private readonly failed: (error: Error) => void,
		private readonly delayMs = RESCAN_MS,
	) { }

	/** Looks at the folders now: the first that holds a project, the selected root only (DramaProject.rootIn). */
	scan(): Promise<string | undefined> {
		const run = this.scans.then(async () => {
			let found: string | undefined;
			for (const folder of this.folders()) {
				found = await DramaProject.rootIn(folder);
				if (found) {
					break;
				}
			}
			if (found !== this.root) {
				// Recorded only once it was taken, so a change that failed is offered again by the next scan.
				await this.changed(found);
				this.root = found;
			}
			return found;
		});
		this.scans = run.catch(() => undefined);
		return run;
	}

	/** A project file was created, changed or deleted, or a stop was settled: scan once the burst is over. */
	possibleChange(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.scan().catch(error => this.failed(error as Error)), this.delayMs);
	}

	dispose(): void {
		clearTimeout(this.timer);
	}
}
