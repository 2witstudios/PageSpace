/**
 * Pure decision logic for the Stripe webhook idempotency insert.
 *
 * The webhook records each Stripe event id in `stripe_events` BEFORE processing so a
 * redelivery can be recognised. The subtle bug this isolates: a bare `catch` around that
 * insert used to treat ANY failure as "already processed" and return 200, so a transient
 * DB fault (pool timeout, dropped connection) made Stripe stop retrying — and `invoice.paid`
 * / `checkout.session.completed` funding was lost with no recovery path. A naive duplicate
 * check also acked redeliveries that raced an in-flight first attempt that later failed.
 *
 * Keeping the decision pure lets us exhaustively unit-test the four cases without a DB.
 */

/** Postgres SQLSTATE for a unique-key violation — the EXPECTED duplicate signal. */
export const PG_UNIQUE_VIOLATION = '23505';

export type DedupeOutcome =
  /** First time we've seen this event — run the handlers. */
  | 'process'
  /** A prior delivery already processed this event to completion — ack (200), don't reprocess. */
  | 'duplicate-ack'
  /** Unknown DB error, or a prior attempt that hasn't finished — 500 so Stripe redelivers. */
  | 'retry';

export interface DedupeDecisionInput {
  /** True when our insert created a fresh row (won the idempotency race). */
  inserted: boolean;
  /**
   * `processedAt` of the pre-existing row when our insert hit a duplicate key.
   * `null`/`undefined` ⇒ a prior attempt claimed the id but has not finished
   * (still in flight, or failed mid-way).
   */
  existingProcessedAt?: Date | null;
  /**
   * An error thrown by the insert. With `onConflictDoNothing()` a duplicate key never
   * throws, so any error here is an unexpected DB fault. The unique-violation check is
   * retained so the alternative "branch on 23505" insert strategy classifies correctly too.
   */
  error?: unknown;
}

/** True when `error` is a Postgres unique-key violation (a genuine duplicate, not a fault). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Decide what the webhook should do after attempting the idempotency insert.
 *
 * - fresh insert            → `process`
 * - duplicate, finished     → `duplicate-ack`  (200)
 * - duplicate, unfinished   → `retry`          (500 — prior attempt in flight/failed)
 * - unexpected insert error → `retry`          (500 — never silently ack lost funding)
 */
export function classifyDedupeOutcome({
  inserted,
  existingProcessedAt,
  error,
}: DedupeDecisionInput): DedupeOutcome {
  // Any error that is NOT a duplicate-key conflict means we never established whether the
  // event was already handled. Acking would let Stripe drop the redelivery and lose paid
  // funding, so force a retry.
  if (error != null && !isUniqueViolation(error)) {
    return 'retry';
  }

  // Our insert won the race: first time we've recorded this event.
  if (inserted) {
    return 'process';
  }

  // A duplicate (no row returned by onConflictDoNothing, or a surfaced 23505): a prior
  // attempt already claimed this id. Ack only if that attempt actually finished
  // (processedAt set); otherwise it is in flight or failed, so let Stripe redeliver
  // rather than silently acknowledging unprocessed funding.
  return existingProcessedAt != null ? 'duplicate-ack' : 'retry';
}
