/**
 * The last request wins: each call to `next()` starts a request and returns
 * a check that stays true only until another request starts. A lookup that reads files checks it before it applies
 * its result, so a slower, older lookup never overwrites a newer one.
 */
export class Latest {
	private count = 0;

	next(): () => boolean {
		const mine = ++this.count;
		return () => mine === this.count;
	}
}
