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

import type { ConversationCloseSubject } from './close-conversation-in-workspace';
import { announceWithoutUnsucceeding } from './close-conversation-in-workspace';

export type ReopenConversationOutcome =
  | 'reopened'
  | 'already_open'
  | 'not_in_session'
  | 'history_deleted'
  /**
   * The cap refused the return. Named rather than folded into `not_in_session`
   * because the module doc above promises the caller exactly this — "a
   * workspace that filled up in the meantime refuses" — and a caller can act on
   * it: close something, then retry. `not_in_session` is the answer that admits
   * nothing and invites no action, which is the wrong thing to say about a
   * thread that is merely one slot short of returning.
   */
  | 'session_full';

/** How the membership write answered the re-admission. */
export type ReadmitConversationOutcome =
  | 'readmitted'
  | 'already_attached'
  | 'not_a_member'
  /** The cap. Distinct from `refused` so the outcome survives the wiring. */
  | 'session_full'
  | 'refused';

export interface ReopenConversationInSessionDeps<TRow extends ConversationCloseSubject = ConversationCloseSubject> {
  /** Row facts for the ownership and history gates. Same shape the close side reads. */
  findConversation: (conversationId: string) => Promise<TRow | null>;
  /** THE MEMBERSHIP WRITE — `admit` the thread back into the workspace. */
  readmitConversation: (input: {
    conversationId: string;
    workspaceId: string;
  }) => Promise<ReadmitConversationOutcome>;
  /**
   * ANNOUNCE THE REOPEN — `conversation:reopened`. The exact mirror of
   * `announceClosed`, and missing for the same reason it was: both call sites
   * were deleted with the `closedInWorkspaceAt` repository writers that used to
   * hold them.
   *
   * The listener answers this one with a RE-READ rather than local surgery, and
   * that asymmetry is correct: a close names a row to remove and a reopen names
   * a row the cache does not have, so only one of the two can be served without
   * asking the server.
   */
  announceReopened: (row: TRow) => void;
}

export async function reopenConversationInSessionWith<TRow extends ConversationCloseSubject>(
  deps: ReopenConversationInSessionDeps<TRow>,
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
      // Only the branch that actually re-admitted. `already_attached` below is
      // a retry meeting a row that is already there — nothing changed, so
      // nothing is announced.
      announceWithoutUnsucceeding(() => deps.announceReopened(row));
      return 'reopened';
    // Already on screen: a retry, or a second tab that got there first.
    case 'already_attached':
      return 'already_open';
    // The one refusal a caller can do something about, so it keeps its name.
    case 'session_full':
      return 'session_full';
    case 'not_a_member':
    case 'refused':
      return 'not_in_session';
  }
}
