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
 * means. Both read the same `SessionConversationSummary` shape (hoisted to
 * `session-conversations.ts` once the two branches met).
 *
 * A pure decision over PLAIN DATA (the pane grid's panes, plus the session's
 * listing) — no store, no fetch, no IO — so the branch never lives inline in
 * `AgentPanes`.
 */

import type { PaneState } from '@/stores/agent-workspace/pane-reducer';
import type { SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type ClosePaneDecision =
  | { action: 'noop' }
  /** A pure layout removal — nothing server-side to do. */
  | { action: 'close-pane' }
  /**
   * Close conversation `conversationId`'s listing (DELETE the session-scoped
   * route). `rebindTo` is set only when this pane is the grid's last pane —
   * the grid never empties, so the pane repoints at that OTHER open
   * conversation instead of vanishing.
   */
  | { action: 'close-conversation'; conversationId: string; rebindTo: string | null }
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

/** The listing most recently active, treating never-messaged as older than any messaged one. */
function mostRecentlyActive<T extends { lastMessageAt: string | null }>(listings: readonly T[]): T {
  return listings.reduce((latest, candidate) => {
    const latestAt = latest.lastMessageAt ? Date.parse(latest.lastMessageAt) : -Infinity;
    const candidateAt = candidate.lastMessageAt ? Date.parse(candidate.lastMessageAt) : -Infinity;
    return candidateAt > latestAt ? candidate : latest;
  });
}

/**
 * The grid-last fallback shared by both branches below: with no conversation
 * of its own to close, the only question left is whether the session has
 * ANY other open listing to rebind this last pane to. `null` (unloaded) or
 * empty means genuinely nothing to fall back to — end the session, same as
 * before this fallback existed.
 */
function gridLastFallback(activeConversations: readonly SessionConversationSummary[] | null): ClosePaneDecision {
  if (!activeConversations || activeConversations.length === 0) return { action: 'end-session' };
  const target = mostRecentlyActive(activeConversations);
  return { action: 'rebind-pane', conversationId: target.conversationId, agentPageId: target.agentPageId };
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
  // close. Not grid-last is still a pure layout act; grid-last falls back to
  // "is there another open listing to rebind to" rather than assuming the
  // session must end (a lone terminal pane is not proof the session's other
  // conversations are gone — they may simply have no pane HERE).
  if (pane.scope === null || pane.scope.kind !== 'chat' || pane.scope.targetId === null) {
    return isGridLast ? gridLastFallback(activeConversations) : { action: 'close-pane' };
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
    return isGridLast ? gridLastFallback(activeConversations) : { action: 'close-pane' };
  }

  const otherOpenListings = (activeConversations ?? []).filter((c) => c.conversationId !== conversationId);

  // This IS the session's last open listing — ending the session is the only
  // correct act, even if terminal panes remain elsewhere in the grid: they
  // belong to the session, and the session's lifecycle follows its last
  // conversation, not its pane count.
  if (otherOpenListings.length === 0) return { action: 'end-session' };

  if (!isGridLast) return { action: 'close-conversation', conversationId, rebindTo: null };

  // Grid-last: the grid never empties, so this pane rebinds to the most
  // recently active OTHER open listing instead of vanishing.
  const target = mostRecentlyActive(otherOpenListings);
  return { action: 'close-conversation', conversationId, rebindTo: target.conversationId };
}
