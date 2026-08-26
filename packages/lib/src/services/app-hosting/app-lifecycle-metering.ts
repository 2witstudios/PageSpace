/**
 * app-lifecycle-metering — the WAKE and STOP seams for a published app, and the
 * only two places an awake window is opened or closed.
 *
 * The whole metering design rests on one property: our orchestrator owns every
 * start and stop (`autostop: "off"`), so a billing boundary is an API call we made
 * at a time we know exactly, rather than a proxy behavior we would have to infer.
 * These two functions ARE that ownership. Anything that starts or stops a
 * published app's machine without going through them opens a window nobody closes
 * or closes one nobody opened.
 *
 * Ordering, and which way each crash window fails:
 *
 *  - WAKE gates and holds BEFORE the machine starts, and stamps the boundary
 *    AFTER Fly confirms the start. A crash in between leaves a machine awake that
 *    our row calls `stopped` — the platform eats that time and the customer is
 *    never billed for it. The reverse ordering would bill a customer for a machine
 *    that failed to start, which is the unacceptable direction. The weekly
 *    `fly_instance_up` reconcile is what surfaces it (Fly saw awake time we never
 *    billed → `under_billed` drift).
 *  - STOP asks Fly to stop, mirrors the boundary, and only then settles and closes
 *    the window. A crash between the stop and the settle leaves a `running` row
 *    over a stopped machine — but the boundary is already in the mirror, so the
 *    next heartbeat finds it (`findStopBoundarySince`), settles only up to the real
 *    stop, and closes the window itself. That self-heal is why the mirror write
 *    comes before the money.
 *
 * Everything is dark behind `APP_HOSTING_ENABLED`, checked before any read.
 */

import { and, eq, sql } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import {
  isAppHostingEnabled,
  resolveDailyAwakeSecondsCap,
  resolveFlyMachinesToken,
} from './app-hosting-env';
import {
  listMachineEvents as flapsListMachineEvents,
  startMachine as flapsStartMachine,
  stopMachine as flapsStopMachine,
  type FlapsTransport,
  type MachineEvent,
} from '../fly/flaps-client';
import { defaultAppBillingDeps, type AppBillingDeps } from './app-billing';
import {
  findStopBoundarySince,
  mirrorFlyMachineEvents,
  recordOrchestratorBoundary,
} from './app-machine-events';
import {
  METER_AWAKE_LOCK_KEY,
  planAwakeSettle,
  planDailyAwakeCap,
  utcDayOf,
} from './app-metering-core';
import { planTransition } from './provisioner-core';

export interface AppLifecycleMeteringDeps {
  isEnabled: () => boolean;
  billing: AppBillingDeps;
  startMachine: (flyAppName: string, machineId: string) => Promise<void>;
  stopMachine: (flyAppName: string, machineId: string) => Promise<void>;
  /** Fly's last-20 event window for one machine. Mirroring is best-effort, so a throw here is caught and counted, never propagated. */
  listMachineEvents: (flyAppName: string, machineId: string) => Promise<MachineEvent[]>;
  /**
   * Run `fn` under the awake meter's advisory lock, or answer `lock_busy` without
   * running it — see {@link stopPublishedApp} for why the STOP takes the METER's
   * lock rather than one of its own.
   *
   * Injected rather than called directly for two reasons. It makes the stop seam
   * testable without a Postgres pool, and it is the seam through which a caller
   * that ALREADY HOLDS the lock passes {@link passThroughSettleLock} — the
   * heartbeat's insolvency park runs inside the meter's own locked region, and a
   * second acquisition on a second connection would answer `lock_busy` and quietly
   * skip the park (a session-level advisory lock is re-entrant only within the
   * SAME session, and this helper takes a fresh connection every time).
   */
  serializeSettle: <T>(fn: () => Promise<T>) => Promise<{ locked: false } | { locked: true; result: T }>;
  /** The per-app daily awake budget in seconds, read at call time. 0 disables it. */
  dailyAwakeCapSeconds: () => number;
  now: () => Date;
}

/**
 * Acquire the awake-meter advisory lock for the duration of `fn`, or decline.
 *
 * `connection_error` is rethrown rather than folded into `lock_busy`: a pool that
 * cannot hand out a connection is an outage, and reporting it as "another run has
 * the lock" would present an outage as an ordinary, self-correcting skip.
 */
