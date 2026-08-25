/**
 * awake-reconcile — the WEEKLY check of what we billed against what Fly's managed
 * Prometheus says actually ran.
 *
 * THREE RECORDS, RANKED. Our own start/stop calls are primary — `autostop` is off
 * so every boundary is an API call we made. The local event mirror is where those
 * boundaries are KEPT, because Fly's own event log holds only the last 20 entries
 * and cannot be paged or time-filtered: history is not rebuildable from it, which
 * is why the mirror is the source of truth and this reconcile is a check on it.
 * Managed Prometheus is the third, independent leg, retained about 15 days.
 *
 * WHY WEEKLY, AND WHY THAT IS THE CEILING. ~15 days of retention means a
 * disagreement older than that can never be examined again. Weekly leaves a full
 * window of slack for a missed run; a monthly cadence would routinely be asking
 * about samples that no longer exist.
 *
 * IT COMPARES AND ALERTS. IT DOES NOT MOVE MONEY. A scraped gauge is not evidence
 * of a charge: it samples every ~15s, its series goes absent rather than zero when
 * a machine is down, and its scrape interval is a constant we have not yet verified
 * against a live org. Auto-adjusting a customer's ledger from that would let one
 * metrics artifact issue refunds or back-charges nobody reviewed. What drift buys
 * is a NAMED, DIRECTIONAL signal — `over_billed` (a customer was charged for time
 * Fly did not see: the serious one) versus `under_billed` (a boundary we never
 * recorded: the platform's own loss) — and an operator decides what, if anything,
 * to do about it while the window is still open.
 *
 * NEVER THROWS, and inert when unconfigured: no Prometheus credential means a
 * counter and a clean skip, never an error. The feature ships dark.
 */

import { ne } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import { isAppHostingEnabled } from './app-hosting-env';
import { listBoundaryEvents } from './app-machine-events';
import { awakeSecondsFromEvents, evaluateAwakeDrift, type AwakeDrift } from './app-metering-core';
import {
  queryAwakeSeconds,
  resolveFlyPrometheus,
  type FlyPrometheusConfig,
} from '../fly/prometheus-client';

/**
 * The window each run compares, in days.
 *
 * Comfortably inside Prometheus' ~15-day retention AND at least the cadence, so a
 * single missed weekly run still leaves every day covered by the next one. Widening
 * this past retention would silently compare against samples that no longer exist,
 * which reads as a fleet-wide `under_billed` drift rather than as missing data.
 */
export const AWAKE_RECONCILE_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AwakeReconcileDeps {
  isEnabled: () => boolean;
  /** Null when no Prometheus credential/org slug is configured — the reconcile then skips cleanly. */
  resolvePrometheus: () => FlyPrometheusConfig | null;
  /** Every app worth checking. Rows mid-teardown are excluded by the default binding. */
  listApps: () => Promise<Array<{ id: string; driveId: string; flyAppName: string }>>;
  /** Our own mirrored boundaries for one app inside the window. */
  listBoundaries: (
    publishedAppId: string,
    from: Date,
    until: Date,
  ) => Promise<Array<{ action: 'start' | 'stop'; occurredAt: Date }>>;
  /** Fly's independent figure. Null when the app has no series at all. */
  queryAwakeSeconds: (flyAppName: string, windowSeconds: number) => Promise<number | null>;
  now: () => Date;
}

export const defaultAwakeReconcileDeps: AwakeReconcileDeps = {
  isEnabled: isAppHostingEnabled,
  resolvePrometheus: resolveFlyPrometheus,

  async listApps() {
    // `destroying` rows are excluded: their Fly app is being torn down, so a
    // disagreement about it is expected rather than informative.
    return db
      .select({ id: publishedApps.id, driveId: publishedApps.driveId, flyAppName: publishedApps.flyAppName })
      .from(publishedApps)
      .where(ne(publishedApps.status, 'destroying'));
  },

  listBoundaries: (publishedAppId, from, until) => listBoundaryEvents(publishedAppId, from, until),

  async queryAwakeSeconds(flyAppName, windowSeconds) {
    const config = resolveFlyPrometheus();
    // Unreachable in the normal flow (`reconcileAwakeSeconds` resolves the config
    // before it ever gets here), and still handled: a partially-configured
    // deployment must skip rather than throw at the first app.
    if (!config) return null;
    return queryAwakeSeconds(config, flyAppName, windowSeconds);
  },

  now: () => new Date(),
};

/** One app's disagreement, kept whole so an operator can see both sides rather than only the delta. */
export interface AwakeDriftReport {
  publishedAppId: string;
  driveId: string;
  flyAppName: string;
  localSeconds: number;
  prometheusSeconds: number;
  drift: AwakeDrift;
}

export interface AwakeReconcileResult {
  processed: number;
  /** Apps compared against a real Prometheus figure. */
  compared: number;
  /** Apps with no `fly_instance_up` series at all — never woken, or aged out of retention. Not a fault. */
  noSeries: number;
  /** Apps whose comparison threw (a Prometheus outage, a bad read). Isolated per app. */
  failed: number;
  /** Apps whose drift exceeded the tolerance. The number an operator actually reads. */
  drifted: number;
  /** The drifted apps, worst first. Capped for reporting; `drifted` is the true count. */
  reports: AwakeDriftReport[];
  windowDays: number;
}

