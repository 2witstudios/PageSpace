/**
 * What the pane header's "+" chip means, as a pure decision — sibling of
 * `select-pane-agent.ts`'s SWITCH decision, but for deliberately OPENING a
 * new tab rather than replacing the active one.
 *
 * The same three-way reuse-before-mint question `selectPaneAgent` asks:
 * already a tab in THIS pane (`focus` it, never a duplicate tab), already
 * open somewhere else in the session (`focus-existing` — add THAT
 * conversation as this pane's new tab, no mint needed), or neither
 * (`mint`). `AgentPanes.tsx`'s `handleOpenTab` runs `focus`/`focus-existing`
 * through `switchTab`/`openTab` respectively (both APPEND-or-activate,
 * never touching the pane's current active tab — the one thing that never
 * changes here, unlike the SWITCH decision's `mint`, which replaces it).
 */

import { findOpenForAgent, type SessionConversationSummary } from './session-conversations';

export type { SessionConversationSummary };

export type OpenTabDecision =
  | { action: 'focus'; conversationId: string }
  | { action: 'focus-existing'; conversationId: string }
  | { action: 'mint' };

export function decideOpenTab(params: {
  /** THIS pane's own open tabs — checked first. */
  paneTabs: readonly SessionConversationSummary[];
  /** Every open conversation in the session — checked second, for a mint-free reuse. */
  sessionConversations: readonly SessionConversationSummary[];
  /** The agent chosen from the "+" chip's picker. */
  selectedAgentPageId: string | null;
}): OpenTabDecision {
  const ownTab = findOpenForAgent(params.paneTabs, params.selectedAgentPageId);
  if (ownTab !== undefined) return { action: 'focus', conversationId: ownTab.conversationId };

  const existing = findOpenForAgent(params.sessionConversations, params.selectedAgentPageId);
  if (existing !== undefined) return { action: 'focus-existing', conversationId: existing.conversationId };

  return { action: 'mint' };
}
