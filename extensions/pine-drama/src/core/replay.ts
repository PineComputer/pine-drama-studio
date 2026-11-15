// One producer, any number of readers: each reader gets every item the producer has yielded, from its first, then each
// new one as it comes, and then the producer's end or its error. A late reader misses nothing, as RxJS's ReplaySubject
// "replays old values to new subscribers" (https://rxjs.dev/api/index/class/ReplaySubject). No vscode import.

export class Replay<T> {
	private readonly items: T[] = [];
	private ended = false;
	private failure: { readonly error: unknown } | undefined;
	private waiting: (() => void)[] = [];

	/** The producer runs from now to its end, read or not. */
	constructor(source: AsyncIterable<T>) {
		void (async () => {
			try {
				for await (const item of source) { this.items.push(item); this.wake(); }
			} catch (error) {
				this.failure = { error };
			} finally {
				this.ended = true;
				this.wake();
			}
		})();
	}

	async *read(): AsyncGenerator<T> {
		for (let at = 0; ;) {
			if (at < this.items.length) { yield this.items[at++]; continue; }
			if (this.ended) {
				if (this.failure) { throw this.failure.error; }
				return;
			}
			await new Promise<void>(resolve => this.waiting.push(resolve));
		}
	}

	private wake(): void { for (const resolve of this.waiting.splice(0)) { resolve(); } }
}
