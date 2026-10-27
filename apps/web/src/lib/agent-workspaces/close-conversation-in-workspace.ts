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
 * Read a membership write's answer as a dismissal or a refusal — POSITIVELY
 * narrowed, which is the whole point of it existing as a function.
 *
 * The wiring used to narrow away `refused` and `stale` inline and let
 * everything else fall through to `dismissed`. That fallthrough covered `ok`
 * **and** `conflict`, and a conflict is a ROLLED-BACK write: the route answered
 * 200 "closed" and wrote a `data.write` audit event for a close that never
 * happened. Latent rather than live — a pure destroy introduces no binding, so
 * it cannot currently raise the chat-target conflict — but it is exactly the
 * class `commitUnderLock` documents at length, and both neighbouring call sites
 * already guard it (`admitConversationNode` handles `conflict` explicitly,
 * `expelConversationFromSession` is exhaustive-safe via `if (status === 'ok')`).
 *
 * Lives here, beside the type it produces, so it is testable without the
 * database the wiring is bolted to.
 */
export function dismissOutcomeOf(result: { status: string; code?: string }): DismissConversationOutcome {
  if (result.status === 'ok') return 'dismissed';
  if (result.status === 'refused' && result.code === 'not_a_member') return 'not_a_member';
  return 'refused';
}

/**
 * The row facts this decision gates on, and now the WHOLE row it reads.
 *
 * The deps used to be generic over whatever richer row the caller's read
 * returned, so `announceClosed` could be handed its emit context without this
 * module naming it. That dep is gone — the write funnel announces — so these
 * two columns are the entire input, and a generic that abstracts over nothing
 * would only make a reader look for the part that uses it.
 */
export interface ConversationCloseSubject {
  /**
   * The conversation's OWNER. Workspace access and conversation ownership are
   * different questions and neither substitutes for the other — see the
   * ownership gate in `closeConversationInSessionWith`.
   */
  userId: string;
  /**
   * History soft-delete. A history-deleted thread has no listing left to close,
   * so once the membership write confirms there is no node either, the answer
   * is `already_closed`. It is read AFTER that write, never instead of it — see
   * the comment on the `dismissConversation` call.
   */
  isActive: boolean;
}

export interface CloseConversationInSessionDeps {
  /**
   * Row facts for the ownership gate.
   *
   * Ownership only. "Is this thread in this workspace" is no longer a column
   * read at all — the membership write answers it from the tree, under the
   * lock, which is the only place the answer cannot go stale between the check
   * and the act.
   */
  findConversation: (conversationId: string) => Promise<ConversationCloseSubject | null>;
  /**
   * THE MEMBERSHIP WRITE — `destroy` the thread's node.
   *
   * **It announces, too, and that is why there is no `announceClosed` dep.**
   * The directory plane still has to hear about a close: closing is a node
   * `destroy`, whose `workspace:nodes-updated` carries the TREE, while the
   * sidebar's rows come from the LISTING (`AgentsSidebar`'s `conversationRows`
   * is "keyed by the listing and never by the tree", and the store the tree
   * event feeds deliberately ignores workspaces it is not already tracking), so
   * the structural broadcast cannot take a row out of the listing cache.
   * Regression caught by `apps/e2e/tests/18-sidebar-directory-live.spec.ts`,
   * which blocks the listing fetch at the network so that only the event can
   * move the row.
   *
   * What changed is WHERE that announcement is made. It used to be a dep here,
   * on the theory that this function is the only place that knows a close
   * happened — true of this ROUTE, and false of the workspace. Membership is
   * the node, so a chat node leaving the tree is the thread leaving the
   * workspace however it left: a pane drop, the sidebar's row drop, an agent
   * tool's close, an end-session. Only one of those ever came through here, so
   * the announcement fired for one producer out of four. It is emitted from the
   * write funnel now (`commitUnderLock` → `announceClosedConversations`), which
   * every one of them passes through, and keeping a dep here as well would
   * double-emit for this one.
   */
  dismissConversation: (input: {
    conversationId: string;
    workspaceId: string;
  }) => Promise<DismissConversationOutcome>;
}

/**
 * Make an announcement keep the promise its type already makes.
 *
 * The directory announcements — `announceReopened` here, and the write funnel's
 * own `announceClosedConversations` — are declared fire-and-forget: a broadcast
 * that fails must not un-succeed a committed write. Both return
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

  // ATTEMPTED REGARDLESS OF `isActive`, and the order is the fix.
  //
  // A history-deleted thread has no listing left to close, so this used to
  // return `already_closed` right here, BEFORE the write — and the route
  // answers 200 `{ok: true}` for it. That is only sound if a dead thread never
  // has a node, which is exactly the state a FAILED expel leaves behind:
  // `expelConversationFromSession` logs and returns `refused` when the
  // membership write does not land, the soft-delete proceeds anyway, and the
  // node survives bound to a dead thread. Every later close then answered
  // "already closed, nothing to do" having written nothing, so the pane was
  // unclosable and said so in the only way a success can — silently.
  //
  // Attempting the write costs a dead thread one indexed lookup that answers
  // `not_a_member`, and repairs the one case where it does not. Nothing is owed
  // to the directory plane either way: the `deleted` event already fired.
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
    //
    // The ONE exception is the history-deleted thread, and it is where
    // `already_closed` now lives: no listing, no node, nothing to do, and the
    // caller already passed the ownership gate above so this discloses nothing
    // a guesser could use. Reaching it through the write rather than ahead of
    // it is the whole point — a dead thread that DOES still have a node gets
    // that node removed and answers `closed`, where the old ordering answered
    // "already closed" and wrote nothing, forever.
    case 'not_a_member':
      return row.isActive ? 'not_in_session' : 'already_closed';
    case 'refused':
      return 'not_in_session';
  }
}
