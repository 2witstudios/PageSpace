/**
 * WHAT CLOSING A PANE MEANS — the missing level in the workspace's model:
 * workspace → conversation (the listing) → nodes. Closing the last node bound to
 * one conversation closes THAT conversation's listing; closing a node bound to
 * anything else is pure layout.
 *
 * **Three branches, and each one is here because the model does not answer it.**
 *
 *  - `end-session` — closing the LAST pane. This was removed in the node-tree
 *    cutover on the grounds that the decision "used to live half in the reducer
 *    (which no-oped on the last pane, because a two-level grid could not
 *    represent zero) and half in browser code that ended the session — the
 *    exact half-in-each-place coupling the flat model exists to delete". That
 *    objection is right about the OLD SHAPE and says nothing against the
 *    decision existing: it is answered by putting the WHOLE decision here,
 *    where it is one branch over the same plain data as its neighbours, with no
 *    half anywhere else. What is left in browser code is raising the confirm,
 *    which is rendering. Restored because the product wants it: `validateTree`
 *    permits a root holding nothing, but permitting a state is not the same as
 *    leaving a user in it, and the previous release stranded people in an empty
 *    grid with no visible way forward.
 *  - `rebind-pane` is GONE, and stays gone. It kept the grid non-empty by
 *    repointing the last pane at some other open thread — a guess the user did
 *    not ask for, needed only because zero was unspellable. Ending is not that:
 *    it is what the user asked for, confirmed first, and cancellable.
 *  - The "shown in another pane" branch is GONE because the state is now
 *    UNSPELLABLE: `agent_workspace_nodes` carries `UNIQUE (targetId) WHERE
 *    targetKind = 'chat'`, and the algebra's `shownElsewhere` refuses the bind
 *    before the index has to. One conversation, at most one node.
 *
 * The other fact this module was written for is whether closing a chat pane
 * needs the THREAD's own DELETE on top of the node write. **It no longer does.**
 * The listing is derived from the nodes (`workspace-conversations-runtime.ts`
 * reads `agentWorkspaceNodes WHERE targetKind = 'chat'`), and the directory
 * `conversation:closed` is emitted by the write funnel itself, for every
 * producer — so `close-conversation` names the CALLER's follow-up (tell the
 * console, patch the local switch-decision cache) rather than a second request.
 * Both branches destroy the node and nothing parks: membership IS the node, so
 * either way the thread leaves the workspace.
 *
 * A pure decision over PLAIN DATA (the workspace's panes, its listing, and
 * whether this viewer may end the workspace at all) — no store, no fetch, no IO
 * — so the branch never lives inline in `AgentPanes`.
 */

import type { PaneNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { type SessionConversationSummary } from './workspace-conversations';

export type { SessionConversationSummary };

export type ClosePaneDecision =
  /** Nothing to act on, or nothing that can be decided yet. */
  | { action: 'noop' }
  /**
   * The plain node write: destroy the node. Nothing else in the workspace has a
   * listing row to correct, which is what makes this the whole act.
   */
  | { action: 'close-pane' }
  /**
   * Destroy the node AND tell the caller which thread went with it, so it can
   * follow its own selection and patch the switch-decision cache. Not a second
   * request: the node write is the close, on the tree and in the listing alike.
   */
  | { action: 'close-conversation'; conversationId: string }
  /**
   * This was the workspace's last pane. Closing it would leave a session
   * holding nothing, so raise the end-session confirm instead — the same
   * confirmed, cancellable act the sidebar's own "End session" uses. NOT the
   * close: nothing is written unless the user confirms.
   */
  | { action: 'end-session' };

export function decideClosePane(params: {
  /** Every pane in the workspace — which is every pane in its tree. */
  panes: readonly PaneNode[];
  /** The node being closed. */
  nodeId: string;
  /**
   * This workspace's open conversation listings — the SWR fetch backing the pane
   * bar. `null` while it has not resolved yet: a close must never act on an
   * unverified fact.
   *
   * Typed to the ONE field this reads rather than to the whole
   * {@link SessionConversationSummary}. The two callers hold different rows
   * (the grid's carries `lastMessageAt` for the switch decision; the sidebar's
   * carries `title` for its label) and neither difference is any of this
   * function's business — asking for the union would force one of them to
   * fabricate a column to answer a question about membership.
   */
  activeConversations: readonly Pick<SessionConversationSummary, 'conversationId'>[] | null;
  /**
   * Whether this viewer may end the workspace — `DELETE /api/agent-workspaces/
   * {id}` is gated by `checkSessionEndAccess`, which is STRICTER than the
   * `checkSessionAccess` that let them reach the pane in the first place.
   *
   * Without this, a member who may use but not end a workspace would be offered
   * a confirm and then handed a failure toast for obeying it. They keep the
   * previous behaviour instead: the last pane closes and the grid is empty,
   * which is a state they can live in and someone else can end.
   */
  canEndSession: boolean;
}): ClosePaneDecision {
  const { panes, nodeId, activeConversations, canEndSession } = params;
  const node = panes.find((pane) => pane.id === nodeId);
  if (!node) return { action: 'noop' };

  // THE LAST PANE, decided before anything about what it holds.
  //
  // Before the target-kind branch, because "last pane of ANY kind" is the
  // question — `panes` is every pane in the tree, so a lone terminal or a lone
  // picker empties the workspace exactly as a lone chat does, and there is
  // nothing kind-specific to weigh.
  //
  // Before the `activeConversations === null` guard, because ending does not
  // consult the listing: it destroys the tree and the sandbox, and it is the
  // one act here that is confirmed before anything is written. Behind that
  // guard, closing the last pane while the listing was still loading would
  // silently no-op — the worst of the three outcomes, since it looks like the
  // click was ignored.
  if (panes.length === 1 && canEndSession) return { action: 'end-session' };

  // A picker, a terminal or a page pane addresses no conversation listing, so
  // this node has nothing to announce. Destroying it is the whole act.
  if (node.target === null || node.target.kind !== 'chat') return { action: 'close-pane' };

  const conversationId = node.target.id;

  // Genuinely UNKNOWN (never resolved, or the fetch failed) is not the same fact
  // as "resolved and confirmed not open". Treating it as the latter would
  // silently make this a pure layout close while the thread's listing stays open
  // server-side, lingering in the sidebar and holding a cap slot with no pane
  // left to retry the close from.
  if (activeConversations === null) return { action: 'noop' };

  // Resolved, and this thread is not in it — somebody else already closed it,
  // so there is no listing left for the caller to follow. Destroy the node and
  // be done.
  if (!activeConversations.some((entry) => entry.conversationId === conversationId)) {
    return { action: 'close-pane' };
  }

  return { action: 'close-conversation', conversationId };
}
