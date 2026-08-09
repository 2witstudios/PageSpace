/**
 * Close a conversation out of its workspace — which, now that membership is the
 * node row and a node is only ever in the tree, is a `destroy`.
 *
 * **What this used to be, and why the shape changed twice.** Closing first
 * stamped `conversations.closedInWorkspaceAt`, a column that meant "not in the
 * workspace's listing", while a pane row meant "on screen": two facts, two
 * writers, and the epic's whole complaint. The node-tree cutover replaced that
 * with a `move` to no parent — one fact, one writer, and a thread that stayed a
 * member while sitting nowhere. That was the same split rebuilt inside the
 * model: a permanent population of parentless nodes, so a pane a user closed and
 * a pane that lost its parent to a defect were the same row and nothing could
 * tell them apart. There is one place for a node to be now, so closing a thread
 * out of a workspace REMOVES it from the workspace.
 *
 * **What that gives up, stated rather than hidden.** The table's global
 * chat-target uniqueness makes a binding write-once only for as long as the row
 * exists, and a destroy frees it — so a thread closed out of one workspace can
 * afterwards be admitted into another. Under the parked model that was called "a
 * rebind reached by clicking close" and refused. It is now the honest reading: a
 * thread whose node is gone is a member of NO workspace, and admitting a
 * member-of-nothing somewhere is an ordinary admission. The thread's history is
 * untouched either way — this writes no `conversations` row.
 *
 * **The never-empty guard is gone**, and its absence is a consequence rather
 * than an omission. `last_conversation` refused to close a workspace's last open
 * listing because doing so left a workspace holding nothing. Holding nothing is
 * an ordinary resting state: a root with no children, which `validateTree`
 * accepts. Ending a workspace is `destroy(rootId)` — an explicit target, never
 * inferred from emptiness.
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/access lives in a testable module —
 * `agent-workspaces-runtime.ts` only wires the production deps, wrapping the
 * whole decision in the workspace's own advisory lock and transaction.
 */

export type CloseConversationOutcome = 'closed' | 'already_closed' | 'not_in_session';

/** How the membership write answered the removal. */
export type DismissConversationOutcome = 'dismissed' | 'not_a_member' | 'refused';

export interface CloseConversationInSessionDeps {
  /**
   * Row facts for the ownership gate.
   *
   * Ownership only. "Is this thread in this workspace" is no longer a column
   * read at all — the membership write answers it from the tree, under the
   * lock, which is the only place the answer cannot go stale between the check
   * and the act.
   */
  findConversation: (conversationId: string) => Promise<{
    /**
     * The conversation's OWNER. Workspace access and conversation ownership are
     * different questions and neither substitutes for the other — see the
     * ownership gate in `closeConversationInSessionWith`.
     */
    userId: string;
    /**
     * History soft-delete. A history-deleted thread has no listing left to
     * close; its node is removed by the delete itself, so closing one is
     * `already_closed` rather than an act with anything to do.
     */
    isActive: boolean;
  } | null>;
  /** THE MEMBERSHIP WRITE — `destroy` the thread's node. */
  dismissConversation: (input: {
    conversationId: string;
    workspaceId: string;
  }) => Promise<DismissConversationOutcome>;
}

export async function closeConversationInSessionWith(
  deps: CloseConversationInSessionDeps,
  { conversationId, userId, workspaceId }: { conversationId: string; userId: string; workspaceId: string },
): Promise<CloseConversationOutcome> {
  const row = await deps.findConversation(conversationId);
  if (row === null) return 'not_in_session';
  // OWNERSHIP, checked before any branch can answer for a foreign row — the
  // same gate `claimConversationInSessionWith` calls its H1 line, and for the
  // same reason. The route above authorizes the WORKSPACE (`checkSessionAccess`
  // is drive-membership-wide, so any accepted member — VIEWER role included —
  // reaches another member's workspace); that is NOT ownership of the
  // CONVERSATION. Without this, any drive member could close another member's
  // private thread off their grid, and the ids are handed to them by design
  // (`list_sessions` returns other members' workspaceIds with only the title
  // redacted, and the label-free node broadcast ships every pane's targetId to
  // the whole workspace room).
  //
  // Refuses as `not_in_session` — the same shape a nonexistent id gets, so an
  // id-guessing caller cannot tell "not yours" from "not there".
  if (row.userId !== userId) return 'not_in_session';
  if (!row.isActive) return 'already_closed';

  const outcome = await deps.dismissConversation({ conversationId, workspaceId });
  switch (outcome) {
    case 'dismissed':
      return 'closed';
    // "This workspace does not hold that thread" and "the tree would not take
    // the removal" collapse to one answer, the same shape a nonexistent id gets.
    // A caller cannot act on the difference, and an id-guessing one must not
    // learn it.
    //
    // A re-sent close lands here rather than on its own `already_closed` code:
    // the first one removed the node, so the second genuinely finds no member.
    // The distinction the old `already_parked` drew — "it is already where you
    // asked" — needed a node that survived the close, and none does.
    case 'not_a_member':
    case 'refused':
      return 'not_in_session';
  }
}
