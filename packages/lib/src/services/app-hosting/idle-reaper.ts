/**
 * idle-reaper — the thing that actually stops a published app.
 *
 * Published machines run with `autostop: "off"`. That is the decision the whole
 * metering design rests on (every awake boundary is an API call we made, at an
 * instant we know exactly, rather than a proxy behaviour we would have to infer)
 * and its unavoidable consequence is that NOTHING STOPS AN APP UNLESS WE DO. Fly's
 * own proxy stop loop is off; there is no idle timeout anywhere else in the
 * pipeline. Without this cron, "scale to zero" is a claim rather than a behaviour,
 * and every app anybody has ever visited bills awake-seconds forever.
 *
 * THE STOP IS THE SETTLE BOUNDARY. This module does not price anything and does not
 * touch the ledger: it decides WHICH apps are idle and hands each to
 * `stopPublishedApp`, which stops the machine, mirrors the boundary and runs the
 * final settle — the one path where an awake window is closed. A parallel settle
 * here would be a second answer to the same question, which for money is the same
 * as a wrong one.
 *
 * WHAT COUNTS AS ACTIVITY: the router's throttled `lastHitAt` stamp, floored by
 * `lastWakeAt` (see `planIdleStop`). Both are our own records; neither asks Fly
 * anything. An app being driven by traffic that never passes through our router
 * (a direct 6PN caller) looks idle here, and stopping it is correct — such traffic
 * bypasses the balance gate too.
 *
 * NEVER THROWS out of {@link reapIdlePublishedApps}: every row is isolated and the
 * row source's own failure is a value, exactly as in the awake meter. One app whose
 * stop fails must not leave the rest of the fleet awake.
 *
 * Dark behind `APP_HOSTING_ENABLED`: a disabled deployment reports `disabled` and
 * reads nothing at all.
 */

import { and, eq, isNull, lt, or, sql } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { loggers } from '../../logging/logger-config';
import { isAppHostingEnabled, resolveIdleStopSeconds } from './app-hosting-env';
import { planIdleStop, type IdleStopKeep } from './app-metering-core';
import {
  stopPublishedApp,
  type StopPublishedAppResult,
} from './app-lifecycle-metering';

/** The columns the idle decision reads. Narrower than the row on purpose. */
export type ReapableApp = Pick<PublishedApp, 'id' | 'driveId' | 'tier' | 'lastHitAt' | 'lastWakeAt'>;

export interface IdleReaperDeps {
  isEnabled: () => boolean;
  /**
   * Candidate rows — `running` apps that MIGHT be idle.
   *
   * A prefilter, not the decision: it exists so a fleet of busy apps is not dragged
   * through the app server row by row, and it is deliberately looser than
   * `planIdleStop` (which re-judges every row it returns against the tick's single
   * clock). A row that slips through the prefilter and turns out to be active is
   * kept and counted; a row the prefilter wrongly excludes is simply reaped one tick
   * later. Erring loose is the safe direction for a filter whose failure mode on the
   * tight side is "a machine nobody stops".
   */
  listIdleCandidates: (input: { idleSeconds: number; now: Date }) => Promise<ReapableApp[]>;
  /** The stop seam — the ONLY place an awake window is closed. */
  stop: (publishedAppId: string) => Promise<StopPublishedAppResult>;
  /** The idle threshold in seconds, read at call time. 0 disables reaping. */
  idleStopSeconds: () => number;
  now: () => Date;
}