export function serializeUnderMeterLock(pgPool: AdvisoryLockPool = getAdvisoryLockPool()) {
  return async <T>(fn: () => Promise<T>): Promise<{ locked: false } | { locked: true; result: T }> => {
    const locked = await withAdvisoryLock(pgPool, METER_AWAKE_LOCK_KEY, fn);
    if (locked.outcome === 'lock_busy') return { locked: false };
    if (locked.outcome === 'connection_error') throw locked.error;
    return { locked: true, result: locked.result };
  };
}

/**
 * A serializer for a caller that is ALREADY inside the meter's locked region: run
 * `fn` immediately, take nothing.
 *
 * The alternative — letting the heartbeat's park re-acquire — is not a deadlock
 * (the try-lock does not block) but something quieter and worse: it answers
 * `lock_busy`, the park is skipped, and an insolvent app stays awake while the
 * counters report a clean tick.
 */
export async function passThroughSettleLock<T>(fn: () => Promise<T>): Promise<{ locked: true; result: T }> {
  return { locked: true, result: await fn() };
}

function defaultTransport(): FlapsTransport {
  return { token: resolveFlyMachinesToken() };
}

export const defaultAppLifecycleMeteringDeps: AppLifecycleMeteringDeps = {
  isEnabled: isAppHostingEnabled,
  billing: defaultAppBillingDeps,
  startMachine: (flyAppName, machineId) => flapsStartMachine(defaultTransport(), flyAppName, machineId),
  stopMachine: (flyAppName, machineId) => flapsStopMachine(defaultTransport(), flyAppName, machineId),
  listMachineEvents: (flyAppName, machineId) =>
    flapsListMachineEvents(defaultTransport(), flyAppName, machineId),
  // Bound lazily: `getAdvisoryLockPool()` opens a pool, and this module is imported
  // by services that never stop a machine (the router's package graph included).
  serializeSettle: (fn) => serializeUnderMeterLock()(fn),
  dailyAwakeCapSeconds: resolveDailyAwakeSecondsCap,
  now: () => new Date(),
};

export type WakeRefusal =
  | 'disabled'
  | 'not_found'
  /** The row has no machine to start (never deployed, or mid blue/green swap). */
  | 'no_machine'
  /** The row is not in a state a wake may leave — already running, destroying, failed. */
  | 'not_wakeable'
  /** The owning drive could not be resolved, so there is no honest payer. Nothing is started. */
  | 'unresolved_payer';

export type WakePublishedAppResult =
  | { outcome: 'woken'; app: PublishedApp; holdId?: string }
  /** The gate refused: the app is PARKED and the router serves a parked page. Enforcement is "don't wake", never a clawback. */
  | { outcome: 'parked'; reason: string }
  /** Fly refused the start. The hold is released; nothing is billed and nothing is stamped. */
  | { outcome: 'start_failed'; error: string }
  | { outcome: 'refused'; reason: WakeRefusal };

/**
 * Wake a published app: gate the payer, place a hold, start the machine, open the
 * awake window.
 *
 * THE GATE RUNS BEFORE THE MACHINE STARTS, which is the entire credit enforcement
 * story for hosting. An exhausted payer's app is moved to `parked` and never
 * started, so there is nothing to claw back and no negative balance to chase — the
 * epic's D7 decision made literal.
 */
