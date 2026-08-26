/**
 * awake-meter — the HEARTBEAT settle for published apps: every awake app's
 * accrued seconds, billed on a cadence rather than only at stop.
 *
 * WHY A HEARTBEAT AT ALL. Settling only at stop makes the whole of an app's awake
 * time a single unbilled liability until something closes it — and the thing that
 * closes it is a process that can crash, a Fly call that can fail, and a status
 * write that can be lost. A published app can stay up for weeks. Heartbeat
 * settling bounds that exposure to one tick, which is the same reason the realtime
 * shell handler settles a live PTY every ten minutes rather than at hangup.
 *
 * THREE THINGS EACH TICK, per row:
 *   1. REPAIR. If the mirror holds a stop boundary after this row's watermark, the
 *      machine already stopped and its status write was lost. Settle up to the REAL
 *      boundary and close the window there — never bill a stopped machine to now.
 *   2. SETTLE. Otherwise bill the accrued seconds and advance the watermark
 *      monotonically.
 *   3. RE-GATE. `trackUsage` consumes the wake's hold, so a settled window has no
 *      live reservation. Re-hold immediately; a refusal means the payer is out of
 *      credits, and the app is STOPPED AND PARKED — enforcement is "don't keep it
 *      awake", the running counterpart of the wake gate's "don't wake".
 *
 * NEVER THROWS out of `meterAwakePublishedApps`: every row is isolated, and the row
 * source's own failure is reported as a value. One app's bad state must not stop
 * the fleet from billing.
 *
 * Dark behind `APP_HOSTING_ENABLED`: a disabled deployment reports `disabled` and
 * reads nothing.
 */

