/**
 * The outcome of one `tryRecover` attempt.
 *
 * `recovered` and `probeAnswered` are deliberately separate, because "we recovered nothing" is
 * NOT the same claim as "the server told us there was nothing to recover":
 *
 *   probeAnswered: true,  recovered: false  → the server answered; no live run, nothing persisted.
 *                                             The run really is gone. Regenerating is the recovery.
 *   probeAnswered: false, recovered: false  → the probe never got an answer. We know NOTHING.
 *                                             A run may well still be live.
 *
 * Collapsing those two into a single boolean is how a resume can end up regenerating over a
 * healthy generation — which, because every generation start takes over the conversation's
 * in-flight streams, ABORTS it: its already-executed write tools run a second time, its tokens are
 * billed and discarded, and its partial is stranded in the DB. Silence is not an answer.
 *
 * Returned rather than stashed in a ref: `tryRecover` has two callers (the app-resume handler and
 * useStreamRecovery's network-error retry) which can be in flight at once, and a single shared
 * slot would let one caller's probe answer the other caller's question.
 */
export interface RecoveryAttempt {
  /** A live stream was rejoined, or a persisted reply was refetched. Nothing further to do. */
  recovered: boolean;
  /** The /active-streams probe reached the server AND we parsed its answer. */
  probeAnswered: boolean;
}
