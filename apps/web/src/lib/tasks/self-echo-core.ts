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
  /**
   * Identity of THIS write, not of the task.
   *
   * Two writes to the same task overlap easily — a double-clicked checkbox is
   * complete-then-reopen — and keying on taskId alone made the first to settle
   * erase the second's in-flight marker, so the "is anything still open?" guard
   * reported false while a write was mid-updater. Every record is addressed by
   * its own id.
   */
  readonly writeId: number;
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

/** Register a write this tab is starting. */
export const startSelfWrite = (
  records: readonly SelfWrite[],
  write: { writeId: number; taskId: string; at: number },
  now: number,
): SelfWrite[] => [...pruneSelfWrites(records, now), { ...write, updatedAt: null }];

/**
 * Resolve one write by its own id.
 *
 * A successful write keeps its record, now stamped, so the echo it will produce
 * can be recognised. A failed one is removed: leaving its record behind would
 * make every later event for that task read as our own echo for the rest of the
 * TTL.
 *
 * Removal is unconditional, including for a write that had already been stamped
 * — a settle-as-failed after a settle-as-succeeded means the cache write threw
 * AFTER the server accepted it, and `rollbackOnError` has just reverted the row
 * to its pre-write value. The server's echo carries the committed state, so it
 * is the thing that repairs the display: suppressing it as "ours" would leave
 * the stale value on screen until the next focus revalidation.
 */
export const settleSelfWrite = (
  records: readonly SelfWrite[],
  writeId: number,
  updatedAt: string | null,
  now: number,
): SelfWrite[] => {
  const pruned = pruneSelfWrites(records, now);
  if (updatedAt !== null) {
    return pruned.map((r) => (r.writeId === writeId ? { ...r, updatedAt } : r));
  }
  return pruned.filter((r) => r.writeId !== writeId);
};

/**
 * Is ANY write from this tab still unresolved?
 *
 * The deferred revalidation is view-wide, so it must not run while any write is
 * still inside its cache updater — not just the one that happened to settle.
 * Otherwise write B settling flushes the revalidation while write A is mid-flight,
 * the refetch lands first, and A's commit overwrites the foreign change it
 * fetched. That is the same race the deferral exists to prevent, one level out.
 *
 * Prunes first, so a write abandoned mid-flight (an unmount, say) stops blocking
 * revalidation once its TTL expires rather than silencing the view forever.
 */
export const hasAnyInFlightSelfWrite = (
  records: readonly SelfWrite[],
  now: number,
): boolean => pruneSelfWrites(records, now).some((r) => r.updatedAt === null);

/** Is there an unresolved write from this tab for the given task? */
export const hasInFlightSelfWrite = (
  records: readonly SelfWrite[],
  taskId: string,
): boolean => records.some((r) => r.taskId === taskId && r.updatedAt === null);

/**
 * Is this write the only one this tab has open on its task?
 *
 * Asked at PAINT time, and the answer decides whether a later failure may undo
 * itself locally. The undo restores what the paint displaced — and if another
 * write on the same row was already open, what it displaced was that write's
 * own unconfirmed paint, not anything the server ever said. Restoring it
 * fabricates a state the server has now rejected twice: double-click a
 * checkbox with the network down and the row ends up completed, with a
 * client-invented timestamp, permanently.
 */
export const isSoleInFlightWriteForTask = (
  records: readonly SelfWrite[],
  taskId: string,
  writeId: number,
): boolean => !records.some((r) => r.taskId === taskId && r.writeId !== writeId);

/**
 * Is no LATER write open on this task? Asked at failure time, for the writes
 * that started after the paint and so are invisible to the check above.
 */
export const isNewestWriteForTask = (
  records: readonly SelfWrite[],
  taskId: string,
  writeId: number,
): boolean => !records.some((r) => r.taskId === taskId && r.writeId > writeId);

/**
 * Classify an inbound event.
 *
 * - `foreign` — revalidate as before. Includes the same user in another tab,
 *   because that event's `updatedAt` matches no write this tab made.
 * - `self` — this exact write, already applied locally. Drop it.
 * - `self-in-flight` — our PATCH hasn't returned yet, so we can't compare
 *   stamps YET. Queue it: once our write settles, the same event is classified
 *   again against the now-stamped record, and only a genuinely foreign one
 *   survives to force a revalidation.
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

/**
 * Does a queue of deferred echoes still contain one we cannot account for?
 *
 * The server broadcasts BEFORE it returns the response (the PATCH route awaits
 * its realtime posts), so our own echo routinely arrives while the write is
 * still in flight and gets deferred. Re-classifying the queue once the writes
 * have settled is what tells "that was mine after all" apart from "someone else
 * edited this while I was writing" — without it every click would end in a
 * full revalidation, which is most of what this whole path exists to avoid.
 */
export const deferredEchoesNeedRevalidation = (
  records: readonly SelfWrite[],
  deferred: readonly InboundTaskEvent[],
  selfUserId: string | null | undefined,
  now: number,
): boolean => deferred.some((e) => classifyTaskEcho(records, e, selfUserId, now) === 'foreign');
