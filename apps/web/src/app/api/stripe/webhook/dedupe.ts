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

/**
 * How long an unfinished marker (processedAt still null) is presumed to be a live, in-flight
 * attempt. A legitimate webhook completes in well under a second; past this window the worker
 * almost certainly died mid-flight (crash, OOM, deploy) and left an orphaned marker. After the
 * lease elapses a redelivery may atomically take the marker over and reprocess, so a single
 * crash can never permanently block Stripe redeliveries (which is how funding would still be
 * lost even with the transient-fault fix). Far below Stripe's hours-long redelivery horizon.
 */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000; // 10 minutes

export type DedupeOutcome =
  /** First time we've seen this event — run the handlers. */
  | 'process'
  /** A prior delivery already processed this event to completion — ack (200), don't reprocess. */
  | 'duplicate-ack'
  /** Unknown DB error, or a prior attempt still within its lease — 500 so Stripe redelivers. */
  | 'retry'
  /** An unfinished marker older than the lease — attempt an atomic takeover, then reprocess. */
  | 'reclaim';

export interface DedupeDecisionInput {
  /** True when our insert created a fresh row (won the idempotency race). */
  inserted: boolean;
  /**
   * `processedAt` of the pre-existing row when our insert hit a duplicate key.
   * `null`/`undefined` ⇒ a prior attempt claimed the id but has not finished
   * (still in flight, failed mid-way, or abandoned by a dead worker).
   */
  existingProcessedAt?: Date | null;
  /**
   * `createdAt` of the pre-existing row — the moment the in-flight attempt claimed the id.
   * Used as the lease anchor to tell a live attempt from an abandoned one.
   */
  existingClaimedAt?: Date | null;
  /** Reference time for the lease comparison (injectable for deterministic tests). */
  now?: Date | null;
  /** Lease window in ms; defaults to {@link DEFAULT_LEASE_MS}. */
  leaseMs?: number;
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
 * - fresh insert                 → `process`        (run the handlers)
 * - duplicate, finished          → `duplicate-ack`  (200 — already processed)
 * - duplicate, unfinished, fresh → `retry`          (500 — prior attempt still in flight)
 * - duplicate, unfinished, stale → `reclaim`        (lease elapsed → atomic takeover)
 * - unexpected insert error      → `retry`          (500 — never silently ack lost funding)
 */
export function classifyDedupeOutcome({
  inserted,
  existingProcessedAt,
  existingClaimedAt,
  now,
  leaseMs = DEFAULT_LEASE_MS,
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
  // attempt already claimed this id. Ack only if that attempt actually finished.
  if (existingProcessedAt != null) {
    return 'duplicate-ack';
  }

  // Unfinished marker. If its claim is older than the lease, the worker almost certainly
  // died mid-flight — allow an atomic takeover so a single crash can't 500 every redelivery
  // forever (which would still lose funding once Stripe exhausts its retries). Within the
  // lease it is presumed genuinely in flight, so signal retry instead.
  if (existingClaimedAt != null && now != null) {
    const age = now.getTime() - existingClaimedAt.getTime();
    if (age >= leaseMs) {
      return 'reclaim';
    }
  }
  return 'retry';
}