export async function wakePublishedApp(
  publishedAppId: string,
  deps: AppLifecycleMeteringDeps = defaultAppLifecycleMeteringDeps,
): Promise<WakePublishedAppResult> {
  if (!deps.isEnabled()) return { outcome: 'refused', reason: 'disabled' };

  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  if (!row) return { outcome: 'refused', reason: 'not_found' };
  if (!row.machineId) return { outcome: 'refused', reason: 'no_machine' };
  // Judged against the SAME pure planner the transition itself uses, with the
  // columns as they will be after the write. Asking here means a wake that the
  // status machine would refuse never reaches Fly — otherwise we would start a
  // machine and then discover we cannot record that we did.
  const plan = planTransition(row.status, 'running', {
    imageDigest: row.imageDigest,
    machineId: row.machineId,
    tier: row.tier,
  });
  if (!plan.allowed) return { outcome: 'refused', reason: 'not_wakeable' };

  // The per-app daily budget is asked BEFORE the payer is resolved and before the
  // ledger is touched: it is a comparison between two columns already in hand, and
  // an app that has spent its day must not be woken however solvent its owner is.
  // Same enforcement shape as the credit gate — park, do not start — so there is
  // nothing to claw back.
  const budget = planDailyAwakeCap({
    tier: row.tier,
    counterDay: row.awakeSecondsDay,
    secondsToday: row.awakeSecondsToday,
    today: utcDayOf(deps.now()),
    capSeconds: deps.dailyAwakeCapSeconds(),
  });
  if (budget.exceeded) {
    await parkPublishedApp(row, DAILY_CAP_PARK_REASON);
    reportDailyCapPark(row);
    return { outcome: 'parked', reason: DAILY_CAP_PARK_REASON };
  }

  const payerId = await deps.billing.resolvePayerId({ driveId: row.driveId });
  // No fallback, by design: an app is drive-owned, and `published_apps.ownerId`
  // is a denormalized cascade handle, not an answer to "who pays". Billing a
  // machine to somebody who may not own the drive is a money movement that cannot
  // be taken back; refusing the wake costs one request a parked page.
  if (!payerId) return { outcome: 'refused', reason: 'unresolved_payer' };

  const gate = await deps.billing.gate({ payerId });
  if (!gate.allowed) {
    await parkPublishedApp(row, gate.reason ?? 'insufficient_credits');
    return { outcome: 'parked', reason: gate.reason ?? 'insufficient_credits' };
  }

  // A previous stop whose final settle did not land left its window on the row.
  // The UPDATE below resets `awakeBilledThrough` to `wokenAt`, so this is the last
  // moment that span can be billed — settle it at the boundary it really ended on.
  // Runs after the gate so a wake that is about to be refused does not bill, and
  // before the start so it cannot be confused with this wake's own window.
  await settleAbandonedTail(row, deps);

  try {
    await deps.startMachine(row.flyAppName, row.machineId);
  } catch (error) {
    // Nothing started, so nothing may be billed. Release the reservation rather
    // than leaving it to expire — a stranded hold suppresses the payer's own
    // spendable balance for the whole hold TTL.
    if (gate.holdId) await deps.billing.releaseHold(gate.holdId);
    return { outcome: 'start_failed', error: error instanceof Error ? error.message : String(error) };
  }

  const wokenAt = deps.now();
  const ref = { publishedAppId: row.id, flyAppName: row.flyAppName, machineId: row.machineId };
  await recordOrchestratorBoundary(ref, 'start', wokenAt);
  await mirrorRecentFlyEvents(ref, deps);

  // The status and both stamps land in ONE statement, guarded on the status we
  // planned against. A concurrent wake (two requests racing the same cold app)
  // therefore produces one winner: the loser's UPDATE matches no row, and it
  // releases its own hold instead of overwriting the winner's window start with a
  // later one — which would silently forgive the seconds in between.
  const [updated] = await db
    .update(publishedApps)
    .set({
      status: 'running',
      lastWakeAt: wokenAt,
      awakeBilledThrough: wokenAt,
      awakeHoldId: gate.holdId ?? null,
    })
    .where(and(eq(publishedApps.id, row.id), eq(publishedApps.status, row.status)))
    .returning();

  if (!updated) {
    // Someone else won the race and owns the window now. Our hold reserves
    // against a window we will never settle, so release it.
    if (gate.holdId) await deps.billing.releaseHold(gate.holdId);
    return { outcome: 'refused', reason: 'not_wakeable' };
  }
  return { outcome: 'woken', app: updated, holdId: gate.holdId };
}

/**
 * Advisory-lock key serializing the WAKES of one app — per app, never global.
 *
 * A cold published app is not visited once: a browser asks for the document and
 * then twenty assets, and with no replay cache on the metered tier every one of
 * those reaches the router within milliseconds. Unserialized, each would gate,
 * place a hold and call Fly's start endpoint — twenty starts for one machine
 * against a per-object rate limit of ~1/s (burst 3), so most would come back 429,
 * and the page's assets would be served the unavailable page while the machine the
 * first request started was coming up.
 *
 * With it, exactly one request wakes and the rest are told a wake is in flight and
 * replay anyway — Fly's proxy then holds their request for the machine that is
 * already starting, which is the behaviour they wanted.
 */
function wakeLockKeyFor(publishedAppId: string): string {
  return `wake-published-app:${publishedAppId}`;
}

