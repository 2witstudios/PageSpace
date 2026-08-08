/**
 * Reopen a conversation back INTO its session's listing — the undo of
 * `closeConversationInSessionWith`. Restores `conversations.closedInWorkspaceAt`
 * to null so the thread reappears in the sidebar and can host a pane again.
 * Never touches history (`isActive`) — a history-deleted thread is not
 * reachable this way, same as it is excluded from the open listing.
 *
 * Reopening occupies a listing slot exactly like minting a new conversation
 * does (`createConversationInSessionWith`'s `countActiveConversations` and
 * this decision's `countOpenConversations` count the identical set: ACTIVE
 * rows with `closedInWorkspaceAt IS NULL`) — so a session already holding
 * `MAX_SESSION_CONVERSATIONS` open listings refuses a reopen the same way it
 * refuses a new conversation, rather than silently exceeding the cap the
 * create path enforces.
 *
 * Pure decision logic over injected deps, per the repo rule that
 * branching which decides lifecycle/access lives in a testable module —
 * `agent-workspaces-runtime.ts` only wires the production deps, wrapping the
 * whole decision in the same per-session transaction + advisory lock
 * `closeConversationInSessionWith`'s wiring uses, so a reopen can never race
 * a close (or another reopen) of the same session's listings.
 */

import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';

export type ReopenConversationOutcome =
  | 'reopened'
  | 'already_open'
  | 'not_in_session'
  | 'history_deleted'
  | 'session_full';

export interface ReopenConversationInSessionDeps {
  /** Row facts for the ownership, foreign-session and idempotency checks. Same shape `closeConversationInSessionWith` reads. */
  findConversation: (conversationId: string) => Promise<{
    userId: string;
    workspaceId: string | null;
    closedInWorkspaceAt: Date | null;
    isActive: boolean;
  } | null>;
  /**
   * OPEN (not yet closed) conversations already counted against this
   * session — the cap's input. Must be read AFTER the lock is held (the
   * runtime wiring's job), or two concurrent reopens could both read
   * "room for one more" and both succeed, exceeding the cap.
   */
  countOpenConversations: (workspaceId: string) => Promise<number>;
  /**
   * The guarded UPDATE: clear `closedInWorkspaceAt` WHERE it is still set.
   * `'noop'` means a race already reopened it between the idempotency check
   * above and this write — folded into `already_open`, not an error.
   */
  reopenConversation: (conversationId: string) => Promise<'reopened' | 'noop'>;
}

export async function reopenConversationInSessionWith(
  deps: ReopenConversationInSessionDeps,
  { conversationId, userId, workspaceId }: { conversationId: string; userId: string; workspaceId: string },
): Promise<ReopenConversationOutcome> {
  const row = await deps.findConversation(conversationId);
  if (row === null || row.workspaceId !== workspaceId) return 'not_in_session';
  // OWNERSHIP, before any other branch — see the close side's gate for the
  // full reasoning. Reopening someone else's deliberately-closed thread is the
  // mirror of closing their open one: the session check above admits every
  // drive member, so only this line keeps a listing the owner dismissed from
  // being pushed back into their sidebar by anyone who can reach the session.
  if (row.userId !== userId) return 'not_in_session';
  // A history-deleted target is gone regardless of `closedInWorkspaceAt` —
  // there is no listing left to restore (mirrors the close side's own
  // isActive check, which excludes these from `countOpenConversations` too).
  if (!row.isActive) return 'history_deleted';
  if (row.closedInWorkspaceAt === null) return 'already_open';

  // Only checked once the row is confirmed CLOSED, so a retry of an
  // already-open conversation never trips the cap on its own way out.
  const openCount = await deps.countOpenConversations(workspaceId);
  if (openCount >= MAX_SESSION_CONVERSATIONS) return 'session_full';

  const outcome = await deps.reopenConversation(conversationId);
  return outcome === 'reopened' ? 'reopened' : 'already_open';
}
