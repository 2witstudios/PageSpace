import { describe, expect, it } from 'vitest';
import { shouldRewindHeroDemo } from '../hero-demo-rewind';

const WINDOW_LANDED = 2000;

describe('shouldRewindHeroDemo', () => {
  it('should rewind when hydration beats the window landing, the ordinary fast load', () => {
    expect(
      shouldRewindHeroDemo({ isHydration: true, elapsedMs: 300, windowLandedMs: WINDOW_LANDED }),
    ).toBe(true);
  });

  it('should NOT rewind when hydration arrives after the window has landed', () => {
    // The failure this guards: on a slow connection the finished window has been
    // painted and visible for seconds, and rewinding blanks it before replaying
    // from empty — a finished-to-blank flash.
    expect(
      shouldRewindHeroDemo({ isHydration: true, elapsedMs: 4200, windowLandedMs: WINDOW_LANDED }),
    ).toBe(false);
  });

  it('should still rewind at exactly the landing moment', () => {
    // The window is only just finished here; nothing has been sitting on screen
    // long enough to flash, so the run should still play.
    expect(
      shouldRewindHeroDemo({ isHydration: true, elapsedMs: WINDOW_LANDED, windowLandedMs: WINDOW_LANDED }),
    ).toBe(true);
  });

  it('should always rewind on a later mount, however long the document has been open', () => {
    // A client-side navigation back to `/`: the markup is rendered fresh and the
    // layout effect runs before it is painted, so there is nothing to flash.
    // elapsedMs is measured from navigation start and is meaningless here — a
    // guard that ignored isHydration would silently kill the demo for the rest
    // of the session.
    expect(
      shouldRewindHeroDemo({ isHydration: false, elapsedMs: 900_000, windowLandedMs: WINDOW_LANDED }),
    ).toBe(true);
  });
});