export const defaultIdleReaperDeps: IdleReaperDeps = {
  isEnabled: isAppHostingEnabled,

  /**
   * `running` rows whose last activity is older than the threshold, plus rows with
   * no activity stamp at all.
   *
   * The stampless rows are fetched ON PURPOSE even though `planIdleStop` always
   * keeps them: they are an anomaly (a `running` row we have no boundary for) that
   * this cron is the natural place to count, and excluding them here would make the
   * counter permanently zero and the anomaly invisible.
   *
   * DEDICATED APPS ARE NEVER REAPED. The flat-rate tier is sold as always-on
   * (`min_machines_running = 1`); stopping one is not an optimization, it is an
   * outage of a thing somebody is paying a monthly fee to keep up.
   */
  async listIdleCandidates({ idleSeconds, now }) {
    // The cutoff is computed from the tick's own captured clock rather than from
    // the database's `now()`, so the prefilter and the pure planner judge every row
    // against the SAME instant. Two clocks here would mean rows selected under one
    // and decided under another.
    const cutoff = new Date(now.getTime() - idleSeconds * 1000);
    return db
      .select({
        id: publishedApps.id,
        driveId: publishedApps.driveId,
        tier: publishedApps.tier,
        lastHitAt: publishedApps.lastHitAt,
        lastWakeAt: publishedApps.lastWakeAt,
      })
      .from(publishedApps)
      .where(
        and(
          eq(publishedApps.status, 'running'),
          eq(publishedApps.tier, 'metered'),
          // BOTH stamps must be older than the cutoff (a NULL stamp counting as
          // "not recent"), which is the SQL spelling of `planIdleStop`'s "recency
          // is the LATER of the two". A row with neither stamp satisfies this and
          // is fetched deliberately — the planner keeps it, and the reaper counts
          // the anomaly rather than making it invisible.
          or(isNull(publishedApps.lastHitAt), lt(publishedApps.lastHitAt, sql.param(cutoff, publishedApps.lastHitAt))),
          or(isNull(publishedApps.lastWakeAt), lt(publishedApps.lastWakeAt, sql.param(cutoff, publishedApps.lastWakeAt))),
        ),
      );
  },

  stop: (publishedAppId) => stopPublishedApp(publishedAppId, 'idle'),

  idleStopSeconds: resolveIdleStopSeconds,

  now: () => new Date(),
};

export interface ReapIdleResult {
  /** Candidate rows examined this tick. */
  processed: number;
  /** Apps whose machine was stopped and whose awake window was settled and closed. */
  stopped: number;
  /** Awake seconds the stops' final settles billed — the money this tick stopped accruing. */
  settledSeconds: number;
  /** Candidates the planner judged still active (a hit landed between the prefilter and the decision). */
  active: number;
  /** `running` rows with NO activity stamp at all. Left alone; the heartbeat meter back-fills one. */
  noActivitySignal: number;
  /**
   * Stops the awake meter's advisory lock declined — a heartbeat tick was pricing
   * the fleet. Nothing was read or billed, and the next tick reaps the app.
   */
  lockBusy: number;
  /** Stops the status machine or the feature flag refused (the app stopped under us, a machine that is gone). */
  refused: number;
  /** Stops Fly rejected. The window stays OPEN and keeps billing — the machine may well still be running. */
  stopFailed: number;
  /** Rows where something threw. Isolated; nothing is left half-done because the stop seam owns its own ordering. */
  failed: number;
  /** The threshold this tick used, echoed for the operator reading a log line. */
  idleSeconds: number;
  /** The row source itself failed; nothing was reaped and the fleet stays awake until the next tick. */
  sourceFailed: boolean;
}

const EMPTY_RESULT: Omit<ReapIdleResult, 'idleSeconds'> = {
  processed: 0,
  stopped: 0,
  settledSeconds: 0,
  active: 0,
  noActivitySignal: 0,
  lockBusy: 0,
  refused: 0,
  stopFailed: 0,
  failed: 0,
  sourceFailed: false,
};

export type ReapIdleRun =
  | { outcome: 'disabled' }
  /** Idle reaping is switched off by configuration (`PUBLISHED_APP_IDLE_STOP_SECONDS=0`) — reported, never silently treated as a clean tick. */
  | { outcome: 'reaping_disabled' }
  | ({ outcome: 'reaped' } & ReapIdleResult);

/**
 * Stop every published app that has gone quiet.
 *
 * NEVER THROWS. The row source's failure is a value (`sourceFailed`) and each app
 * is isolated: an app whose stop rejects must not keep the rest of the fleet awake,
 * which is the same reasoning — and the same shape — as the awake meter's per-row
 * isolation.
 */
export async function reapIdlePublishedApps(
  deps: IdleReaperDeps = defaultIdleReaperDeps,
): Promise<ReapIdleRun> {
  if (!deps.isEnabled()) return { outcome: 'disabled' };

  const idleSeconds = deps.idleStopSeconds();
  // Asked before the row source, not after: a disabled reaper must read nothing
  // rather than read the fleet and then decline to act on it.
  if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) return { outcome: 'reaping_disabled' };

  const result: ReapIdleResult = { ...EMPTY_RESULT, idleSeconds };
  // ONE clock for the whole tick, captured before any await — the prefilter's
  // cutoff and every row's decision are derived from it, so no two rows are judged
  // against different instants.
  const now = deps.now();

  let rows: ReapableApp[];
  try {
    rows = await deps.listIdleCandidates({ idleSeconds, now });
  } catch (error) {
    loggers.ai.error(
      'Published-app idle reaper could not list candidates — nothing was stopped this tick',
      error instanceof Error ? error : new Error(String(error)),
    );
    return { outcome: 'reaped', ...result, sourceFailed: true };
  }

  result.processed = rows.length;
  for (const row of rows) {
    try {
      await reapOneApp(row, now, idleSeconds, deps, result);
    } catch (error) {
      result.failed += 1;
      loggers.ai.error(
        'Published-app idle reaper failed for one app — it stays running and is retried next tick',
        error instanceof Error ? error : new Error(String(error)),
        { publishedAppId: row.id, driveId: row.driveId },
      );
    }
  }
  return { outcome: 'reaped', ...result };
}

