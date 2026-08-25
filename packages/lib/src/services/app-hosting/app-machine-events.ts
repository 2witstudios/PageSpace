/**
 * app-machine-events — writing and reading the LOCAL MIRROR of a published app's
 * machine lifecycle.
 *
 * Fly retains only the most recent 20 events per machine, with no pagination and
 * no time window (`listMachineEvents`). About five stop/start cycles. So
 * **awake-seconds history cannot be rebuilt from Fly after the fact** and the
 * mirror is not a cache of Fly's log — it is the record, written as the boundaries
 * happen. Everything here exists to keep that record honest:
 *
 *  - `recordOrchestratorBoundary` writes OUR OWN start/stop at the moment we make
 *    the call. `autostop` is off precisely so these are the boundaries that matter.
 *  - `mirrorFlyMachineEvents` opportunistically copies Fly's own view while the
 *    last-20 window still holds it — confirmation and drift detection, and the only
 *    way a boundary we did NOT ask for (an OOM kill, a host migration) is ever seen.
 *  - `findStopBoundarySince` is the SELF-HEAL: it lets the meter discover that a
 *    machine stopped even though the row still says `running`, and close the window
 *    at the real boundary instead of billing a stopped machine until the weekly
 *    reconcile notices.
 *
 * Mirroring is BEST-EFFORT by construction. It runs after a lifecycle call has
 * already succeeded, and a failure to write an audit row must never turn a
 * successful wake into a failed one — so every function here reports rather than
 * throws, and the caller carries on.
 */

import { and, desc, eq, gt, gte, inArray, lte, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { publishedAppMachineEvents } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import { classifyFlyEventAction, flyEventInstant } from './app-metering-core';
import type { MachineEvent } from '../fly/flaps-client';

export interface MachineBoundaryRef {
  publishedAppId: string;
  flyAppName: string;
  machineId: string;
}

/**
 * Record an awake boundary WE caused, at the instant we caused it.
 *
 * Written unconditionally — including for a call whose effect was a no-op (Fly's
 * start and stop are idempotent, so a second start against an already-running
 * machine changes nothing). That is deliberate: the row says "we asked for this at
 * this time", which is the fact the reconcile needs, and suppressing the no-ops
 * would make the mirror silently disagree with the calls we actually made.
 *
 * Never throws. Returns false when the row could not be written, so the caller can
 * count a mirror gap rather than mistake it for an absent boundary.
 */
export async function recordOrchestratorBoundary(
  ref: MachineBoundaryRef,
  action: 'start' | 'stop',
  occurredAt: Date,
): Promise<boolean> {
  try {
    await db.insert(publishedAppMachineEvents).values({
      publishedAppId: ref.publishedAppId,
      flyAppName: ref.flyAppName,
      machineId: ref.machineId,
      origin: 'orchestrator',
      action,
      occurredAt,
    });
    return true;
  } catch (error) {
    // The severity is real and the response is still "carry on": the machine has
    // already started or stopped, and refusing to proceed because an audit row
    // failed would leave the far more dangerous state (a live machine with no
    // status of its own). Logged loudly because a persistent failure here means
    // the primary billing record is not being written.
    loggers.ai.error(
      'Published-app machine boundary could not be mirrored — this awake boundary is not recoverable from Fly',
      error instanceof Error ? error : new Error(String(error)),
      { publishedAppId: ref.publishedAppId, machineId: ref.machineId, action },
    );
    return false;
  }
}

export interface MirrorFlyEventsResult {
  /** Events Fly returned that we recognised as awake boundaries. */
  boundaries: number;
  /** Rows actually inserted — lower than `boundaries` when the window still held events we had already mirrored. */
  inserted: number;
  /** The read or the write failed; nothing (or only part) was mirrored this pass. */
  failed: boolean;
}

/**
 * Copy Fly's own event log for one machine into the mirror, idempotently.
 *
 * Called right after our own start/stop, while the last-20 window is guaranteed to
 * contain the event Fly logged for that call. Only events that classify as an
 * awake boundary are stored: Fly's event vocabulary is open, and a type we do not
 * recognise must fold to "not a boundary" rather than be guessed at — a fabricated
 * boundary in the one table that cannot be rebuilt is worse than a missing one.
 *
 * Idempotency is the database's, not ours: the partial unique index on
 * `(machineId, flyEventId)` makes re-mirroring the same window a no-op, so this
 * can be called as often as it is useful without accumulating duplicates.
 */
export async function mirrorFlyMachineEvents(
  ref: MachineBoundaryRef,
  events: readonly MachineEvent[],
): Promise<MirrorFlyEventsResult> {
  const rows = events.flatMap((event) => {
    const action = classifyFlyEventAction(typeof event.type === 'string' ? event.type : undefined);
    const occurredAt = flyEventInstant(event.timestamp);
    // An event with no usable id cannot be de-duplicated, and one with no usable
    // instant would be dated to the epoch — which the reconcile would read as a
    // decades-long awake window. Both are dropped rather than stored wrong.
    if (action === null || occurredAt === null || typeof event.id !== 'string' || event.id === '') return [];
    return [{
      publishedAppId: ref.publishedAppId,
      flyAppName: ref.flyAppName,
      machineId: ref.machineId,
      origin: 'fly' as const,
      action,
      flyEventId: event.id,
      flyEventType: typeof event.type === 'string' ? event.type : null,
      flyEventStatus: typeof event.status === 'string' ? event.status : null,
      occurredAt,
    }];
  });
  if (rows.length === 0) return { boundaries: 0, inserted: 0, failed: false };
  try {
    const inserted = await db
      .insert(publishedAppMachineEvents)
      .values(rows)
      .onConflictDoNothing({
        target: [publishedAppMachineEvents.machineId, publishedAppMachineEvents.flyEventId],
        // The index is PARTIAL, and Postgres only infers a partial index as the
        // ON CONFLICT arbiter when its predicate is restated here (the same
        // requirement `credit_ledger_stripe_ref_unique` documents in
        // credit-gate.ts). Omit it and the statement finds no arbiter and throws,
        // turning every re-mirror into a mirroring outage.
        where: sql`${publishedAppMachineEvents.flyEventId} IS NOT NULL`,
      })
      .returning({ id: publishedAppMachineEvents.id });
    return { boundaries: rows.length, inserted: inserted.length, failed: false };
  } catch (error) {
    loggers.ai.error(
      'Published-app Fly event mirror failed — confirmation for these boundaries is lost once the last-20 window rolls',
      error instanceof Error ? error : new Error(String(error)),
      { publishedAppId: ref.publishedAppId, machineId: ref.machineId, boundaries: rows.length },
    );
    return { boundaries: rows.length, inserted: 0, failed: true };
  }
}

/**
 * The most recent STOP boundary for this machine strictly after `since`, from
 * either origin — the meter's self-heal.
 *
 * A row can be left saying `running` while its machine is not: a stop call that
 * succeeded at Fly and then crashed before the status write, or a machine Fly took
 * down on its own. Both would otherwise bill a stopped machine every tick until the
 * weekly reconcile. This is how the meter finds the real boundary and closes the
 * window at it instead.
 *
 * Deliberately takes the LATEST such stop rather than the earliest: between `since`
 * and now the machine may have stopped, been restarted by a wake we did record, and
 * stopped again. Closing at the earliest would forgive real awake time in between;
 * the latest is the boundary the window is actually still open past.
 *
 * Only STOPS after a start are meaningful here — a stop preceding this window's
 * start belongs to the previous window — which is what `since` (the billing
 * watermark, itself never earlier than the wake) enforces.
 */
export async function findStopBoundarySince(
  machineId: string,
  since: Date,
  now: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ occurredAt: publishedAppMachineEvents.occurredAt })
    .from(publishedAppMachineEvents)
    .where(
      and(
        eq(publishedAppMachineEvents.machineId, machineId),
        eq(publishedAppMachineEvents.action, 'stop'),
        gt(publishedAppMachineEvents.occurredAt, since),
        // A boundary dated in the future (clock skew between containers) must not
        // close a window early and forgive real awake time.
        lte(publishedAppMachineEvents.occurredAt, now),
      ),
    )
    .orderBy(desc(publishedAppMachineEvents.occurredAt))
    .limit(1);
  return row?.occurredAt ?? null;
}

