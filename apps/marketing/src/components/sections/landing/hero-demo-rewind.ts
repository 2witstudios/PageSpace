/**
 * Should `HeroDemo` rewind the server-rendered window and replay the agent run,
 * or leave the finished frame exactly as the browser already painted it?
 *
 * Extracted as a predicate for the same reason `shouldShowAuthLoadingScreen` is:
 * the rule is a piece of reasoning about timing that is worth stating once and
 * testing directly, and it is invisible inside a layout effect.
 *
 * The rewind runs before the paint of the *hydration* update — but the browser
 * painted the SSR HTML long before hydration ran. On a slow connection or CPU,
 * hydration can arrive after landing.css's `lp-land` has finished, by which
 * point the completed window is already on screen. Hiding its contents then is
 * a finished-to-blank flash followed by a replay from empty, which is strictly
 * worse than simply not animating.
 *
 * The hydration mount is the only one this applies to. A later mount in the same
 * document is a client-side navigation back to `/`: React renders the markup
 * fresh and this layout effect runs before it has ever been painted, so there is
 * nothing on screen to flash and the run should play as normal. That distinction
 * matters because `elapsedMs` is measured from navigation start, a clock that is
 * meaningful for hydration and meaningless afterwards.
 */
export function shouldRewindHeroDemo(state: {
  /** Is this the document's first mount, i.e. hydration of the SSR markup? */
  isHydration: boolean;
  /** Milliseconds since navigation start (`performance.now()`). */
  elapsedMs: number;
  /** When `lp-land` has finished and the window is fully on screen. */
  windowLandedMs: number;
}): boolean {
  if (!state.isHydration) return true;
  return state.elapsedMs <= state.windowLandedMs;
}