import { and, eq, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import { isAppHostingEnabled } from './app-hosting-env';
import { defaultAppBillingDeps, type AppBillingDeps } from './app-billing';
import { findStopBoundarySince } from './app-machine-events';
import { planAwakeSettle } from './app-metering-core';
import {
  closeAppWindowAtBoundary,
  defaultAppLifecycleMeteringDeps,
  stopPublishedApp,
  type AppLifecycleMeteringDeps,
  type SettleAndCloseResult,
} from './app-lifecycle-metering';

/**
 * What a watermark write did.
 *
 * TWO answers, not the storage reconcile's three: this write is a compare-and-set
 * over "still running, window still open", so every way of losing that race —
 * a newer wake, a stop that closed the window, a destroyed row — is the same fact
 * to the caller, that somebody else owns this window now. Distinguishing a
 * vanished row from a stopped one would cost a second query per settle and change
 * nothing about what the caller then does (release the reservation it placed).
 */
export type AwakeWatermarkOutcome = 'advanced' | 'superseded';

export interface AwakeMeterDeps {
  isEnabled: () => boolean;
  billing: AppBillingDeps;
  /** Every app believed AWAKE. `running` is that belief; the repair step is what checks it. */
  listRunningApps: () => Promise<PublishedApp[]>;
  /** The mirror's latest stop boundary strictly after `since` — the repair signal. */
  findStopBoundary: (machineId: string, since: Date, now: Date) => Promise<Date | null>;
  /** Advance the watermark and install the re-hold in ONE statement, monotonically. */
  writeSettle: (input: {
    publishedAppId: string;
    billedThrough: Date;
    holdId: string | null;
  }) => Promise<AwakeWatermarkOutcome>;
  /**
   * Open a window on a `running` row that has none — stamps the clock at NOW,
   * bills nothing. Answers `superseded` when the row acquired a window while this
   * tick was working, in which case the caller's hold covers nothing and is
   * released rather than left to expire.
   */
  stampWindowStart: (input: {
    publishedAppId: string;
    at: Date;
    holdId: string | null;
  }) => Promise<'stamped' | 'superseded'>;
  /** Settle the tail and close the window at a boundary the mirror already knows. */
  closeAtBoundary: (row: PublishedApp, boundary: Date) => Promise<SettleAndCloseResult>;
  /** Stop + park an app whose payer has run out of credits. */
  parkInsolvent: (publishedAppId: string) => Promise<void>;
  now: () => Date;
}

export const defaultAwakeMeterDeps: AwakeMeterDeps = {
  isEnabled: isAppHostingEnabled,
  billing: defaultAppBillingDeps,

  async listRunningApps() {
    return db.select().from(publishedApps).where(eq(publishedApps.status, 'running'));
  },

  findStopBoundary: (machineId, since, now) => findStopBoundarySince(machineId, since, now),

  /**
   * MONOTONIC, and the guard is load-bearing rather than defensive: a tick captures
   * one `now` and then makes several awaits per row, so a wake landing inside that
   * span resets `awakeBilledThrough` FORWARD to its own instant. An unguarded write
   * would drag the watermark back over that reset and re-bill the span between them
   * on the next tick. `GREATEST` in the SET (not a `WHERE ... <= ...` predicate) so
   * "the guard declined" and "the row is gone" stay distinguishable — the same
   * shape, and the same scar, as the storage reconcile's watermark write.
   *
   * The re-hold rides along in the same statement because a hold recorded without
   * the watermark that justifies it, or vice versa, is a reservation nothing will
   * ever settle or release.
   */
  async writeSettle({ publishedAppId, billedThrough, holdId }) {
    const watermark = sql.param(billedThrough, publishedApps.awakeBilledThrough);
    const [row] = await db
      .update(publishedApps)
      .set({
        awakeBilledThrough: sql`GREATEST(${publishedApps.awakeBilledThrough}, ${watermark})`,
        // The hold is guarded on the SAME condition as the watermark it rides
        // with, not written unconditionally. If a wake has already carried this
        // row past our tick, that wake owns the window AND the reservation
        // covering it; overwriting `awakeHoldId` here would strand the wake's
        // hold — never settled, never released, suppressing the payer's
        // spendable balance for its whole TTL — and leave the new window
        // settling against a reservation made for a window that no longer
        // exists. `GREATEST` decides the watermark, so the same comparison has
        // to decide the hold.
        awakeHoldId: sql`CASE WHEN ${publishedApps.awakeBilledThrough} <= ${watermark} THEN ${sql.param(holdId, publishedApps.awakeHoldId)} ELSE ${publishedApps.awakeHoldId} END`,
      })
      // A COMPARE-AND-SET over the window this tick actually metered, not an
      // id-only write. A stop can land between this tick's read and this write:
      // it sets `status = stopped` and NULLs the watermark, and an unguarded
      // update would then compute `GREATEST(NULL, billedThrough)` and REOPEN a
      // billing window on a stopped row — installing a hold that no later tick
      // can ever settle or release, because `listRunningApps` only sees
      // `running`. Requiring the row to still be running with a window open
      // makes the stop the unambiguous winner and turns this into a clean
      // `superseded`, whose caller releases the reservation.
      .where(
        and(
          eq(publishedApps.id, publishedAppId),
          eq(publishedApps.status, 'running'),
          isNotNull(publishedApps.awakeBilledThrough),
        ),
      )
      .returning({ awakeBilledThrough: publishedApps.awakeBilledThrough });
    // No row matched the CAS: stopped, parked or destroyed under us.
    if (!row?.awakeBilledThrough) return 'superseded';
    return row.awakeBilledThrough.getTime() > billedThrough.getTime() ? 'superseded' : 'advanced';
  },

  /**
   * Opens a window on a row that has NONE, and only on such a row — the
   * `awakeBilledThrough IS NULL` predicate is the guard, not a redundancy.
   *
   * The tick captures one clock and then makes several awaits per row, so a wake
   * landing inside that span opens its own window at an instant LATER than this
   * tick's `now`. An unguarded write would drag that fresh watermark backward and
   * hand the next tick a span to re-bill, while replacing the wake's hold with
   * one placed for a window that never existed.
   */
  async stampWindowStart({ publishedAppId, at, holdId }) {
    const [row] = await db
      .update(publishedApps)
      .set({ awakeBilledThrough: at, awakeHoldId: holdId, lastWakeAt: sql`COALESCE(${publishedApps.lastWakeAt}, ${sql.param(at, publishedApps.lastWakeAt)})` })
      .where(and(eq(publishedApps.id, publishedAppId), isNull(publishedApps.awakeBilledThrough)))
      .returning({ id: publishedApps.id });
    return row ? 'stamped' : 'superseded';
  },

  closeAtBoundary: (row, boundary) => closeAppWindowAtBoundary(row, boundary, defaultAppLifecycleMeteringDeps),

  async parkInsolvent(publishedAppId) {
    await stopPublishedApp(publishedAppId, 'insolvent');
  },

  now: () => new Date(),
};

export interface MeterAwakeResult {
  processed: number;
  /** Rows that billed awake seconds this tick. */
  settled: number;
  /** Rows whose window was closed at a mirrored stop boundary — a lost stop, repaired. */
  repaired: number;
  /** `running` rows carrying no window at all. Their clock is started at NOW and nothing is billed for the unknown span. */
  stamped: number;
  /** Rows with an open window and no elapsed time (a back-to-back rerun). */
  skipped: number;
  /** Rows left unbilled because the owning drive could not be resolved — retried next tick. */
  unresolvedPayer: number;
  /** Rows stopped and parked because the payer ran out of credits at the re-gate. */
  parked: number;
  /**
   * Rows where the span was NOT billed — something threw, or the settle resolved
   * without persisting a usage row. Isolated either way; the window is left open so
   * the span is retried on the next tick, which is safe precisely because nothing
   * was written.
   *
   * The non-persisted case used to be invisible: `trackUsage` returned
   * `Promise<void>` and swallowed its own failures, so a lost charge was counted as
   * `settled` and its watermark advanced over it.
   */
  failed: number;
  /** Settles whose span exceeded {@link MAX_AWAKE_SETTLE_SPAN_MS} and was shortened — expected to be ZERO in steady state. */
  clamped: number;
  /**
   * Window writes this tick declined to make — a wake had already carried the row
   * past this tick's `now` (or the row is gone), so that wake owns the window.
   * The reservation this tick placed is released rather than stranded.
   */
  watermarkSuperseded: number;
  /**
   * Rows that billed but whose watermark write then failed — money moved and the
   * window did not close, so this span WILL be billed again next tick. The
   * opposite of `failed`, and worth distinguishing for exactly that reason.
   */
  settledButUnadvanced: number;
  totalAwakeSeconds: number;
  /** The row source itself failed; nothing was metered this tick and everything accrues for the next. */
  sourceFailed: boolean;
}

const EMPTY_RESULT: MeterAwakeResult = {
  processed: 0,
  settled: 0,
  repaired: 0,
  stamped: 0,
  skipped: 0,
  unresolvedPayer: 0,
  parked: 0,
  failed: 0,
  clamped: 0,
  watermarkSuperseded: 0,
  settledButUnadvanced: 0,
  totalAwakeSeconds: 0,
  sourceFailed: false,
};

export type MeterAwakeRun = { outcome: 'disabled' } | ({ outcome: 'metered' } & MeterAwakeResult);

/**
 * Settle every awake published app's accrued seconds.
 *
 * NEVER THROWS. The row source's failure is a value (`sourceFailed`), and every
 * row is isolated — one app whose payer lookup or Fly state is broken must not
 * stop the rest of the fleet from being billed, exactly as one unreadable row
 * source must not stop the storage meter.
 */
export async function meterAwakePublishedApps(
  deps: AwakeMeterDeps = defaultAwakeMeterDeps,
): Promise<MeterAwakeRun> {
  if (!deps.isEnabled()) return { outcome: 'disabled' };

  const result: MeterAwakeResult = { ...EMPTY_RESULT };
  let rows: PublishedApp[];
  try {
    rows = await deps.listRunningApps();
  } catch (error) {
    loggers.ai.error(
      'Published-app awake meter could not list running apps — nothing was metered this tick',
      error instanceof Error ? error : new Error(String(error)),
    );
    return { outcome: 'metered', ...result, sourceFailed: true };
  }

  // ONE clock for the whole tick, captured before any await — a tick is a
  // snapshot, and a row metered against a later clock than its neighbour would
  // make two rows' windows overlap at the seam.
  const now = deps.now();
  result.processed = rows.length;

  for (const row of rows) {
    try {
      await meterOneApp(row, now, deps, result);
    } catch (error) {
      result.failed += 1;
      loggers.ai.error(
        'Published-app awake meter failed for one app — its window stays open and is retried next tick',
        error instanceof Error ? error : new Error(String(error)),
        { publishedAppId: row.id, driveId: row.driveId },
      );
    }
  }
  return { outcome: 'metered', ...result };
}

async function meterOneApp(
  row: PublishedApp,
  now: Date,
  deps: AwakeMeterDeps,
  result: MeterAwakeResult,
): Promise<void> {
  // 1. NO WINDOW. The row says running and carries no watermark — a wake whose
  // stamp was lost, or a machine started outside the wake seam. Start the clock at
  // NOW and bill nothing: an unknown window start must cost the payer nothing
  // rather than an invented amount. A hold is placed with it so the very next tick
  // settles against a real reservation.
  if (row.awakeBilledThrough === null) {
    const payerId = await deps.billing.resolvePayerId({ driveId: row.driveId });
    if (!payerId) {
      result.unresolvedPayer += 1;
      return;
    }
    const gate = await deps.billing.gate({ payerId });
    if (!gate.allowed) {
      await deps.parkInsolvent(row.id);
      result.parked += 1;
      return;
    }
    const stamp = await deps.stampWindowStart({ publishedAppId: row.id, at: now, holdId: gate.holdId ?? null });
    if (stamp === 'superseded') {
      // A wake opened the window while we were gating. It owns both the window
      // and a reservation for it, so ours covers nothing — return it rather than
      // leaving it to suppress the payer's balance until its TTL.
      if (gate.holdId) await deps.billing.releaseHold(gate.holdId);
      result.watermarkSuperseded += 1;
      return;
    }
    result.stamped += 1;
    return;
  }

  // 2. REPAIR. The mirror is the source of truth for boundaries, so a stop
  // recorded after this row's watermark means the machine is already down and
  // only the status write was lost. Settle up to the REAL boundary and close the
  // window there — billing through `now` would charge for the span between a stop
  // we did not notice and the moment we did.
  // A `running` row always has a machine (`published_apps_running_requires_machine`),
  // so this is unreachable — but a row with no machine has no boundaries to find
  // and must not be handed an empty id that silently matches nothing.
  const boundary = row.machineId
    ? await deps.findStopBoundary(row.machineId, row.awakeBilledThrough, now)
    : null;
  if (boundary) {
    const closed = await deps.closeAtBoundary(row, boundary);
    result.repaired += 1;
    if (closed.failed) result.failed += 1;
    else {
      result.totalAwakeSeconds += closed.billedSeconds;
      if (closed.billedSeconds > 0) result.settled += 1;
    }
    return;
  }

  // 3. ORDINARY SETTLE.
  const plan = planAwakeSettle({ billedThrough: row.awakeBilledThrough, now });
  if (plan.action !== 'settle') {
    // `stamp` is unreachable here (the null case returned above); `skip` is a
    // back-to-back rerun or a watermark ahead of this tick's clock.
    result.skipped += 1;
    return;
  }

  const payerId = await deps.billing.resolvePayerId({ driveId: row.driveId });
  if (!payerId) {
    // Leave the watermark alone so the span keeps accruing and is billed in full
    // once the drive resolves — or is torn down with the row. Never substitute a
    // payer: a misdirected charge cannot be taken back, a skipped tick corrects
    // itself.
    result.unresolvedPayer += 1;
    return;
  }

  const settle = await deps.billing.trackUsage({
    payerId,
    holdId: row.awakeHoldId ?? undefined,
    activeSeconds: plan.activeSeconds,
    driveId: row.driveId,
    publishedAppId: row.id,
  });
  if (!settle.persisted) {
    // The settle resolved but reported NO persisted usage row, so nothing — not the
    // ledger, not the backfill cron, which reads `ai_usage_logs` — will ever bill
    // this span. Leave the watermark alone: the window stays open and the next tick
    // re-bills the whole span, and the only alternative is losing the charge
    // outright.
    //
    // "Nothing was CONFIRMED written", not "nothing was written": a connection
    // dropped at the commit boundary reports a failed write over a row that
    // committed, and the retry then bills the span twice. Bounded at ONE duplicate
    // span; the deterministic per-window idempotency key that would close it is a
    // filed follow-up. The re-gate below is skipped with
    // it — the seam already returned this wake's reservation on its way out, so the
    // next tick settles the retried span unreserved and re-gates after it. That is
    // one tick of unreserved spend, bounded by the settle cadence, and strictly
    // better than closing the window over a charge nobody will ever make.
    //
    // Counted as `failed` rather than thrown: this function is run under the
    // meter's advisory lock and a throw here would be caught by the per-row guard
    // anyway — a counted failure keeps the tick's accounting honest without
    // pretending an exception happened.
    //
    // NOT gated on `creditsSettled`: a persisted row whose ledger settle was
    // deferred is already owned by the backfill cron, and re-billing the window for
    // it would charge the payer twice.
    result.failed += 1;
    loggers.ai.error(
      'Published-app awake settle did not persist a usage row — the window stays open and is retried next tick',
      new Error('awake settle was not persisted'),
      { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
    );
    return;
  }
  if (!settle.creditsSettled) {
    // Late, not lost: the usage row exists, so `credit-backfill.ts` collects this
    // charge on its next sweep. The window still closes below.
    loggers.ai.warn(
      'Published-app awake settle persisted but its ledger settle was deferred to the backfill cron',
      { publishedAppId: row.id, driveId: row.driveId },
    );
  }
  result.settled += 1;
  result.totalAwakeSeconds += plan.activeSeconds;
  if (plan.clamped) result.clamped += 1;

  // RE-GATE. The settle above consumed the wake's hold, so the window is now
  // unreserved. Re-holding is what makes the gate keep binding on a long-lived
  // app: without it, a payer who runs out of credits mid-window would keep a
  // machine awake indefinitely and the balance check would only ever be consulted
  // at the next cold wake.
  let nextHoldId: string | null = null;
  try {
    const gate = await deps.billing.gate({ payerId });
    if (!gate.allowed) {
      // Insolvent: stop the machine and park it, through the status machine's own
      // legal `running -> parked` edge.
      //
      // ADVANCE THE WATERMARK FIRST. The span above is already CHARGED, and
      // `stopPublishedApp` re-reads the row and settles from whatever watermark it
      // finds — so parking on the stale one bills this same span a second time, on
      // every single insolvency park. Advancing first leaves the park's own final
      // settle with nothing to bill (it plans a `skip`) and lets it do what it is
      // actually for: stopping the machine and closing the window.
      await advanceSettledWatermark(row, plan.billedThrough, null, deps, result);
      await deps.parkInsolvent(row.id);
      result.parked += 1;
      return;
    }
    nextHoldId = gate.holdId ?? null;
  } catch (error) {
    // A transient billing outage must not kill a live app. The window still
    // closes below with no hold; the next tick re-gates. Same trade-off the
    // realtime shell handler makes for its own re-hold.
    loggers.ai.error(
      'Published-app awake re-hold failed — the app stays up and is re-gated next tick',
      error instanceof Error ? error : new Error(String(error)),
      { publishedAppId: row.id },
    );
  }

  await advanceSettledWatermark(row, plan.billedThrough, nextHoldId, deps, result);
}

/**
 * Persist a settle that has already CHARGED: advance the watermark and install
 * whatever reservation now covers the window.
 *
 * Shared by the ordinary settle and the insolvency park, because both have moved
 * money by the time they get here and both must record that fact before anything
 * else reads the row. The park path in particular hands the row straight to
 * `stopPublishedApp`, which settles from the watermark it finds.
 */
async function advanceSettledWatermark(
  row: PublishedApp,
  billedThrough: Date,
  holdId: string | null,
  deps: AwakeMeterDeps,
  result: MeterAwakeResult,
): Promise<void> {
  try {
    const outcome = await deps.writeSettle({ publishedAppId: row.id, billedThrough, holdId });
    if (outcome !== 'advanced') {
      result.watermarkSuperseded += 1;
      // The write declined to install our re-hold — a wake already carried this
      // row past our tick and owns the window, a stop already closed it, or the
      // row is gone. Either way nothing will ever settle or release the
      // reservation we just placed, so return it here.
      if (holdId) await deps.billing.releaseHold(holdId);
    }
  } catch (error) {
    // The charge already committed. Only the watermark write failed, so this span
    // WILL be billed again next tick — a real double-bill risk, counted under its
    // own name rather than folded into `failed`, which means the opposite.
    result.settledButUnadvanced += 1;
    loggers.ai.error(
      'Published-app awake watermark advance failed after a successful settle — this window will be re-billed next tick',
      error instanceof Error ? error : new Error(String(error)),
      { publishedAppId: row.id, driveId: row.driveId },
    );
  }
}

/**
 * Advisory-lock key serializing the awake meter across EVERY caller — a second
 * container, a manual trigger, an API invocation. `trackUsage` and the watermark
 * advance are two separate un-transactioned writes, so two overlapping runs can
 * bill the same window twice.
 */
const METER_AWAKE_LOCK_KEY = 'meter-published-apps-awake';

export type MeterAwakeRunResult = { outcome: 'lock_busy' } | MeterAwakeRun;

/**
 * Serialize the meter with a Postgres session-level advisory try-lock: a run that
 * cannot acquire it is a clean no-op and never reads a row or moves a cent.
 */
export async function meterAwakePublishedAppsSerialized(
  deps: AwakeMeterDeps = defaultAwakeMeterDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<MeterAwakeRunResult> {
  const locked = await withAdvisoryLock(pgPool, METER_AWAKE_LOCK_KEY, () => meterAwakePublishedApps(deps));
  if (locked.outcome === 'lock_busy') return { outcome: 'lock_busy' };
  if (locked.outcome === 'connection_error') throw locked.error;
  return locked.result;
}
