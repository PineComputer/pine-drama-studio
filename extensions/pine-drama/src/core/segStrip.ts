// The seg strip's scrolling (canvas/seg.tsx; the person's bug of 2026-11-08: the strip cut off after seg06). A
// vertical wheel turn over the strip scrolls it sideways, as Pippit's strip does. A trackpad's sideways swipe and
// shift-wheel already scroll it natively (overflow-x), so they add nothing here. No DOM, so the tests can run it.

/** How far the strip moves sideways for a wheel event, beyond what the browser does itself. */
export function stripDelta(deltaX: number, deltaY: number): number {
	return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : 0;
}
