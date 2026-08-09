/**
 * Close a conversation out of its workspace's GRID — which, now that membership
 * is the node row, is a `move` to no parent.
 *
 * **What this used to be, and why the shape changed.** Closing stamped
 * `conversations.closedInWorkspaceAt`, a column that meant "not in the
 * workspace's listing", while a pane row meant "on screen". Two facts, two
 * writers, and the epic's whole complaint: the sidebar chose one, the cap
 * counted the other, and a thread could be in the workspace and invisible in
 * it. There is one fact now — where the node is — so closing changes a
 * LOCATION and nothing else. The thread stays a member, stays in the sidebar,
 * and keeps its binding.
 *
 * **The never-empty guard is gone, and its absence is a consequence.**
 * `last_conversation` refused to close a workspace's last open listing, because
 * doing so left a workspace holding nothing — the state contract invariant 3
 * forbids. A `move` cannot produce that state: every member is still a member
 * afterwards, however few of them are on screen. Closing the last thread now
 * leaves an EMPTY GRID and a workspace that still holds all its threads, which
 * is exactly what `closePane` already does to the last pane. Ending a workspace
 * stays an explicit lifecycle act on a different route.
 *
 * **What is deliberately NOT here: a `destroy`.** See `workspace-membership.ts`
 * for the full argument. In one line: the table's global chat-target uniqueness
 * is what makes a binding write-once, and a destroy frees it — so a close that
 * destroyed would let a closed thread be claimed into a DIFFERENT workspace,
 * which is a rebind reached by clicking "close". Removing a thread from a
 * workspace entirely belongs to history-deletion, which is a different act with
 * a different authorization.
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/access lives in a testable module —
 * `agent-workspaces-runtime.ts` only wires the production deps, wrapping the
 * whole decision in the workspace's own advisory lock and transaction.
 */

export type CloseConversationOutcome = 'closed' | 'already_closed' | 'not_in_session';

/** How the membership write answered a `move`. */
export type DismissConversationOutcome = 'dismissed' | 'already_parked' | 'not_a_member' | 'refused';

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
  /** THE MEMBERSHIP WRITE — `move` the thread's node out of the grid. */
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
    // A re-sent close of a thread already off the grid is idempotent, not an
    // error: it is in the state the caller asked for.
    case 'already_parked':
      return 'already_closed';
    // "This workspace does not hold that thread" and "the tree would not take
    // the move" collapse to one answer, the same shape a nonexistent id gets.
    // A caller cannot act on the difference, and an id-guessing one must not
    // learn it.
    case 'not_a_member':
    case 'refused':
      return 'not_in_session';
  }
}
