/**
 * What switching a chat pane's agent, via the pane bar's `AISelector`, means —
 * a pure decision so the branch never lives inline in `AgentPanes`.
 *
 * Mirrors `useAgentWorkspaceStore`'s `openConversation` focus-or-open policy,
 * but scoped to ONE pane's pick rather than "wherever fits": the caller
 * already knows exactly which pane the pick came from, so there is no
 * placement search here — only the existing-vs-mint choice, and the
 * same-agent no-op.
 *
 * Switching a pane's agent never rebinds a conversation — binding is
 * congenital and permanent (contract invariant 2). This only decides which
 * conversation IN THE SAME SESSION the pane should point at next: an
 * existing one (focus, via the store's dedup-aware `openConversation`, which
 * mirrors "returning to an agent resumes its conversation as-is, it never
 * mints a new row") or a fresh one (mint, via the picker's own path).
 */

import { mostRecentlyActive, type SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type SelectPaneAgentDecision =
  | { action: 'noop' }
  | { action: 'focus'; conversationId: string }
  | { action: 'mint' };

export function selectPaneAgent(params: {
  /** This session's conversations — any agent, not just the pane's current one. */
  conversations: readonly SessionConversationSummary[];
  /** The agent the pane bar's dropdown was switched to. */
  selectedAgentPageId: string | null;
  /** The pane's agent right now. */
  currentAgentPageId: string | null;
}): SelectPaneAgentDecision {
  const { conversations, selectedAgentPageId, currentAgentPageId } = params;

  if (selectedAgentPageId === currentAgentPageId) return { action: 'noop' };

  const matches = conversations.filter((c) => c.agentPageId === selectedAgentPageId);
  if (matches.length === 0) return { action: 'mint' };

  return { action: 'focus', conversationId: mostRecentlyActive(matches).conversationId };
}
