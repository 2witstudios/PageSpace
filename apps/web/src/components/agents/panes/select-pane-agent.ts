/**
 * What switching a chat pane's agent, via the pane bar's `AISelector`, means —
 * a pure decision so the branch never lives inline in `AgentPanes`.
 *
 * A two-way question, checked in order:
 *
 * 1. Does the picked agent already have an open conversation SOMEWHERE in the
 *    session (another pane, or no pane at all)? → `focus-existing` — show
 *    THAT SAME conversation here, replacing this pane's current one (no mint
 *    needed — the id already exists). This never steals focus to the other
 *    pane, it brings the conversation here — even if another pane also shows
 *    it, this one just gets its own view of the same conversation.
 * 2. Otherwise → `mint` — nothing exists yet anywhere.
 *
 * `focus-existing` still runs the outgoing conversation through the same
 * replace-and-close path a mint does (`AgentPanes.tsx`'s `handleSwitchAgent`,
 * via `assignPane` + `closeReplacedConversation`) — the pane's previous
 * conversation gets closed unless another pane still shows it, which is the
 * fix for panes silently accumulating stray sidebar rows. Once you leave an
 * agent, returning to it is a fresh mint (or, deliberately, a re-open via
 * History) — not a free rewind, because the outgoing conversation was closed,
 * not preserved anywhere.
 */

import { findOpenForAgent, type SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type SelectPaneAgentDecision =
  | { action: 'noop' }
  | { action: 'focus-existing'; conversationId: string }
  | { action: 'mint' };

export function selectPaneAgent(params: {
  /** Every open conversation in the session. */
  sessionConversations: readonly SessionConversationSummary[];
  /** The agent the pane bar's dropdown was switched to. */
  selectedAgentPageId: string | null;
  /** The pane's agent right now. */
  currentAgentPageId: string | null;
}): SelectPaneAgentDecision {
  const { sessionConversations, selectedAgentPageId, currentAgentPageId } = params;

  if (selectedAgentPageId === currentAgentPageId) return { action: 'noop' };

  const existing = findOpenForAgent(sessionConversations, selectedAgentPageId);
  if (existing !== undefined) return { action: 'focus-existing', conversationId: existing.conversationId };

  return { action: 'mint' };
}
