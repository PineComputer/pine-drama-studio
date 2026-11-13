/**
 * One run at a time, as Code-OSS's Throttler (src/vs/base/common/async.ts at 0959cbd839d): a call while a run is in
 * flight waits for one more run that starts after that one ends, shared by every call made meanwhile. Runs never
 * overlap or pile up, and each caller gets a result read after it asked. No vscode import.
 */
export class Throttled<T> {
	private active: Promise<T> | undefined;
	private queued: Promise<T> | undefined;

	constructor(private readonly task: () => Promise<T>) {}

	run(): Promise<T> {
		// A queued run is busy from the moment it is queued until it starts: a call made as the active run ends, before
		// the queued one begins, joins it rather than starting a second run beside it.
		if (this.queued) {
			return this.queued;
		}
		if (!this.active) {
			return this.start();
		}
		const settled = this.active.then(() => undefined, () => undefined);
		this.queued = settled.then(() => {
			this.queued = undefined;
			return this.start();
		});
		return this.queued;
	}

	private start(): Promise<T> {
		const run = this.task();
		this.active = run;
		const clear = () => {
			if (this.active === run) {
				this.active = undefined;
			}
		};
		run.then(clear, clear);
		return run;
	}
}
