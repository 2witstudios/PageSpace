/**
 * What closing a pane MEANS — the missing level in the pane grid's model
 * (a pane-close-lifecycle audit follow-up): session → conversation (agent listing) →
 * panes. A session's pane grid is keyed per SESSION, so closing the last
 * pane bound to one agent's conversation used to be a pure layout act — the
 * conversation's row stayed in the sidebar forever, and only emptying the
 * WHOLE grid ended anything. This is the pure decision that fills the gap:
 * closing the LAST pane bound to a conversation closes THAT conversation's
 * listing; only closing the session's LAST open listing ends the session.
 *
 * Kept separate from `select-pane-agent.ts` (the pane bar's SWITCH decision,
 * `pu/pane-agent-selector`): that module decides which conversation a pane
 * should point at next; this one decides what removing a pane's binding
 * means. Both read the same `SessionConversationSummary` shape, and both
 * share `mostRecentlyActive` (hoisted to `session-conversations.ts` once the
 * two branches met — each had reimplemented the identical reduce).
 *
 * A pure decision over PLAIN DATA (the pane grid's panes, plus the session's
 * listing) — no store, no fetch, no IO — so the branch never lives inline in
 * `AgentPanes`.
 */

import type { PaneState } from '@/stores/agent-workspace/pane-reducer';
import { mostRecentlyActive, type SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type ClosePaneDecision =
  | { action: 'noop' }
  /** A pure layout removal — nothing server-side to do. */
  | { action: 'close-pane' }
  /**
   * Close conversation `conversationId`'s listing (DELETE the session-scoped
   * route). `rebindTo`/`rebindAgentPageId` are set only when this pane is the
   * grid's last pane — the grid never empties, so the pane repoints at that
   * OTHER open conversation instead of vanishing.
   */
  | { action: 'close-conversation'; conversationId: string; rebindTo: string | null; rebindAgentPageId: string | null }
  /**
   * The pane being closed was NOT itself a conversation (a picker, a
   * terminal, or a chat pane still mid-mint) and is the grid's last pane —
   * but the session still has another OPEN conversation listing with no pane
   * of its own anywhere in this grid (e.g. a background worker mints one, or
   * another tab is the one showing it). Rebinding THIS pane to it is the
   * grid-never-empties rule applied uniformly: there is nothing here to
   * DELETE (a terminal/picker addresses no conversation), only a pane to
   * repoint — the session is not ended just because this ONE view ran out of
   * visual panes for it.
   */
  | { action: 'rebind-pane'; conversationId: string; agentPageId: string | null }
  /** Emptying the session's last listing (or its last pane, with nothing open to fall back to) — confirm, then end the session. */
  | { action: 'end-session' };

/**
 * The grid-last fallback shared by both branches below: with no conversation
 * of its own to close, the only question left is whether the session has
 * ANY other open listing to rebind this last pane to.
 *
 * `null` (the listing has never resolved — still in flight, or the fetch
 * failed) is NOT treated the same as a confirmed-empty one: offering to end
 * the session on a guess would, if the session actually has other open
 * conversations elsewhere, delete their shared sandbox out from under them
 * the moment the user confirms a dialog that never should have appeared
 * (caught in review). `noop` here — nothing happens, the close can be
 * retried once the listing is known, same discipline as every other
 * never-act-on-an-unverified-fact branch in this module. Only a CONFIRMED
 * empty array (the session genuinely has no other open listing) ends the
 * session, exactly as before this fallback existed.
 */
function gridLastFallback(activeConversations: readonly SessionConversationSummary[] | null): ClosePaneDecision {
  if (activeConversations === null) return { action: 'noop' };
  if (activeConversations.length === 0) return { action: 'end-session' };
  const target = mostRecentlyActive(activeConversations);
  return { action: 'rebind-pane', conversationId: target.conversationId, agentPageId: target.agentPageId };
}

/** This pane addresses no conversation of its own (right now, or no longer) — the shared non-chat/stale-listing rule. */
function notThisPanesConversation(
  isGridLast: boolean,
  activeConversations: readonly SessionConversationSummary[] | null,
): ClosePaneDecision {
  return isGridLast ? gridLastFallback(activeConversations) : { action: 'close-pane' };
}

export function decideClosePane(params: {
  /** Every pane in the grid, in visual order — `panesOf(workspace)`. */
  panes: readonly PaneState[];
  /** The pane being closed. */
  paneId: string;
  /**
   * This session's open conversation listings — the SWR fetch backing the
   * pane bar. `null` while it hasn't resolved yet: a close must never act on
   * an unverified fact, so this pane is treated exactly like one whose
   * conversation isn't (or is no longer) in the listing at all.
   */
  activeConversations: readonly SessionConversationSummary[] | null;
}): ClosePaneDecision {
  const { panes, paneId, activeConversations } = params;
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return { action: 'noop' };

  const isGridLast = panes.length <= 1;

  // Picker, terminal, or a chat pane still mid-mint (targetId null) — none of
  // these address a conversation listing, so this pane itself has nothing to
  // close.
  if (pane.scope === null || pane.scope.kind !== 'chat' || pane.scope.targetId === null) {
    return notThisPanesConversation(isGridLast, activeConversations);
  }

  const conversationId = pane.scope.targetId;

  // The SAME conversation is open in another pane too — a duplicate view.
  // Closing this one is layout-only; the conversation's listing stays open
  // because the other pane is still showing it.
  const shownElsewhere = panes.some(
    (other) => other.id !== paneId && other.scope?.kind === 'chat' && other.scope.targetId === conversationId,
  );
  if (shownElsewhere) return { action: 'close-pane' };

  // The listing hasn't loaded, or this conversation isn't (or is no longer)
  // in it — e.g. another tab already closed it. Never act on that unverified
  // state; fall back to the same rule as a non-chat pane.
  const isOpenListed = activeConversations?.some((c) => c.conversationId === conversationId) ?? false;
  if (!isOpenListed) {
    // Genuinely UNKNOWN (never resolved, or the fetch failed) is not the same
    // fact as "resolved and confirmed not open" — the latter really has
    // nothing left to DELETE (someone else already closed it), but the
    // former does not. Falling through to `notThisPanesConversation` here
    // would, for a non-grid-last pane, silently treat this as a pure layout
    // close — the conversation's actual listing stays open server-side,
    // lingering in the sidebar and holding a cap slot forever with no pane
    // left to retry the close from (caught in review). `noop` regardless of
    // pane count, same discipline `gridLastFallback` already applies.
    if (activeConversations === null) return { action: 'noop' };
    return notThisPanesConversation(isGridLast, activeConversations);
  }

  const otherOpenListings = (activeConversations ?? []).filter((c) => c.conversationId !== conversationId);

  if (!isGridLast) return { action: 'close-conversation', conversationId, rebindTo: null, rebindAgentPageId: null };

  // Grid-last: attempt the scoped close and let the SERVER be the authority
  // on whether this genuinely is the session's last open listing — a
  // resolved (non-null) client snapshot showing no OTHER listings can still
  // be STALE (another tab or a background worker created one since the last
  // poll). Short-circuiting straight to `end-session` here would skip the
  // server's own never-empty check entirely and let a confirm destroy a
  // session that actually still has another live conversation (caught in
  // review) — unlike this same case for a non-chat pane (`gridLastFallback`),
  // a chat pane HAS a conversation of its own to attempt a real scoped close
  // on, so there's no need to guess. The existing 409 `last_conversation`
  // handling in `AgentPanes` already falls back to the confirm dialog
  // correctly once the server actually says so.
  if (otherOpenListings.length === 0) {
    return { action: 'close-conversation', conversationId, rebindTo: null, rebindAgentPageId: null };
  }
  // A real candidate exists — rebind the grid to it instead of vanishing.
  const target = mostRecentlyActive(otherOpenListings);
  return {
    action: 'close-conversation',
    conversationId,
    rebindTo: target.conversationId,
    rebindAgentPageId: target.agentPageId,
  };
}
