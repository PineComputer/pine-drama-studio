// The Pine session generation of each Chat (glossary: pineSessionGeneration, formerly the lease's epoch). No vscode import.
//
// One window drives a project's Chats (the project window lock, core/projectWindowLock.ts), so no other window's
// writes need fencing, and the lease that fenced them is gone. One fence remains, inside this window: when
// replaceEndedPineSession replaces a Chat's Pine session, a follower or import still running for the earlier session
// (which captured the earlier generation) must write nothing more. It is kept in memory: the passes it fences
// live only in this process, and a new window's process starts with none of them.

export class PineSessionReplacedError extends Error {
	readonly name = 'PineSessionReplacedError';
}

export class PineSessionGenerations {
	private readonly current = new Map<string, number>();

	/** The generation of `key`'s Pine session that a pass captures when it starts. */
	of(key: string): number {
		return this.current.get(key) ?? 1;
	}

	/** Retires every pass of `key`'s current Pine session: their next write throws. Returns the new generation. */
	advance(key: string): number {
		const next = this.of(key) + 1;
		this.current.set(key, next);
		return next;
	}

	/** Throws PineSessionReplacedError when `key`'s Pine session was replaced after the pass captured `generation`. */
	assert(key: string, generation: number): void {
		if (this.of(key) !== generation) {
			throw new PineSessionReplacedError(`${key}: its Pine session was replaced; this pass of the earlier one writes nothing`);
		}
	}
}