export type WakePublishedAppRunResult =
  | WakePublishedAppResult
  /**
   * Another request is waking this app right now. NOTHING was gated, held or
   * started here. The caller should serve as though the wake succeeded — the app
   * IS being started, by the request that holds the lock.
   */
  | { outcome: 'wake_in_progress' };

/**
 * Wake an app, serialized per app: one winner starts the machine, everybody else
 * is told a wake is in flight.
 *
 * A TRY-lock, never a waiting one: a request that blocks on a lock is a request
 * that is slower than the cold start it is waiting for.
 */
export async function wakePublishedAppSerialized(
  publishedAppId: string,
  deps: AppLifecycleMeteringDeps = defaultAppLifecycleMeteringDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<WakePublishedAppRunResult> {
  // The kill switch is checked BEFORE the pool is touched: a dark deployment must
  // not open a connection just to decline.
  if (!deps.isEnabled()) return { outcome: 'refused', reason: 'disabled' };
  const locked = await withAdvisoryLock(pgPool, wakeLockKeyFor(publishedAppId), () =>
    wakePublishedApp(publishedAppId, deps),
  );
  if (locked.outcome === 'lock_busy') return { outcome: 'wake_in_progress' };
  if (locked.outcome === 'connection_error') throw locked.error;
  return locked.result;
}

/**
 * Why a stop happened. `insolvent` and `daily_cap` PARK the app instead of merely
 * stopping it — the two enforcement refusals — while `idle` and `operator` leave it
 * `stopped`, i.e. free to wake on the next request.
 */
export type StopReason = 'idle' | 'insolvent' | 'daily_cap' | 'operator';

/**
 * The `lastError` a daily-cap park writes, and the reason the wake gate reports.
 *
 * A constant because it is the ONE user-facing explanation of this state. See
 * {@link reportDailyCapPark} for why it is carried on the row rather than raised as
 * a notification.
 */
export const DAILY_CAP_PARK_REASON = 'daily_awake_cap_exceeded';

/**
 * Tell the drive owner — and an operator — that an app was parked for spending its
 * daily awake budget.
 *
 * THIS IS THE WHOLE NOTIFICATION, and the shape is a decision rather than a
 * shortcut. `createNotification` only accepts a member of the `NotificationType`
 * pg enum, so raising a first-class in-app notification means a migration on that
 * enum, a new member of the in-app `Notification` discriminated union, a renderer
 * in the notification list and an `email_notification_preferences` row for opt-out
 * — user-visible UI work, in a PR whose entire safety property is that it ships
 * dark behind `APP_HOSTING_ENABLED`, for a state no user can reach yet. So the
 * owner-facing half is `published_apps.lastError` (the column the publish surface
 * already reads to answer "why is my app not serving", written by the park itself)
 * and the operator-facing half is this log plus the parking counters the two crons
 * report, which is what actually reaches a human today.
 *
 * A first-class notification belongs with the publish surface that will display
 * it; this is deliberately not a TODO, because nothing here has to change for that
 * to be added — the enum value and the renderer land there, and this call site
 * gains one line.
 *
 * Logged at ERROR rather than warn: an app being taken off the internet is the
 * single most consequential thing this module does to somebody's product, and it
 * happens with no human in the loop.
 */
export function reportDailyCapPark(row: Pick<PublishedApp, 'id' | 'driveId' | 'ownerId' | 'tier'>): void {
  loggers.ai.error(
    'Published app parked: it spent its daily awake budget',
    new Error(DAILY_CAP_PARK_REASON),
    { publishedAppId: row.id, driveId: row.driveId, ownerId: row.ownerId, tier: row.tier },
  );
}

export type StopPublishedAppResult =
  | { outcome: 'stopped'; status: 'stopped' | 'parked'; billedSeconds: number }
  /**
   * The awake meter's advisory lock was held by somebody else, so NOTHING was read,
   * stopped or billed. Self-correcting by construction: the machine is still running
   * and still recorded as running, so the next reaper tick stops it. Distinct from
   * every `refused` reason because it says nothing about the app — only about timing.
   */
  | { outcome: 'lock_busy' }
  /** Fly refused the stop. The window stays OPEN and keeps billing — the machine may well still be running. */
  | { outcome: 'stop_failed'; error: string }
  | { outcome: 'refused'; reason: 'disabled' | 'not_found' | 'not_running' | 'illegal_transition' };

/**
 * Stop a published app: stop the machine, mirror the boundary, settle the tail of
 * the awake window, and close it.
 *
 * `reason: 'insolvent'` lands the app in `parked` rather than `stopped`, through
 * the status machine's own legal `running → parked` edge — parking is the credit
 * gate's enforcement state, and the difference is load-bearing downstream: a
 * `stopped` app wakes on the next request and a `parked` one does not.
 *
 * The final settle bills through `now`, which on THIS path IS the real boundary:
 * Fly has just confirmed the stop, so the machine went down at the instant we are
 * about to stamp. The other case — a stop that already happened and whose status
 * write was lost — is not repaired here but by the heartbeat, which finds the
 * boundary in the mirror and closes the window at it through
 * `closeAppWindowAtBoundary`.
 */
export async function stopPublishedApp(
  publishedAppId: string,
  reason: StopReason,
  deps: AppLifecycleMeteringDeps = defaultAppLifecycleMeteringDeps,
): Promise<StopPublishedAppResult> {
  if (!deps.isEnabled()) return { outcome: 'refused', reason: 'disabled' };

  // The WHOLE sequence is serialized, not just the settle: the double-charge this
  // lock prevents is created by the READ (a stop and a heartbeat pricing the same
  // window from two snapshots), so a lock taken after the read would protect
  // nothing. The cost is that a stop's Fly call happens inside the meter's lock and
  // can delay a heartbeat tick by the length of one `POST /stop`; the heartbeat is
  // a ten-minute cadence and skips cleanly when the lock is held, so a delayed tick
  // bills the same seconds one tick later. A double charge cannot be undone.
  const run = await deps.serializeSettle(() => stopPublishedAppSerialized(publishedAppId, reason, deps));
  if (!run.locked) return { outcome: 'lock_busy' };
  return run.result;
}

/** The body of {@link stopPublishedApp}, run with the awake meter's lock already held. */
async function stopPublishedAppSerialized(
  publishedAppId: string,
  reason: StopReason,
  deps: AppLifecycleMeteringDeps,
): Promise<StopPublishedAppResult> {
  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  if (!row) return { outcome: 'refused', reason: 'not_found' };
  if (row.status !== 'running') return { outcome: 'refused', reason: 'not_running' };

  const nextStatus: 'stopped' | 'parked' = reason === 'insolvent' || reason === 'daily_cap' ? 'parked' : 'stopped';
  // Asked BEFORE the Fly call, against the same pure planner the write uses. A
  // dedicated app cannot be parked (`parked_is_metered_only`), and discovering
  // that after stopping its machine would leave a stopped machine on a `running`
  // row for the heartbeat to keep billing.
  const plan = planTransition(row.status, nextStatus, {
    imageDigest: row.imageDigest,
    machineId: row.machineId,
    tier: row.tier,
  });
  if (!plan.allowed) return { outcome: 'refused', reason: 'illegal_transition' };

  if (row.machineId) {
    try {
      await deps.stopMachine(row.flyAppName, row.machineId);
    } catch (error) {
      // The window stays open deliberately. A failed stop very likely means the
      // machine is still running and still costing money; closing the window here
      // would stop billing awake time the payer is genuinely consuming.
      return { outcome: 'stop_failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  const stoppedAt = deps.now();
  if (row.machineId) {
    const ref = { publishedAppId: row.id, flyAppName: row.flyAppName, machineId: row.machineId };
    // BEFORE the money, on purpose: if everything below is lost to a crash, this
    // row is what lets the next heartbeat close the window at the real boundary
    // instead of billing a stopped machine.
    await recordOrchestratorBoundary(ref, 'stop', stoppedAt);
    await mirrorRecentFlyEvents(ref, deps);
  }

  const settled = await settleAndClose(row, stoppedAt, nextStatus, stoppedAt, deps, reason);
  if (reason === 'daily_cap') reportDailyCapPark(row);
  return { outcome: 'stopped', status: nextStatus, billedSeconds: settled.billedSeconds };
}

/**
 * Move an app to `parked` without billing anything — the wake gate's refusal path.
 *
 * Not routed through `stopPublishedApp`: nothing was started, so there is no
 * machine to stop, no window to settle and no hold to carry. It is a status write
 * and nothing else, still made through the pure planner so a `dedicated` app (which
 * cannot be parked) is refused here rather than by a constraint violation.
 */
async function parkPublishedApp(row: PublishedApp, reason: string): Promise<void> {
  const plan = planTransition(row.status, 'parked', {
    imageDigest: row.imageDigest,
    machineId: row.machineId,
    tier: row.tier,
  });
  if (!plan.allowed) {
    loggers.ai.warn('Published app could not be parked after a gate refusal', {
      publishedAppId: row.id,
      from: row.status,
      refusal: plan.reason,
      reason,
    });
    return;
  }
  await db
    .update(publishedApps)
    .set({ status: 'parked', lastError: `parked: ${reason}` })
    .where(and(eq(publishedApps.id, row.id), eq(publishedApps.status, row.status)));
}

export interface SettleAndCloseResult {
  billedSeconds: number;
  /**
   * The settle did not land — it threw, or it resolved without persisting a usage
   * row. The window is left OPEN so the next tick retries it rather than losing it.
   */
  failed: boolean;
}

/**
 * Settle the tail of an awake window and close it — the shared ending for the stop
 * seam and for the heartbeat's mirror-driven repair.
 *
 * `billedThrough` is the instant the window really ended, which is NOT always
 * `now`: a repair closes at the mirrored stop boundary. `stampedStopAt` is what
 * lands in `lastStopAt`, the boundary column the weekly reconcile reads.
 *
 * The hold is disposed of exactly once, whichever way the window ends: settled
 * against by `trackUsage` when there are seconds to bill, released otherwise. A
 * hold left behind would suppress the payer's spendable balance for its whole TTL.
 * (`trackUsage` returns the reservation itself on a settle that does not persist,
 * so the retried window is settled unreserved on the next tick — one tick of
 * unreserved spend, against losing the window outright.)
 */
async function settleAndClose(
  row: PublishedApp,
  billedThrough: Date,
  nextStatus: 'stopped' | 'parked',
  stampedStopAt: Date,
  deps: AppLifecycleMeteringDeps,
  reason?: StopReason,
): Promise<SettleAndCloseResult> {
  const plan = planAwakeSettle({ billedThrough: row.awakeBilledThrough, now: billedThrough });
  let billedSeconds = 0;
  if (plan.action === 'settle') {
    const payerId = await deps.billing.resolvePayerId({ driveId: row.driveId });
    if (payerId) {
      // The window is NOT closed on a failed settle: leaving it open means the next
      // heartbeat retries the whole span, where closing it would silently lose the
      // app's last awake window. The status still moves either way — the machine
      // really did stop, and leaving a `running` row over it would be worse than a
      // window that gets retried.
      //
      // TWO failure shapes reach that path, and only one of them used to. A THROW
      // is a deps-level or transport failure. A settle that RESOLVES WITHOUT
      // PERSISTING is the shape `AIMonitoring.trackUsage` used to hide behind
      // `Promise<void>`: it now reports `persisted: false`, and it means no
      // `ai_usage_logs` row is CONFIRMED to exist — so not even the credit backfill
      // cron, which reads that table, can be relied on to recover the charge.
      // Retrying the window is the only thing that can.
      //
      // "Not confirmed", not "not written": a connection dropped at the commit
      // boundary reports a failed write over a row that committed, and the retry
      // then bills the span twice. Bounded at ONE duplicate span, and strictly
      // better than losing the window on every genuine failure; the deterministic
      // per-window idempotency key that would close it is a filed follow-up.
      //
      // Deliberately NOT keyed on `creditsSettled`: a persisted row whose ledger
      // claim was deferred is already owned by the backfill cron, and reopening the
      // window for it would bill the payer twice for the same span.
      let settled = false;
      try {
        const settle = await deps.billing.trackUsage({
          payerId,
          holdId: row.awakeHoldId ?? undefined,
          activeSeconds: plan.activeSeconds,
          driveId: row.driveId,
          publishedAppId: row.id,
        });
        settled = settle.persisted;
        if (settled && !settle.creditsSettled) {
          loggers.ai.warn(
            'Published-app final settle persisted but its ledger settle was deferred to the backfill cron',
            { publishedAppId: row.id, driveId: row.driveId },
          );
        }
        if (!settled) {
          loggers.ai.error(
            'Published-app final settle did not persist a usage row — the awake window stays open for the next tick to retry',
            new Error('final settle was not persisted'),
            { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
          );
        }
      } catch (error) {
        loggers.ai.error(
          'Published-app final settle failed — the awake window stays open for the next tick to retry',
          error instanceof Error ? error : new Error(String(error)),
          { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
        );
      }
      if (!settled) {
        await closeStatusOnly(row, nextStatus, stampedStopAt, reason);
        return { billedSeconds: 0, failed: true };
      }
      billedSeconds = plan.activeSeconds;
    } else {
      // Unresolvable drive: skip the charge rather than misattribute it, exactly
      // as the storage reconcile does. The hold is still released below — it
      // reserves against a window nobody will ever settle.
      loggers.ai.warn('Published-app final settle skipped: the owning drive could not be resolved', {
        publishedAppId: row.id,
        driveId: row.driveId,
      });
      if (row.awakeHoldId) await deps.billing.releaseHold(row.awakeHoldId);
    }
  } else if (row.awakeHoldId) {
    // Nothing to bill (no window, or no time in it) — the reservation is returned
    // rather than settled.
    await deps.billing.releaseHold(row.awakeHoldId);
  }

  await db
    .update(publishedApps)
    .set({
      status: nextStatus,
      lastStopAt: stampedStopAt,
      awakeBilledThrough: null,
      awakeHoldId: null,
      // The day's counter advances in the SAME statement that closes the window,
      // for the same reason the watermark does: seconds that were charged but not
      // counted are seconds the daily cap cannot see, and the cap's whole job is to
      // bound what a single app can spend in a day.
      //
      // Keyed off the CLOCK, not off `billedThrough`. They are the same instant on
      // the ordinary stop, but not on the two paths that matter: a repair closes at
      // a mirrored boundary that can sit in a previous UTC day, and a clamped span
      // bills a day's worth of seconds ending wherever the watermark was. Keying
      // off the boundary there would stamp a stale day, whose next comparison
      // reads as "nothing spent today" — the cap failing OPEN on exactly the
      // broken-lifecycle rows it exists to catch. Charging those seconds to the day
      // we discovered them is the conservative direction, and it is the same day
      // the cap projection in the heartbeat uses.
      ...dailyAwakeCounterPatch(billedSeconds, deps.now()),
      ...parkErrorPatch(reason),
    })
    .where(and(eq(publishedApps.id, row.id), eq(publishedApps.status, 'running')));
  return { billedSeconds, failed: false };
}

/**
 * Settle a tail that a FAILED close left behind on a non-running row, at the wake
 * that is about to overwrite it.
 *
 * `closeStatusOnly` preserves `awakeBilledThrough` when a final settle does not
 * land — but nothing consumed it: the awake meter reads `status = 'running'` rows
 * only, so a stopped row is never revisited, and the wake below resets the
 * watermark to `wokenAt`. The preserved span was therefore silently discarded at
 * the next wake, which is the moment this runs instead.
 *
 * The billed span is [`awakeBilledThrough`, `lastStopAt`] — the window as it really
 * ended. Emphatically NOT up to `now`: the machine was down in between, and billing
 * that gap would charge the payer for a stopped app.
 *
 * Never blocks the wake. If this settle also fails to persist, the span is finally
 * lost and said so at ERROR — two independent failures at two separate moments,
 * against losing it on the first. A `parked` app that is never woken again keeps
 * its tail on the row unbilled; recovering that needs a sweep over non-running
 * rows, which is follow-up work rather than a wake's job.
 */
async function settleAbandonedTail(
  row: PublishedApp,
  deps: AppLifecycleMeteringDeps,
): Promise<void> {
  if (row.status === 'running') return; // a live window, not an abandoned tail
  if (row.awakeBilledThrough === null || row.lastStopAt === null) return;

  const plan = planAwakeSettle({ billedThrough: row.awakeBilledThrough, now: row.lastStopAt });
  if (plan.action !== 'settle') {
    // Nothing billable was stranded; return the reservation the failed close kept.
    if (row.awakeHoldId) await deps.billing.releaseHold(row.awakeHoldId);
    return;
  }

  const payerId = await deps.billing.resolvePayerId({ driveId: row.driveId });
  if (!payerId) {
    // Unresolvable drive — never substitute a payer. The tail stays on the row and
    // the wake below overwrites it, so this IS the loss; say so rather than warn.
    loggers.ai.error(
      'Published-app abandoned tail could not be billed: the owning drive did not resolve — this span is lost',
      new Error('abandoned tail payer unresolved'),
      { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
    );
    return;
  }

  try {
    const settle = await deps.billing.trackUsage({
      payerId,
      holdId: row.awakeHoldId ?? undefined,
      activeSeconds: plan.activeSeconds,
      driveId: row.driveId,
      publishedAppId: row.id,
    });
    if (!settle.persisted) {
      loggers.ai.error(
        'Published-app abandoned tail did not persist on the retry either — this span is lost',
        new Error('abandoned tail settle was not persisted'),
        { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
      );
    }
  } catch (error) {
    loggers.ai.error(
      'Published-app abandoned tail settle threw on the retry — this span is lost',
      error instanceof Error ? error : new Error(String(error)),
      { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
    );
  }
}

/**
 * The SET fragment that adds `addSeconds` to the app's UTC-day awake counter,
 * resetting it when the stored day is not `at`'s day.
 *
 * The reset lives in the STATEMENT rather than in a preceding read, so a counter
 * can never be advanced against a day another writer has already rolled over. Adds
 * nothing at all for a zero settle: touching `awakeSecondsDay` for a settle that
 * billed no seconds would move a row's day forward on a tick that charged nothing.
 */
function dailyAwakeCounterPatch(addSeconds: number, at: Date) {
  // `at` is the tick's clock — see the call site for why it is never the billed
  // boundary.
  if (!Number.isFinite(addSeconds) || addSeconds <= 0) return {};
  const day = utcDayOf(at);
  return {
    awakeSecondsDay: day,
    awakeSecondsToday: sql`CASE WHEN ${publishedApps.awakeSecondsDay} = ${day} THEN ${publishedApps.awakeSecondsToday} + ${addSeconds} ELSE ${addSeconds} END`,
  };
}

/**
 * The SET fragment that records WHY an app was parked, for the one stop reason a
 * user can act on.
 *
 * Only the daily cap writes here. An idle stop is routine and an insolvency park
 * already has the credit balance as its explanation, whereas "your app used its
 * whole daily budget" is invisible from every other column on the row.
 */
function parkErrorPatch(reason: StopReason | undefined) {
  return reason === 'daily_cap' ? { lastError: `parked: ${DAILY_CAP_PARK_REASON}` } : {};
}

/**
 * Close the STATUS without closing the billing window — the failed-settle path.
 * `awakeBilledThrough` deliberately survives so the unbilled span is not forgiven
 * at the moment of failure, while the row stops claiming to be running.
 *
 * It is NOT retried by the awake meter: that meter reads `status = 'running'` rows
 * only, so this row is now invisible to it. The preserved span is settled by
 * `settleAbandonedTail` at the next wake — the next moment anything touches the row
 * — before the wake resets the watermark. A row that is never woken again keeps its
 * tail unbilled; a sweep over non-running rows would close that, and is follow-up.
 */
async function closeStatusOnly(
  row: PublishedApp,
  nextStatus: 'stopped' | 'parked',
  stampedStopAt: Date,
  reason?: StopReason,
): Promise<void> {
  await db
    .update(publishedApps)
    .set({ status: nextStatus, lastStopAt: stampedStopAt, ...parkErrorPatch(reason) })
    .where(and(eq(publishedApps.id, row.id), eq(publishedApps.status, 'running')));
}

/**
 * Settle a window the mirror says already ended, and close it at the REAL boundary
 * — the heartbeat's self-heal for a stop whose status write was lost.
 *
 * Exported for the meter rather than inlined there so the "settle then close"
 * sequence, and its hold disposal, exist in exactly one place.
 */
export async function closeAppWindowAtBoundary(
  row: PublishedApp,
  boundary: Date,
  deps: AppLifecycleMeteringDeps,
): Promise<SettleAndCloseResult> {
  return settleAndClose(row, boundary, 'stopped', boundary, deps);
}

/** Best-effort mirroring of Fly's last-20 window; a failure is logged inside and never propagates. */
async function mirrorRecentFlyEvents(
  ref: { publishedAppId: string; flyAppName: string; machineId: string },
  deps: AppLifecycleMeteringDeps,
): Promise<void> {
  try {
    const events = await deps.listMachineEvents(ref.flyAppName, ref.machineId);
    await mirrorFlyMachineEvents(ref, events);
  } catch (error) {
    loggers.ai.warn('Published-app Fly event window could not be read for mirroring', {
      publishedAppId: ref.publishedAppId,
      machineId: ref.machineId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Re-exported so the meter reads its repair boundary through the same module the writes go through. */
export { findStopBoundarySince };
