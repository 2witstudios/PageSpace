/**
 * What closing ONE TAB means — the tab-granularity successor to
 * `close-pane.ts`'s pane-granularity decision (`pu/pane-tabs`), now that
 * tabs are per-pane rather than one conversation per pane.
 *
 * The `rebind-pane` case `close-pane.ts` needed is GONE, deliberately: it
 * existed so a non-chat pane (picker/terminal) with nothing of its own to
 * close could "borrow" some OTHER pane's orphaned open listing rather than
 * vanish pointing at nothing. Per-pane tabs remove the need — a pane's own
 * tab list (`pane-reducer.ts`'s `closeTab`) already falls back to ITS other
 * remaining tabs or its own picker; it never reaches into another pane. Only
 * chat panes have tabs, so a picker/terminal/mid-mint pane never calls this
 * decision at all — plain `closePane` (pure layout removal) covers it,
 * unchanged from before.
 *
 * There is likewise no direct `'end-session'` outcome here — closing the
 * session's last open listing is always attempted as an ordinary
 * `close-conversation`, and the SERVER's own last-listing 409 is the sole
 * authority on whether that ends the session (the caller's existing 409
 * handling is what turns that into the end-session confirm). A resolved
 * client snapshot showing no other listings can still be stale; pre-guessing
 * `end-session` from it would risk destroying a session that actually still
 * has another live conversation elsewhere.
 */

import type { SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type CloseTabDecision =
  | { action: 'noop' }
  /** A pure local removal — nothing server-side to do (shown elsewhere, or already gone). */
  | { action: 'close-tab' }
  /** Close this conversation's listing (DELETE the session-scoped route); the server is the authority on the last-listing 409. */
  | { action: 'close-conversation'; conversationId: string };

export function decideCloseTab(params: {
  /** Every open chat tab in the grid, across every pane. */
  allTabs: readonly { paneId: string; targetId: string }[];
  /** The pane the closed tab belongs to. */
  paneId: string;
  conversationId: string;
  /**
   * This session's open conversation listings — the SWR fetch backing the
   * pane bar. `null` while it hasn't resolved yet: a close must never act on
   * an unverified fact.
   */
  activeConversations: readonly SessionConversationSummary[] | null;
}): CloseTabDecision {
  const { allTabs, paneId, conversationId, activeConversations } = params;

  // A grid-layout fact alone, checked first — true regardless of whether the
  // listing has loaded yet, same as `close-pane.ts`'s own duplicate-view case.
  const shownElsewhere = allTabs.some((tab) => tab.paneId !== paneId && tab.targetId === conversationId);
  if (shownElsewhere) return { action: 'close-tab' };

  if (activeConversations === null) return { action: 'noop' };

  const isOpenListed = activeConversations.some((c) => c.conversationId === conversationId);
  if (!isOpenListed) return { action: 'close-tab' }; // already closed elsewhere — nothing left to DELETE

  return { action: 'close-conversation', conversationId };
}