/**
 * Every awake boundary this app crossed inside a window, oldest first — the local
 * side of the weekly `fly_instance_up` comparison.
 *
 * Both origins are read together and treated as one stream. They are separate ROWS
 * because they answer different questions, but for "was this machine up?" our own
 * start and Fly's logged start are the same crossing seen twice, and
 * `awakeSecondsFromEvents` already ignores a start while started and a stop while
 * stopped — so the duplication collapses in the arithmetic rather than needing a
 * lossy de-duplication here.
 */
export async function listBoundaryEvents(
  publishedAppId: string,
  from: Date,
  until: Date,
): Promise<Array<{ action: 'start' | 'stop'; occurredAt: Date }>> {
  const rows = await db
    .select({
      action: publishedAppMachineEvents.action,
      occurredAt: publishedAppMachineEvents.occurredAt,
    })
    .from(publishedAppMachineEvents)
    .where(
      and(
        eq(publishedAppMachineEvents.publishedAppId, publishedAppId),
        gte(publishedAppMachineEvents.occurredAt, from),
        lte(publishedAppMachineEvents.occurredAt, until),
        inArray(publishedAppMachineEvents.action, ['start', 'stop']),
      ),
    )
    .orderBy(publishedAppMachineEvents.occurredAt);
  // The column is a plain text column with a CHECK, so narrow at the boundary
  // rather than casting: an unexpected value is dropped, never billed as a start.
  return rows.flatMap((row) =>
    row.action === 'start' || row.action === 'stop'
      ? [{ action: row.action, occurredAt: row.occurredAt }]
      : [],
  );
}
