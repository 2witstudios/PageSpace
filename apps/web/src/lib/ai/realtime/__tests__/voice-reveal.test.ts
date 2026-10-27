import { describe, expect, it } from 'vitest';
import { decideReveal, type RevealFacts } from '../voice-reveal';

/**
 * "Reveal" is the half of the toggle that opens. The property that matters is
 * negative and is asserted at every breakpoint: it must never produce a write
 * that CLOSES the right sidebar, because the same button is the live indicator
 * for a call in progress.
 */

const facts = (overrides: Partial<RevealFacts> = {}): RevealFacts => ({
  surface: 'sidebar',
  isSheetBreakpoint: false,
  shouldOverlayRightSidebar: false,
  shouldOverlayLeftSidebar: false,
  rightSheetOpen: false,
  leftSheetOpen: false,
  rightSidebarOpen: false,
  leftOverlayOpen: false,
  ...overrides,
});

describe('decideReveal — open-only', () => {
  it('should open the persistent sidebar and bring the chat tab forward', () => {
    expect(decideReveal(facts())).toEqual({ rightSidebarOpen: true, showChatTab: true });
  });

  it('should open the sheet on mobile, closing the competing left sheet', () => {
    expect(decideReveal(facts({ isSheetBreakpoint: true, leftSheetOpen: true }))).toEqual({
      rightSheetOpen: true,
      leftSheetOpen: false,
      showChatTab: true,
    });
  });

  it('should open the desktop overlay, collapsing the left one only when it is ALSO an overlay', () => {
    const bothOverlay = decideReveal(
      facts({
        shouldOverlayRightSidebar: true,
        shouldOverlayLeftSidebar: true,
        leftOverlayOpen: true,
      }),
    );
    expect(bothOverlay).toEqual({
      rightSidebarOpen: true,
      leftOverlayOpen: false,
      showChatTab: true,
    });

    // A PERSISTENT left sidebar is not competing for the space, so it stays.
    const leftPersistent = decideReveal(
      facts({
        shouldOverlayRightSidebar: true,
        shouldOverlayLeftSidebar: false,
        leftOverlayOpen: true,
      }),
    );
    expect(leftPersistent).toEqual({ rightSidebarOpen: true, showChatTab: true });
  });

  it('should never emit a write that closes the right sidebar, at ANY breakpoint', () => {
    const breakpoints: Array<Partial<RevealFacts>> = [
      { isSheetBreakpoint: true },
      { shouldOverlayRightSidebar: true },
      {},
    ];

    for (const breakpoint of breakpoints) {
      for (const alreadyOpen of [false, true]) {
        const writes = decideReveal(
          facts({ ...breakpoint, rightSidebarOpen: alreadyOpen, rightSheetOpen: alreadyOpen }),
        );
        expect(writes.rightSidebarOpen).not.toBe(false);
        expect(writes.rightSheetOpen).not.toBe(false);
      }
    }
  });

  it('should be a genuine no-op when everything is already open', () => {
    // Not merely harmless: pressing a live indicator must not re-render the app
    // by writing values that are already set.
    expect(decideReveal(facts({ rightSidebarOpen: true }))).toEqual({ showChatTab: true });
    expect(
      decideReveal(facts({ isSheetBreakpoint: true, rightSheetOpen: true, leftSheetOpen: true })),
    ).toEqual({ showChatTab: true });
  });

  it('should open NOTHING on the dashboard, where the sidebar has no chat tab', () => {
    // GlobalAssistantView already holds the centre of the screen there. Opening
    // the sidebar would open a panel that cannot show the call.
    expect(decideReveal(facts({ surface: 'dashboard' }))).toEqual({ showChatTab: false });
    expect(
      decideReveal(facts({ surface: 'dashboard', isSheetBreakpoint: true })),
    ).toEqual({ showChatTab: false });
  });
});
