/**
 * WHAT CLOSING A PANE MEANS — the missing level in the workspace's model:
 * workspace → conversation (the listing) → nodes. Closing the last node bound to
 * one conversation closes THAT conversation's listing; closing a node bound to
 * anything else is pure layout.
 *
 * **Two branches left of five, and the model is what removed the other three.**
 *
 *  - `end-session` is GONE. Closing the last pane leaves an empty grid and does
 *    not end the workspace. That decision used to live half in the reducer
 *    (which no-oped on the last pane, because a two-level grid could not
 *    represent zero) and half in browser code that ended the session — the exact
 *    half-in-each-place coupling the flat model exists to delete. `validateTree`
 *    is explicit that a root holding nothing is an ordinary state, and ending a
 *    workspace is an explicit lifecycle act elsewhere, behind its own confirm.
 *  - `rebind-pane` is GONE with it. It existed to keep the grid non-empty by
 *    repointing the last pane at some other open thread — a guess the user did
 *    not ask for, needed only because zero was unspellable.
 *  - The "shown in another pane" branch is GONE because the state is now
 *    UNSPELLABLE: `agent_workspace_nodes` carries `UNIQUE (targetId) WHERE
 *    targetKind = 'chat'`, and the algebra's `shownElsewhere` refuses the bind
 *    before the index has to. One conversation, at most one node.
 *
 * What survives is the fact this module was written for and the model does not
 * answer on its own: whether closing this rectangle should also close the
 * THREAD's listing. Closing a node parks it — it stays a member of the workspace
 * — so that is a genuinely separate question, and it is the one the server route
 * owns the authority on.
 *
 * A pure decision over PLAIN DATA (the workspace's panes, plus its listing) — no
 * store, no fetch, no IO — so the branch never lives inline in `AgentPanes`.
 */

import type { PaneNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { type SessionConversationSummary } from './workspace-conversations';

export type { SessionConversationSummary };

export type ClosePaneDecision =
  /** Nothing to act on, or nothing that can be decided yet. */
  | { action: 'noop' }
  /** A pure layout removal: the node leaves the grid and stays in the workspace. */
  | { action: 'close-pane' }
  /**
   * Take the node out of the grid AND close conversation `conversationId`'s
   * listing (the workspace-scoped DELETE). The node still only parks — closing
   * the thread is the extra act, not a different one.
   */
  | { action: 'close-conversation'; conversationId: string };

export function decideClosePane(params: {
  /** Every pane in the workspace, attached or parked. */
  panes: readonly PaneNode[];
  /** The node being closed. */
  nodeId: string;
  /**
   * This workspace's open conversation listings — the SWR fetch backing the pane
   * bar. `null` while it has not resolved yet: a close must never act on an
   * unverified fact.
   */
  activeConversations: readonly SessionConversationSummary[] | null;
}): ClosePaneDecision {
  const { panes, nodeId, activeConversations } = params;
  const node = panes.find((pane) => pane.id === nodeId);
  if (!node) return { action: 'noop' };

  // A picker, a terminal or a page pane addresses no conversation listing, so
  // this node has nothing of its own to close. Parking it is the whole act.
  if (node.target === null || node.target.kind !== 'chat') return { action: 'close-pane' };

  const conversationId = node.target.id;

  // Genuinely UNKNOWN (never resolved, or the fetch failed) is not the same fact
  // as "resolved and confirmed not open". Treating it as the latter would
  // silently make this a pure layout close while the thread's listing stays open
  // server-side, lingering in the sidebar and holding a cap slot with no pane
  // left to retry the close from.
  if (activeConversations === null) return { action: 'noop' };

  // Resolved, and this thread is not in it — somebody else already closed it.
  // There is nothing left to DELETE; park the node and be done.
  if (!activeConversations.some((entry) => entry.conversationId === conversationId)) {
    return { action: 'close-pane' };
  }

  return { action: 'close-conversation', conversationId };
}
