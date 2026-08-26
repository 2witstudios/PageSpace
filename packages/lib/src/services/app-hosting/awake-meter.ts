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
 * METERED APPS ONLY. The dedicated tier buys a flat monthly price, so there is
 * no per-second charge for this meter to make and no balance for its re-gate to
 * consult; the filter lives in `listRunningApps` and the reasoning is there.
 * (The weekly `fly_instance_up` reconcile still covers BOTH tiers, because it
 * compares our mirrored boundaries against Fly's — not our billing watermark
 * against anything — so it stays a meaningful check on a machine we are not
 * charging for.)
 *
 * Dark behind `APP_HOSTING_ENABLED`: a disabled deployment reports `disabled` and
 * reads nothing.
 */

import { and, eq, isNotNull, isNull, sql, type SQL } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import { isAppHostingEnabled, resolveDailyAwakeSecondsCap } from './app-hosting-env';
import { defaultAppBillingDeps, type AppBillingDeps } from './app-billing';
import { findStopBoundarySince } from './app-machine-events';
import {
  METER_AWAKE_LOCK_KEY,
  planAwakeSettle,
  planDailyAwakeCap,
  utcDayOf,
} from './app-metering-core';
import {
  closeAppWindowAtBoundary,
  defaultAppLifecycleMeteringDeps,
  passThroughSettleLock,
  stopPublishedApp,
  type AppLifecycleMeteringDeps,
  type SettleAndCloseResult,
  type StopReason,
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
  /**
   * Every METERED app believed AWAKE. `running` is that belief; the repair step
   * is what checks it.
   *
   * Metered only, and the filter belongs in the row SOURCE rather than in a skip
   * inside the loop: a dedicated app is paid for by a flat monthly subscription,
   * so there is nothing here to bill it for, no hold to re-place, and no
   * insolvency it could be parked for (`parked_is_metered_only` makes that row
   * unrepresentable, so the park would be refused and retried every single tick
   * forever). Filtering at the source also keeps `processed` an honest count of
   * what this meter is responsible for instead of a number padded with rows it
   * always skips.
   */
  listRunningApps: () => Promise<PublishedApp[]>;
  /** The mirror's latest stop boundary strictly after `since` — the repair signal. */
  findStopBoundary: (machineId: string, since: Date, now: Date) => Promise<Date | null>;
  /** Advance the watermark, count the day's seconds and install the re-hold in ONE statement, monotonically. */
  writeSettle: (input: {
    publishedAppId: string;
    billedThrough: Date;
    /** Seconds just CHARGED, added to the app's UTC-day awake counter by the same write. */
    billedSeconds: number;
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
  /**
   * Stop + park an app the enforcement rules refuse to keep awake — the payer is
   * out of credits, or the app has spent its daily awake budget.
   *
   * MUST run without re-taking the meter's advisory lock, because it is called from
   * inside the meter's own locked region; the default binding hands
   * `stopPublishedApp` a pass-through serializer for exactly that reason.
   */
  park: (publishedAppId: string, reason: Extract<StopReason, 'insolvent' | 'daily_cap'>) => Promise<void>;
  /** The per-app daily awake budget in seconds, read at call time. 0 disables it. */
  dailyAwakeCapSeconds: () => number;
  now: () => Date;
}

export const defaultAwakeMeterDeps: AwakeMeterDeps = {
  isEnabled: isAppHostingEnabled,
  billing: defaultAppBillingDeps,

  async listRunningApps() {
    return db
      .select()
      .from(publishedApps)
      .where(and(eq(publishedApps.status, 'running'), eq(publishedApps.tier, 'metered')));
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
  async writeSettle({ publishedAppId, billedThrough, billedSeconds, holdId }) {
    const watermark = sql.param(billedThrough, publishedApps.awakeBilledThrough);
    const day = utcDayOf(billedThrough);
    // The day's counter rides the SAME guard as the watermark and the hold, and for
    // the same reason: if a wake has carried this row past our tick, the window we
    // priced no longer exists on this row, and adding our seconds to its counter
    // would charge the new window's budget for the old window's time. The seconds
    // are lost to the cap in that case, not to the ledger — `trackUsage` already
    // committed them — which is the safe direction: the cap under-counts a rare
    // race rather than parking an app for time it did not spend.
    const guarded = (advance: SQL, keep: SQL) =>
      sql`CASE WHEN ${publishedApps.awakeBilledThrough} <= ${watermark} THEN ${advance} ELSE ${keep} END`;
    // Nothing charged, nothing counted — and the day is not touched either, so a
    // zero settle cannot roll a row onto a new day it spent no seconds in.
    const counterPatch = billedSeconds > 0
      ? {
          awakeSecondsDay: guarded(sql`${day}`, sql`${publishedApps.awakeSecondsDay}`),
          awakeSecondsToday: guarded(
            sql`CASE WHEN ${publishedApps.awakeSecondsDay} = ${day} THEN ${publishedApps.awakeSecondsToday} + ${billedSeconds} ELSE ${billedSeconds} END`,
            sql`${publishedApps.awakeSecondsToday}`,
          ),
        }
      : {};
    const [row] = await db
      .update(publishedApps)
      .set({
        awakeBilledThrough: sql`GREATEST(${publishedApps.awakeBilledThrough}, ${watermark})`,
        ...counterPatch,
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

  async park(publishedAppId, reason) {
    // `passThroughSettleLock`: this runs INSIDE the meter's locked region. A stop
    // that tried to take the lock again would get a fresh connection, see the lock
    // held by us, and skip the park while reporting success.
    await stopPublishedApp(publishedAppId, reason, {
      ...defaultAppLifecycleMeteringDeps,
      serializeSettle: passThroughSettleLock,
    });
  },

  dailyAwakeCapSeconds: resolveDailyAwakeSecondsCap,

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
   * Rows stopped and parked because the APP spent its own daily awake budget —
   * counted apart from `parked` because the two say different things about the
   * fleet: one is a payer with no credits, the other is a single app running away
   * while its payer is perfectly solvent.
   */
  cappedParked: number;
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
  cappedParked: 0,
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
      await deps.park(row.id, 'insolvent');
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

  // DAILY CAP, judged on the counter AS THIS SETTLE WILL LEAVE IT — the seconds
  // just charged are exactly the ones that can carry an app over its budget, and
  // waiting for the next tick to notice would let a runaway app spend another whole
  // cadence past the line. The projection mirrors the SQL below (stale day resets to
  // zero, then add), which is why both go through the same pure planner.
  const today = utcDayOf(now);
  const capSeconds = deps.dailyAwakeCapSeconds();
  const spentBefore = planDailyAwakeCap({
    tier: row.tier,
    counterDay: row.awakeSecondsDay,
    secondsToday: row.awakeSecondsToday,
    today,
    capSeconds,
  });
  const spentAfter = planDailyAwakeCap({
    tier: row.tier,
    counterDay: today,
    secondsToday: spentBefore.secondsToday + plan.activeSeconds,
    today,
    capSeconds,
  });
  if (spentAfter.exceeded) {
    // ADVANCE THE WATERMARK AND THE COUNTER FIRST, for the same reason the
    // insolvency park does: the span above is already CHARGED, and the park re-reads
    // the row and settles from whatever watermark it finds. Parking on the stale one
    // would bill this span twice on every single cap park.
    const advanced = await advanceSettledWatermark(row, plan.billedThrough, plan.activeSeconds, null, deps, result);
    // Not parked when the advance THREW: the park would re-read the unchanged
    // watermark and bill this span again. Counted under `settledButUnadvanced`
    // already; the next tick finds the app still awake and still over its budget.
    if (!mayParkAfter(advanced)) return;
    await deps.park(row.id, 'daily_cap');
    result.cappedParked += 1;
    return;
  }

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
      const advanced = await advanceSettledWatermark(row, plan.billedThrough, plan.activeSeconds, null, deps, result);
      // Same rule as the cap park above, and for the same reason: parking on a
      // watermark that never moved double-charges the span already billed.
      if (!mayParkAfter(advanced)) return;
      await deps.park(row.id, 'insolvent');
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

  await advanceSettledWatermark(row, plan.billedThrough, plan.activeSeconds, nextHoldId, deps, result);
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
  billedSeconds: number,
  holdId: string | null,
  deps: AwakeMeterDeps,
  result: MeterAwakeResult,
): Promise<AwakeWatermarkOutcome | 'failed'> {
  try {
    const outcome = await deps.writeSettle({ publishedAppId: row.id, billedThrough, billedSeconds, holdId });
    if (outcome !== 'advanced') {
      result.watermarkSuperseded += 1;
      // The write declined to install our re-hold — a wake already carried this
      // row past our tick and owns the window, a stop already closed it, or the
      // row is gone. Either way nothing will ever settle or release the
      // reservation we just placed, so return it here.
      if (holdId) await deps.billing.releaseHold(holdId);
    }
    return outcome;
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
    return 'failed';
  }
}

/**
 * Whether a park may follow this watermark write.
 *
 * A park hands the row straight to `stopPublishedApp`, which RE-READS it and settles
 * from whatever watermark it finds. So a park after a write that never landed bills
 * the span we just charged a SECOND time — the double charge lands exactly in the
 * `settledButUnadvanced` case, which is the one already known to be going wrong.
 *
 * `superseded` is safe and must not block the park: the row's watermark is ahead of
 * ours (a wake carried it past this tick), so the stop's own settle has nothing of
 * ours left to re-bill — and refusing to park there would leave an insolvent payer's
 * machine awake on a technicality.
 *
 * Only the THROW blocks it. The app stays up for one more cadence and the next tick
 * re-gates it; a machine left awake for ten minutes is recoverable, a duplicate
 * charge is not.
 */
function mayParkAfter(outcome: AwakeWatermarkOutcome | 'failed'): boolean {
  return outcome !== 'failed';
}

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
