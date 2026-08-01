/**
 * What switching a chat pane's agent, via the pane bar's `AISelector`, means —
 * a pure decision so the branch never lives inline in `AgentPanes`.
 *
 * A three-way question, checked in order:
 *
 * 1. Does THIS PANE already have its own tab open for the picked agent? →
 *    `switch-tab` — reactivate it (a pure local `switchTab`, no network,
 *    every other tab untouched).
 * 2. Does the picked agent already have an open conversation SOMEWHERE ELSE
 *    in the session (another pane, or no pane at all)? → `focus-existing` —
 *    show THAT SAME conversation here too, replacing this pane's active
 *    tab (no mint needed — the id already exists). Confirmed: no cross-pane
 *    DEDUP on switch ("no reason you can't have the same agent open twice
 *    ... it just replaces the agent that was there ... with its own view of
 *    that conversation, even if another pane also shows it") — this never
 *    steals focus to the other pane, it brings the conversation here.
 * 3. Otherwise → `mint` — nothing exists yet anywhere.
 *
 * Both `switch-tab` and `focus-existing` are "no network needed to learn
 * the id" outcomes; `focus-existing` still runs the outgoing tab through
 * the same replace-and-close path a mint does (`AgentPanes.tsx`'s
 * `handleSwitchAgent`, via `replaceTab` + `closeReplacedConversation`) — the
 * old tab's conversation gets closed unless another pane still shows it,
 * which is the actual fix for panes silently accumulating stray sidebar
 * rows. Once you leave an agent, returning to it is a fresh mint (or,
 * deliberately, a re-open via History) — not a free rewind, because the
 * outgoing conversation was closed, not preserved in the background.
 */

import { findOpenForAgent, type SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type SelectPaneAgentDecision =
  | { action: 'noop' }
  | { action: 'switch-tab'; conversationId: string }
  | { action: 'focus-existing'; conversationId: string }
  | { action: 'mint' };

export function selectPaneAgent(params: {
  /** THIS pane's own open tabs — checked first, for a pure local switch. */
  paneTabs: readonly SessionConversationSummary[];
  /** Every open conversation in the session — checked second, for a mint-free reuse. */
  sessionConversations: readonly SessionConversationSummary[];
  /** The agent the pane bar's dropdown was switched to. */
  selectedAgentPageId: string | null;
  /** The pane's agent right now. */
  currentAgentPageId: string | null;
}): SelectPaneAgentDecision {
  const { paneTabs, sessionConversations, selectedAgentPageId, currentAgentPageId } = params;

  if (selectedAgentPageId === currentAgentPageId) return { action: 'noop' };

  const ownTab = findOpenForAgent(paneTabs, selectedAgentPageId);
  if (ownTab !== undefined) return { action: 'switch-tab', conversationId: ownTab.conversationId };

  const existing = findOpenForAgent(sessionConversations, selectedAgentPageId);
  if (existing !== undefined) return { action: 'focus-existing', conversationId: existing.conversationId };

  return { action: 'mint' };
}
