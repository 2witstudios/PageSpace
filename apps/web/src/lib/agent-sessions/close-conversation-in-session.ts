/**
 * Close a conversation OUT of its session's listing — the missing level in
 * the pane grid's model (a pane-close-lifecycle audit follow-up): session → conversation
 * (agent listing) → panes. Closing the last PANE bound to a conversation
 * should close THAT listing; only closing the session's last listing should
 * end the session.
 *
 * Closing a listing is deliberately NOT deleting history. It stamps
 * `conversations.closedInSessionAt` — a fact kept separate from `isActive`
 * (history soft-delete) on purpose, so a session-level close can never touch
 * an agent's transcript. See `packages/db/src/schema/conversations.ts` for the
 * column's full rationale.
 *
 * A session is never empty (contract invariant 3): this refuses to close the
 * session's LAST open listing (`last_conversation`) — the caller's job in that
 * case is to end the session instead, a different act on a different route.
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/access lives in a testable module —
 * `agent-sessions-runtime.ts` only wires the production deps, wrapping the
 * whole decision in a per-session transaction + advisory lock (mirroring
 * `agent-sessions-store.ts`'s `createIfUnderLimit`) so two racing closes of a
 * session's last two listings serialize rather than both reading "more than
 * one open" and both succeeding.
 */

export type CloseConversationOutcome = 'closed' | 'already_closed' | 'not_in_session' | 'last_conversation';

export interface CloseConversationInSessionDeps {
  /**
   * Row facts for the foreign-session and idempotency checks.
   * `sessionId` null or mismatched = an address that names nothing THIS
   * session owns (same "not found" shape whether the row never existed, was
   * never bound to a session, or belongs to a different one — review
   * #2261/5's uniform-404 policy, applied here too).
   */
  findConversation: (conversationId: string) => Promise<{
    sessionId: string | null;
    closedInSessionAt: Date | null;
    /**
     * History soft-delete (separate from `closedInSessionAt` — see the
     * column's own doc). A history-deleted row is excluded from
     * `countOpenConversations`, so it never occupies a countable "open
     * listing" slot — closing its (already-gone) listing can never empty
     * the session, and must not trip the never-empty guard below.
     */
    isActive: boolean;
  } | null>;
  /**
   * OPEN (not yet closed) conversations already counted against this session
   * — the never-empty guard's input. Must be read AFTER the lock is held (the
   * runtime wiring's job), or two concurrent closes of the last two listings
   * could both read "2" and both succeed.
   */
  countOpenConversations: (sessionId: string) => Promise<number>;
  /**
   * The guarded UPDATE: stamp `closedInSessionAt` WHERE it is still NULL.
   * `'noop'` means a race already closed it between the idempotency check
   * above and this write — folded into `already_closed`, not an error.
   */
  closeConversation: (conversationId: string) => Promise<'closed' | 'noop'>;
}

export async function closeConversationInSessionWith(
  deps: CloseConversationInSessionDeps,
  { conversationId, sessionId }: { conversationId: string; sessionId: string },
): Promise<CloseConversationOutcome> {
  const row = await deps.findConversation(conversationId);
  if (row === null || row.sessionId !== sessionId) return 'not_in_session';
  if (row.closedInSessionAt !== null) return 'already_closed';
  // A history-deleted target was never counted in `countOpenConversations`
  // (it's excluded there by `isActive`), so it isn't occupying a slot the
  // never-empty guard needs to protect — treat it as already gone from this
  // operation's perspective rather than letting the guard below wrongly
  // read "one unrelated listing remains" as "closing THIS one would empty
  // the session" (caught in review — a stale tab could otherwise get a 409
  // and offer to end a session that still has a genuinely live listing).
  if (!row.isActive) return 'already_closed';

  // Only a genuinely open conversation counts toward "is this the last one" —
  // checked AFTER the idempotency return above, so a retry of an already-closed
  // conversation never trips the never-empty guard on its own way out.
  const openCount = await deps.countOpenConversations(sessionId);
  if (openCount <= 1) return 'last_conversation';

  const outcome = await deps.closeConversation(conversationId);
  return outcome === 'closed' ? 'closed' : 'already_closed';
}
