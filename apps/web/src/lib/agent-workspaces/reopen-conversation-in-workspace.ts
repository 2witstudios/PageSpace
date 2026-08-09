/**
 * Reopen a conversation back into its workspace — the undo of
 * `closeConversationInSessionWith`, and an ADMISSION for the same reason that
 * one is a destroy.
 *
 * **It mints a node.** There was a version of this that moved an existing one:
 * closing parked a node rather than removing it, so reopening carried the same
 * node back onto the grid. Parked is gone, so a closed thread has no node at
 * all, and putting it back is the ordinary act of taking a thread into a
 * workspace. Two consequences follow, and both are the honest ones:
 *
 *  - **The cap applies again.** A `move`-based reopen consumed no slot, because
 *    the member never stopped being one. A closed thread DID stop being one — it
 *    freed its slot on the way out — so returning consumes a slot like any other
 *    admission, and a workspace that filled up in the meantime refuses.
 *  - **A reopened thread is PLACED**, by the same policy every admission runs:
 *    it fills an unbound pane if there is one and splits rather than evicting if
 *    there is not. It does not return to where it used to sit; a node carries its
 *    location, not its history.
 *
 * **No `history_deleted` special case in the write.** A history-deleted thread's
 * node was removed by the deletion, so there is nothing here that would tell it
 * apart from a thread that was merely closed — which is exactly why the
 * `isActive` gate below survives: "you deleted this" is something a caller can
 * act on and "there is no such thread here" is not.
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

/** How the membership write answered the re-admission. */
export type ReadmitConversationOutcome = 'readmitted' | 'already_attached' | 'not_a_member' | 'refused';

export interface ReopenConversationInSessionDeps {
  /** Row facts for the ownership and history gates. Same shape the close side reads. */
  findConversation: (conversationId: string) => Promise<{
    userId: string;
    isActive: boolean;
  } | null>;
  /** THE MEMBERSHIP WRITE — `admit` the thread back into the workspace. */
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