const KEEP_COUNTER: Record<IdleStopKeep, keyof Pick<ReapIdleResult, 'active' | 'noActivitySignal'> | null> = {
  // Unreachable here — `reapIdlePublishedApps` returns before any row is read when
  // the threshold is off — but mapped rather than defaulted, so a future keep
  // reason has to be given a home instead of silently falling into `active`.
  disabled: null,
  active: 'active',
  no_activity_signal: 'noActivitySignal',
};

async function reapOneApp(
  row: ReapableApp,
  now: Date,
  idleSeconds: number,
  deps: IdleReaperDeps,
  result: ReapIdleResult,
): Promise<void> {
  const plan = planIdleStop({ lastHitAt: row.lastHitAt, lastWakeAt: row.lastWakeAt, now, idleSeconds });
  if (plan.action === 'keep') {
    const counter = KEEP_COUNTER[plan.reason];
    if (counter) result[counter] += 1;
    return;
  }

  const stopped = await deps.stop(row.id);
  switch (stopped.outcome) {
    case 'stopped':
      result.stopped += 1;
      result.settledSeconds += stopped.billedSeconds;
      return;
    case 'lock_busy':
      // The heartbeat is pricing the fleet right now. Nothing was read, stopped or
      // billed, and the row is still `running`, so the next tick finds it again.
      result.lockBusy += 1;
      return;
    case 'stop_failed':
      // The window stays open deliberately (see `stopPublishedApp`): a failed stop
      // most likely means the machine is still up and still costing money. Loud,
      // because it is the one outcome where a machine we asked to stop did not.
      result.stopFailed += 1;
      loggers.ai.error(
        'Published-app idle stop was refused by Fly — the machine may still be running and billing',
        new Error(stopped.error),
        { publishedAppId: row.id, driveId: row.driveId },
      );
      return;
    case 'refused':
      // The app stopped, parked or lost its machine between the prefilter and the
      // stop. Ordinary, and self-correcting: it is no longer costing awake-seconds.
      result.refused += 1;
      return;
  }
}

/**
 * Advisory-lock key serializing the REAPER across every caller — a second
 * container, a manual trigger, an API invocation.
 *
 * Deliberately NOT the awake meter's key. This lock covers the fleet SCAN, which
 * lasts as long as one Fly stop per idle app; the meter's key is taken and released
 * per-app by `stopPublishedApp` inside that scan. Sharing one key would mean a
 * reaper run blocking every heartbeat for the whole length of the scan, and a
 * heartbeat blocking the reaper for a whole tick.
 */
const REAP_IDLE_LOCK_KEY = 'reap-published-apps-idle';

export type ReapIdleRunResult = { outcome: 'lock_busy' } | ReapIdleRun;

/**
 * Serialize the reaper with a Postgres session-level advisory try-lock: a run that
 * cannot acquire it is a clean no-op and never reads a row or stops a machine.
 *
 * Two overlapping reaper runs would not double-bill (the stop seam settles under
 * the meter's own lock, and its status write is a compare-and-set), but they would
 * each issue a Fly stop for the same machine and the loser's would fail — turning a
 * routine tick into an error signal for a machine that is doing exactly what it was
 * asked to do.
 */
export async function reapIdlePublishedAppsSerialized(
  deps: IdleReaperDeps = defaultIdleReaperDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<ReapIdleRunResult> {
  const locked = await withAdvisoryLock(pgPool, REAP_IDLE_LOCK_KEY, () => reapIdlePublishedApps(deps));
  if (locked.outcome === 'lock_busy') return { outcome: 'lock_busy' };
  if (locked.outcome === 'connection_error') throw locked.error;
  return locked.result;
}
