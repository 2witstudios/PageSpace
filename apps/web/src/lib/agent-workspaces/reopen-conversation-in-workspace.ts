/**
 * Reopen a conversation back onto its workspace's grid — the undo of
 * `closeConversationInSessionWith`, and a `move` for the same reason.
 *
 * **It mints nothing.** The node never stopped existing, so reopening carries
 * it back into the grid rather than creating anything. Two consequences follow,
 * and both are simplifications rather than compromises:
 *
 *  - **No cap check.** The old version refused a reopen when the workspace held
 *    `MAX_SESSION_CONVERSATIONS` open listings, because reopening restored a
 *    listing slot the close had freed. A member that never stopped being a
 *    member frees no slot when it is closed and consumes none when it returns,
 *    so the ceiling has nothing to say here. The cap now bounds MEMBERSHIP, and
 *    is enforced where membership is created (`admit`).
 *  - **No `history_deleted` special case in the write.** A history-deleted
 *    thread has no node — deletion removes it — so there is nothing to move,
 *    and the membership write says so. The `isActive` gate below survives only
 *    to give that answer its own name, because "you deleted this" is something
 *    a caller can act on and "there is no such thread here" is not.
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/access lives in a testable module —
 * `agent-workspaces-runtime.ts` only wires the production deps, wrapping the
 * whole decision in the workspace's own advisory lock and transaction.
 */

export type ReopenConversationOutcome =
  | 'reopened'
  | 'already_open'
  | 'not_in_session'
  | 'history_deleted';

/** How the membership write answered a `move` back into the grid. */
export type ReadmitConversationOutcome = 'readmitted' | 'already_attached' | 'not_a_member' | 'refused';

export interface ReopenConversationInSessionDeps {
  /** Row facts for the ownership and history gates. Same shape the close side reads. */
  findConversation: (conversationId: string) => Promise<{
    userId: string;
    isActive: boolean;
  } | null>;
  /** THE MEMBERSHIP WRITE — `move` the thread's node back into the grid. */
  readmitConversation: (input: {
    conversationId: string;
    workspaceId: string;
  }) => Promise<ReadmitConversationOutcome>;
}

export async function reopenConversationInSessionWith(
  deps: ReopenConversationInSessionDeps,
  { conversationId, userId, workspaceId }: { conversationId: string; userId: string; workspaceId: string },
): Promise<ReopenConversationOutcome> {
  const row = await deps.findConversation(conversationId);
  if (row === null) return 'not_in_session';
  // OWNERSHIP, before any other branch — see the close side's gate for the
  // full reasoning. Putting someone else's deliberately-closed thread back on
  // their grid is the mirror of taking their open one off it: the workspace
  // check above admits every drive member, so only this line stands between a
  // thread its owner dismissed and anyone who can reach the workspace.
  if (row.userId !== userId) return 'not_in_session';
  // A history-deleted target is gone regardless of where its node was — and
  // its node is gone too. Named separately from `not_in_session` because this
  // one tells the caller something they can act on.
  if (!row.isActive) return 'history_deleted';

  const outcome = await deps.readmitConversation({ conversationId, workspaceId });
  switch (outcome) {
    case 'readmitted':
      return 'reopened';
    // Already on screen: a retry, or a second tab that got there first.
    case 'already_attached':
      return 'already_open';
    case 'not_a_member':
    case 'refused':
      return 'not_in_session';
  }
}
