/**
 * Bringing the call's conversation into view — OPEN ONLY, never toggle.
 *
 * The nav-bar trigger is both the way IN to a call and the way BACK to one that
 * has been minimized, and those two jobs share one requirement: pressing it
 * must never hide the thing it exists to show. `Layout.handleRightPanelToggle`
 * cannot be reused for it, because a toggle pressed while the sidebar is
 * already open closes it — which, for a live call, reads as "I pressed the live
 * indicator and the call vanished". (It has not; the session lives above the
 * panel. But the user cannot tell that from the outside, and a UI that looks
 * like it hung up may as well have.)
 *
 * Hanging up is the call header's End button, and only that. One control, one
 * meaning.
 *
 * THE BREAKPOINT REASONING IS COPIED, NOT INVENTED: the three cases below
 * mirror `Layout.handleRightPanelToggle` exactly — sheet, desktop overlay,
 * persistent — including its rule that opening one overlay closes the other,
 * since two overlays open at once is what that rule exists to prevent. It is
 * expressed as data here so the trigger can be tested at every breakpoint
 * without a viewport.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

import type { VoiceSurface } from './voice-binding';

export type RevealFacts = {
  /**
   * Where the conversation renders. On `'dashboard'` it is already on screen in
   * the centre panel and the sidebar has no chat tab at all — revealing the
   * sidebar there would open a panel that cannot show the call.
   */
  readonly surface: VoiceSurface;
  readonly isSheetBreakpoint: boolean;
  readonly shouldOverlayRightSidebar: boolean;
  readonly shouldOverlayLeftSidebar: boolean;
  readonly rightSheetOpen: boolean;
  readonly leftSheetOpen: boolean;
  readonly rightSidebarOpen: boolean;
  readonly leftOverlayOpen: boolean;
};

/**
 * The writes to apply. A field is present ONLY when it would change something,
 * so a press with everything already open is genuinely a no-op rather than a
 * cascade of store writes that re-render the app for nothing.
 */
export type RevealWrites = {
  readonly rightSheetOpen?: boolean;
  readonly leftSheetOpen?: boolean;
  readonly rightSidebarOpen?: boolean;
  readonly leftOverlayOpen?: boolean;
  /**
   * Whether to bring the sidebar's chat tab to the front. False on the
   * dashboard, where there is no chat tab to bring forward.
   */
  readonly showChatTab: boolean;
};

const NOTHING_TO_REVEAL: RevealWrites = { showChatTab: false };

export const decideReveal = (facts: RevealFacts): RevealWrites => {
  if (facts.surface === 'dashboard') return NOTHING_TO_REVEAL;

  if (facts.isSheetBreakpoint) {
    return {
      ...(facts.rightSheetOpen ? {} : { rightSheetOpen: true }),
      // One sheet at a time, exactly as the toggle does it.
      ...(facts.rightSheetOpen || !facts.leftSheetOpen ? {} : { leftSheetOpen: false }),
      showChatTab: true,
    };
  }

  if (facts.shouldOverlayRightSidebar) {
    return {
      ...(facts.rightSidebarOpen ? {} : { rightSidebarOpen: true }),
      // Only when the LEFT is also an overlay: a persistent left sidebar is not
      // competing for the same space and must not be collapsed.
      ...(facts.rightSidebarOpen || !facts.shouldOverlayLeftSidebar || !facts.leftOverlayOpen
        ? {}
        : { leftOverlayOpen: false }),
      showChatTab: true,
    };
  }

  return {
    ...(facts.rightSidebarOpen ? {} : { rightSidebarOpen: true }),
    showChatTab: true,
  };
};
