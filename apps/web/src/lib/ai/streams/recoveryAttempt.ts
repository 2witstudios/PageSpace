/**
 * The outcome of one `tryRecover` attempt.
 *
 * The two "answered" flags are kept separate from `recovered` because **"we recovered nothing" is
 * not the same claim as "the server told us there was nothing to recover"**:
 *
 *   answered, recovered: false  → no live run, nothing persisted. The turn really is gone, and
 *                                 regenerating it is the recovery.
 *   unanswered              → we know NOTHING. A run may still be live, or its reply may already
 *                                 be sitting in the DB.
 *
 * Collapsing those into one boolean is how a resume ends up regenerating over work that still
 * exists — and regenerating is destructive here, twice over:
 *
 *   - Every generation start takes over the conversation's in-flight streams, so a regenerate
 *     issued while a run is still live ABORTS it: its already-executed write tools run a second
 *     time, its tokens are billed and discarded, and its partial is stranded in the DB.
 *   - `handleRetry` DELETEs the trailing assistant message by id before re-requesting, and that id
 *     is the same one the server persisted the reply under. So a regenerate issued when the reply
 *     was in fact already persisted deletes the finished reply and pays for it again.
 *
 * Hence one flag per question we actually asked. Regenerating is only safe when BOTH came back.
 *
 * Returned rather than stashed in a ref: `tryRecover` has two callers (the app-resume handler and
 * useStreamRecovery's network-error retry) which can be in flight at once, and a single shared
 * slot would let one caller's probe answer the other caller's question.
 */
export interface RecoveryAttempt {
  /** A live stream was rejoined, or a persisted reply was refetched. Nothing further to do. */
  recovered: boolean;
  /** GET /active-streams reached the server AND we parsed its answer: we know what is live. */
  probeAnswered: boolean;
  /** The messages GET reached the server AND we parsed its answer: we know what is persisted. */
  dbAnswered: boolean;
}

/**
 * Regenerating is only safe once BOTH questions came back. Silence from either one means the work
 * we would be destroying might still exist.
 */
export const canConcludeTurnIsLost = (attempt: RecoveryAttempt): boolean =>
  !attempt.recovered && attempt.probeAnswered && attempt.dbAnswered;
