import { Latest } from './latest';

/** What a canvas needs from the workbench: who is in front, how to show a pick in Versions, how to bring Versions back in line. */
interface CanvasPicksIo<P> {
	isActive(canvas: string): boolean;
	showInVersions(pick: P): Promise<void>;
	/** Re-reads the active tab's subject; with no pick the canvas reports none and Versions empties. */
	followActive(): void;
}

/**
 * The card picked on each episode canvas (sections 6 and 7). The last message of a canvas
 * wins, so a pick that resolves after an unpick or a newer pick applies nothing; a pick is always remembered, but it
 * reaches Versions only while its canvas is in front, because the tab it left already decided what Versions shows.
 */
export class CanvasPicks<P> {
	private readonly latest = new Map<string, Latest>();
	private readonly picks = new Map<string, P>();

	constructor(private readonly io: CanvasPicksIo<P>) {}

	get(canvas: string): P | undefined {
		return this.picks.get(canvas);
	}

	/** Resolves the pick, then applies it unless a later message of this canvas came first. Returns whether it was applied. */
	async pick(canvas: string, resolve: () => Promise<P>): Promise<boolean> {
		const current = this.sequence(canvas).next();
		const pick = await resolve();
		if (!current()) {
			return false;
		}
		this.picks.set(canvas, pick);
		if (this.io.isActive(canvas)) {
			await this.io.showInVersions(pick);
		}
		return true;
	}

	unpick(canvas: string): void {
		this.sequence(canvas).next();
		this.picks.delete(canvas);
		if (this.io.isActive(canvas)) {
			this.io.followActive();
		}
	}

	close(canvas: string): void {
		this.sequence(canvas).next();
		this.picks.delete(canvas);
		this.latest.delete(canvas);
	}

	private sequence(canvas: string): Latest {
		return this.latest.get(canvas) ?? this.latest.set(canvas, new Latest()).get(canvas)!;
	}
}
