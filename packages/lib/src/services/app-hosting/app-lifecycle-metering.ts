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

import { and, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import {
  isAppHostingEnabled,
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
import { planAwakeSettle } from './app-metering-core';
import { planTransition } from './provisioner-core';

export interface AppLifecycleMeteringDeps {
  isEnabled: () => boolean;
  billing: AppBillingDeps;
  startMachine: (flyAppName: string, machineId: string) => Promise<void>;
  stopMachine: (flyAppName: string, machineId: string) => Promise<void>;
  /** Fly's last-20 event window for one machine. Mirroring is best-effort, so a throw here is caught and counted, never propagated. */
  listMachineEvents: (flyAppName: string, machineId: string) => Promise<MachineEvent[]>;
  now: () => Date;
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

/** Why a stop happened. `insolvent` parks the app instead of merely stopping it — the credit gate refusing to keep it awake. */
export type StopReason = 'idle' | 'insolvent' | 'operator';

export type StopPublishedAppResult =
  | { outcome: 'stopped'; status: 'stopped' | 'parked'; billedSeconds: number }
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

  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  if (!row) return { outcome: 'refused', reason: 'not_found' };
  if (row.status !== 'running') return { outcome: 'refused', reason: 'not_running' };

  const nextStatus: 'stopped' | 'parked' = reason === 'insolvent' ? 'parked' : 'stopped';
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

  const settled = await settleAndClose(row, stoppedAt, nextStatus, stoppedAt, deps);
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
  /** The settle threw. The window is left OPEN so the next tick retries it rather than losing it. */
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
 */
async function settleAndClose(
  row: PublishedApp,
  billedThrough: Date,
  nextStatus: 'stopped' | 'parked',
  stampedStopAt: Date,
  deps: AppLifecycleMeteringDeps,
): Promise<SettleAndCloseResult> {
  const plan = planAwakeSettle({ billedThrough: row.awakeBilledThrough, now: billedThrough });
  let billedSeconds = 0;
  if (plan.action === 'settle') {
    const payerId = await deps.billing.resolvePayerId({ driveId: row.driveId });
    if (payerId) {
      try {
        await deps.billing.trackUsage({
          payerId,
          holdId: row.awakeHoldId ?? undefined,
          activeSeconds: plan.activeSeconds,
          driveId: row.driveId,
          publishedAppId: row.id,
        });
        billedSeconds = plan.activeSeconds;
      } catch (error) {
        // The window is NOT closed on a failed settle: leaving it open means the
        // next heartbeat retries the whole span, where closing it would silently
        // lose the app's last awake window. The status still moves below — the
        // machine really did stop, and leaving a `running` row over it would be
        // worse than a window that gets retried.
        loggers.ai.error(
          'Published-app final settle failed — the awake window stays open for the next tick to retry',
          error instanceof Error ? error : new Error(String(error)),
          { publishedAppId: row.id, driveId: row.driveId, activeSeconds: plan.activeSeconds },
        );
        await closeStatusOnly(row, nextStatus, stampedStopAt);
        return { billedSeconds: 0, failed: true };
      }
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
    })
    .where(and(eq(publishedApps.id, row.id), eq(publishedApps.status, 'running')));
  return { billedSeconds, failed: false };
}

/**
 * Close the STATUS without closing the billing window — the failed-settle path.
 * `awakeBilledThrough` deliberately survives, so the unbilled span is retried
 * instead of being forgiven, while the row stops claiming to be running.
 */
async function closeStatusOnly(
  row: PublishedApp,
  nextStatus: 'stopped' | 'parked',
  stampedStopAt: Date,
): Promise<void> {
  await db
    .update(publishedApps)
    .set({ status: nextStatus, lastStopAt: stampedStopAt })
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
