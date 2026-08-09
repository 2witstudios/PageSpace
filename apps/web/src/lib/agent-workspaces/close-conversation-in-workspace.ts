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

/**
 * The row facts this decision gates on. Deliberately the MINIMUM: the deps are
 * generic over whatever richer row the caller's read actually returns (see
 * `announceClosed`), so the production wiring can hand its emit context
 * straight through without this module having to name it.
 */
export interface ConversationCloseSubject {
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
}

export interface CloseConversationInSessionDeps<TRow extends ConversationCloseSubject = ConversationCloseSubject> {
  /**
   * Row facts for the ownership gate.
   *
   * Ownership only. "Is this thread in this workspace" is no longer a column
   * read at all — the membership write answers it from the tree, under the
   * lock, which is the only place the answer cannot go stale between the check
   * and the act.
   */
  findConversation: (conversationId: string) => Promise<TRow | null>;
  /** THE MEMBERSHIP WRITE — `destroy` the thread's node. */
  dismissConversation: (input: {
    conversationId: string;
    workspaceId: string;
  }) => Promise<DismissConversationOutcome>;
  /**
   * ANNOUNCE THE CLOSE ON THE DIRECTORY PLANE — `conversation:closed`.
   *
   * A dep rather than a caller-side follow-up because THIS function is the only
   * place that knows a close actually happened: every other answer below is a
   * refusal wearing the same shape, and a caller re-deriving "did it close" from
   * the returned string is a second copy of this switch.
   *
   * **Why it exists at all, since the membership write already broadcasts.**
   * Closing is a node `destroy`, and that write emits `workspace:nodes-updated`
   * — the TREE plane. The sidebar's rows are not the tree: `AgentsSidebar`'s
   * `conversationRows` is "keyed by the listing and never by the tree", and the
   * store the tree event feeds deliberately ignores workspaces it is not
   * already tracking. So the structural broadcast cannot, even in principle,
   * take a row out of the listing cache — only the directory event can, and
   * for the window in which nothing emitted one, a closed thread stayed in the
   * sidebar until the 120s backstop poll. Regression caught by
   * `apps/e2e/tests/18-sidebar-directory-live.spec.ts`, which blocks the
   * listing fetch at the network so that only the event can move the row.
   *
   * Fire-and-forget by contract: a broadcast that fails must not un-succeed a
   * committed close.
   */
  announceClosed: (row: TRow) => void;
}

/**
 * Make an announcement keep the promise its type already makes.
 *
 * `announceClosed` and `announceReopened` are declared fire-and-forget: a
 * broadcast that fails must not un-succeed a committed write. Both return
 * `void`, so a rejected promise is already nobody's problem — but a SYNCHRONOUS
 * throw from the injected callback is not. It propagates out of the caller and
 * turns a committed membership change into a reported failure, and the retry
 * that follows meets a workspace where the change already happened and answers
 * `not_in_session`. The user is told twice that nothing happened, about a thing
 * that happened.
 *
 * Swallowing is therefore the contract and not a shrug: the write is committed
 * before this runs, and the sidebar has a 120s backstop poll for exactly the
 * broadcast that never lands.
 */
export function announceWithoutUnsucceeding(announce: () => void): void {
  try {
    announce();
  } catch {
    // Deliberately swallowed — see above. The committed write is the outcome.
  }
}

export async function closeConversationInSessionWith<TRow extends ConversationCloseSubject>(
  deps: CloseConversationInSessionDeps<TRow>,
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
      // AFTER the write, and only on the branch that wrote. Announcing beside
      // the call would announce the refusals too, which is the failure mode
      // that reads as "the row vanished and came back".
      announceWithoutUnsucceeding(() => deps.announceClosed(row));
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
