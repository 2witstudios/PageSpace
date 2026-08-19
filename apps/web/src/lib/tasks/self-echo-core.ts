/**
 * Deciding whether an inbound task socket event is our own echo.
 *
 * Every task write broadcasts back to the room the writing tab is sitting in,
 * so the tab that just PATCHed receives its own event and — before this — ran a
 * second full revalidation of the whole list on top of the one the write
 * already triggered. Dropping our own echo is most of what makes the checkbox
 * feel instant.
 *
 * `payload.userId === currentUserId` is NOT sufficient, and getting this wrong
 * is worse than the lag it fixes: the same user with the list open in two tabs
 * would have tab B silently ignore tab A's edits. The event carries no tab or
 * request id, so identity has to come from matching a write this tab actually
 * made — by task id AND the `updatedAt` the server stamped on it, which is
 * unique per write.
 */

export interface SelfWrite {
  readonly taskId: string;
  /** null while the PATCH is still in flight; set from the response when it resolves. */
  readonly updatedAt: string | null;
  /** Wall-clock ms when the record was created, for TTL pruning. */
  readonly at: number;
}

/**
 * How long a self-write stays matchable. Long enough to cover a slow broadcast
 * arriving after a slow response, short enough that a record can't suppress an
 * unrelated foreign edit minutes later.
 */
export const SELF_WRITE_TTL_MS = 30_000;

/** Backstop so a pathological session can't grow this unboundedly. */
export const MAX_SELF_WRITES = 200;

export type TaskEchoVerdict = 'self' | 'self-in-flight' | 'foreign';

export interface InboundTaskEvent {
  taskId?: string;
  userId: string;
  data?: { updatedAt?: unknown } | null;
}

export const pruneSelfWrites = (
  records: readonly SelfWrite[],
  now: number,
): SelfWrite[] => {
  const fresh = records.filter((r) => now - r.at < SELF_WRITE_TTL_MS);
  return fresh.length > MAX_SELF_WRITES ? fresh.slice(fresh.length - MAX_SELF_WRITES) : fresh;
};

/**
 * Record a write this tab is making, or resolve one that was in flight.
 *
 * Called twice per write: once before the request with `updatedAt: null`, then
 * again with the server's stamp. The second call replaces the in-flight record
 * for that task rather than appending, so a resolved write can be matched
 * exactly while an unresolved one can't be mistaken for a completed match.
 */
export const recordSelfWrite = (
  records: readonly SelfWrite[],
  write: SelfWrite,
  now: number,
): SelfWrite[] => {
  const pruned = pruneSelfWrites(records, now);
  if (write.updatedAt === null) return [...pruned, write];
  // Resolving: drop this task's in-flight placeholder, keep completed records
  // (a second write to the same task in the TTL window has its own stamp).
  const withoutInFlight = pruned.filter(
    (r) => !(r.taskId === write.taskId && r.updatedAt === null),
  );
  return [...withoutInFlight, write];
};

/**
 * Forget an unresolved write, for when the request failed.
 *
 * Without this a failed PATCH leaves a permanent in-flight record, and every
 * inbound event for that task is classified `self-in-flight` and dropped for
 * the rest of the TTL — the list would go quiet after any write error.
 */
export const dropInFlightSelfWrite = (
  records: readonly SelfWrite[],
  taskId: string,
): SelfWrite[] => records.filter((r) => !(r.taskId === taskId && r.updatedAt === null));

/** Is there an unresolved write from this tab for the given task? */
export const hasInFlightSelfWrite = (
  records: readonly SelfWrite[],
  taskId: string,
): boolean => records.some((r) => r.taskId === taskId && r.updatedAt === null);

/**
 * Classify an inbound event.
 *
 * - `foreign` — revalidate as before. Includes the same user in another tab,
 *   because that event's `updatedAt` matches no write this tab made.
 * - `self` — this exact write, already applied locally. Drop it.
 * - `self-in-flight` — our PATCH hasn't returned yet, so we can't compare
 *   stamps. Drop it, but the caller MUST remember to revalidate once the write
 *   resolves: otherwise a genuinely concurrent foreign edit that raced ours is
 *   swallowed and this tab shows stale data indefinitely.
 */
export const classifyTaskEcho = (
  records: readonly SelfWrite[],
  event: InboundTaskEvent,
  selfUserId: string | null | undefined,
  now: number,
): TaskEchoVerdict => {
  if (!event.taskId) return 'foreign';
  if (!selfUserId || event.userId !== selfUserId) return 'foreign';

  const fresh = pruneSelfWrites(records, now);
  const eventUpdatedAt = typeof event.data?.updatedAt === 'string' ? event.data.updatedAt : null;

  if (
    eventUpdatedAt !== null
    && fresh.some((r) => r.taskId === event.taskId && r.updatedAt === eventUpdatedAt)
  ) {
    return 'self';
  }

  if (hasInFlightSelfWrite(fresh, event.taskId)) return 'self-in-flight';

  return 'foreign';
};