export type AwakeReconcileRun =
  | { outcome: 'disabled' }
  /** No Prometheus org slug or token configured. Inert by design, not an error. */
  | { outcome: 'unconfigured' }
  | ({ outcome: 'reconciled' } & AwakeReconcileResult);

/** How many drift reports a run returns. The count is exact; the LIST is capped so one bad deploy cannot produce a megabyte of cron output. */
export const MAX_DRIFT_REPORTS = 25;

/**
 * Compare each app's mirrored awake-seconds against managed Prometheus.
 *
 * NEVER THROWS. Each app is isolated: a Prometheus outage mid-run leaves the
 * apps already compared reported and the rest counted as failures, rather than
 * discarding a whole run's findings.
 */
export async function reconcileAwakeSeconds(
  deps: AwakeReconcileDeps = defaultAwakeReconcileDeps,
): Promise<AwakeReconcileRun> {
  if (!deps.isEnabled()) return { outcome: 'disabled' };
  if (!deps.resolvePrometheus()) return { outcome: 'unconfigured' };

  const now = deps.now();
  const windowSeconds = AWAKE_RECONCILE_WINDOW_DAYS * 24 * 60 * 60;
  const from = new Date(now.getTime() - AWAKE_RECONCILE_WINDOW_DAYS * MS_PER_DAY);

  let apps: Array<{ id: string; driveId: string; flyAppName: string }>;
  try {
    apps = await deps.listApps();
  } catch (error) {
    loggers.ai.error(
      'Published-app awake reconcile could not list apps — nothing was compared this run',
      error instanceof Error ? error : new Error(String(error)),
    );
    return {
      outcome: 'reconciled',
      processed: 0,
      compared: 0,
      noSeries: 0,
      failed: 1,
      drifted: 0,
      reports: [],
      windowDays: AWAKE_RECONCILE_WINDOW_DAYS,
    };
  }

  const result: AwakeReconcileResult = {
    processed: apps.length,
    compared: 0,
    noSeries: 0,
    failed: 0,
    drifted: 0,
    reports: [],
    windowDays: AWAKE_RECONCILE_WINDOW_DAYS,
  };

  for (const app of apps) {
    try {
      const prometheusSeconds = await deps.queryAwakeSeconds(app.flyAppName, windowSeconds);
      if (prometheusSeconds === null) {
        result.noSeries += 1;
        continue;
      }
      const boundaries = await deps.listBoundaries(app.id, from, now);
      // Deliberately computed from BOUNDARIES, not from the billing watermark. The
      // watermark says what we charged; comparing it against Prometheus would be
      // comparing our arithmetic against itself. Boundaries say what the machine
      // did, which is the thing Prometheus also measured.
      const localSeconds = awakeSecondsFromEvents(boundaries, now);
      const drift = evaluateAwakeDrift({ localSeconds, prometheusSeconds });
      result.compared += 1;
      if (drift.exceeded) {
        result.drifted += 1;
        result.reports.push({
          publishedAppId: app.id,
          driveId: app.driveId,
          flyAppName: app.flyAppName,
          localSeconds,
          prometheusSeconds,
          drift,
        });
      }
    } catch (error) {
      result.failed += 1;
      loggers.ai.error(
        'Published-app awake reconcile failed for one app',
        error instanceof Error ? error : new Error(String(error)),
        { publishedAppId: app.id, flyAppName: app.flyAppName },
      );
    }
  }

  // Worst first, and OVER-BILLED ahead of under-billed at equal magnitude: one
  // costs a customer money and the other costs us. An operator reading a truncated
  // list should see the charges somebody may have to be refunded before the
  // revenue we failed to capture.
  result.reports.sort((a, b) => {
    const severity = (report: AwakeDriftReport) => (report.drift.direction === 'over_billed' ? 1 : 0);
    const bySeverity = severity(b) - severity(a);
    return bySeverity !== 0 ? bySeverity : b.drift.relative - a.drift.relative;
  });
  result.reports = result.reports.slice(0, MAX_DRIFT_REPORTS);
  return { outcome: 'reconciled', ...result };
}

/**
 * Advisory-lock key for the weekly reconcile. It moves no money, so the lock is
 * not protecting a ledger — it stops two containers (or a manual trigger racing
 * the schedule) from doubling a fleet-wide Prometheus query burst and reporting
 * the same drift twice.
 */
const AWAKE_RECONCILE_LOCK_KEY = 'reconcile-published-app-awake-seconds';

export type AwakeReconcileRunResult = { outcome: 'lock_busy' } | AwakeReconcileRun;

export async function reconcileAwakeSecondsSerialized(
  deps: AwakeReconcileDeps = defaultAwakeReconcileDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<AwakeReconcileRunResult> {
  const locked = await withAdvisoryLock(pgPool, AWAKE_RECONCILE_LOCK_KEY, () => reconcileAwakeSeconds(deps));
  if (locked.outcome === 'lock_busy') return { outcome: 'lock_busy' };
  if (locked.outcome === 'connection_error') throw locked.error;
  return locked.result;
}
