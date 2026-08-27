import {
  defaultIdleReaperDeps,
  reapIdlePublishedAppsSerialized,
} from '@pagespace/lib/services/app-hosting/idle-reaper';
import * as Sentry from '@sentry/nextjs';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that STOPS every published app that has gone quiet.
 *
 * Published machines run with `autostop: "off"` so that every awake boundary is an
 * API call we made at an instant we know exactly — which means nothing stops an app
 * unless this does. Without this tick, "scale to zero" is a claim rather than a
 * behaviour and every app anybody has ever visited bills awake-seconds forever.
 *
 * THE STOP IS THE SETTLE BOUNDARY. The reaper prices nothing itself: it decides
 * which apps are idle and hands each to `stopPublishedApp`, which stops the
 * machine, mirrors the boundary and runs the final settle. That stop takes the
 * awake meter's OWN advisory lock, so a stop-settle can never price the same window
 * a heartbeat tick is pricing.
 *
 * SHIPS DARK. `APP_HOSTING_ENABLED` unset makes the reaper report `disabled` and
 * read nothing — reported as a green 200. A dark feature must never redden a live
 * cron. `reaping_disabled` (the threshold configured to 0) is likewise green: an
 * operator turned it off on purpose.
 *
 * WHAT IS LOUD. Only conditions that mean the fleet is still awake and billing on a
 * feature that is actually running: a row source that could not be read at all
 * (nothing was reaped), and `stopFailed` (Fly refused a stop, so a machine we
 * decided to switch off is probably still running and still costing its payer
 * money, with its awake window deliberately left open). `lockBusy`, `refused` and
 * `active` and `stillCapped` are self-correcting per-row facts — the app is still
 * `running` (or still over its budget), so the next tick finds it again — and are
 * counted and audited rather than alerted on.
 *
 * As with the awake meter, the Sentry capture is what actually reaches a human: the
 * docker cron invokes this through `curl -sS` without `-f`, so an HTTP 500 exits 0
 * and its body lands in a log. The status code stays the honest answer for a caller
 * that checks one.
 *
 * IT ALSO OPENS THE DAILY CAP'S DOOR BACK OUT. The per-app awake counter resets at
 * midnight UTC; the `parked` status does not, and nothing else in the system ever
 * writes `parked -> stopped` for that reason. So each tick also releases the apps
 * whose budget has rolled over — without it, one busy day would take an app off the
 * internet permanently. A release that FAILS is loud for the opposite reason a
 * failed stop is: the app stays offline.
 *
 * CONCURRENCY: `reapIdlePublishedAppsSerialized` holds a Postgres advisory try-lock
 * for the whole run, so a second container, a manual trigger or an API invocation
 * racing the schedule is a clean no-op rather than two stop calls for one machine.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce,
 * X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const run = await reapIdlePublishedAppsSerialized(defaultIdleReaperDeps);

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Published-app idle reaper: skipped — advisory lock held by another run');
      return NextResponse.json({ success: true, outcome: 'lock_busy', timestamp: new Date().toISOString() });
    }

    if (run.outcome === 'disabled') {
      // Not a failure and not an anomaly: APP_HOSTING_ENABLED is off, which is the
      // default everywhere. Reported green so the cron stays quiet until the feature
      // is switched on.
      return NextResponse.json({ success: true, outcome: 'disabled', timestamp: new Date().toISOString() });
    }

    if (run.outcome === 'reaping_disabled') {
      // An operator holding the fleet awake on purpose — green. The UNPARK sweep
      // still ran (switching off idle stopping says nothing about whether an app
      // parked by yesterday's budget should stay parked forever), so its counters
      // come back with it.
      console.log(
        `[Cron] Published-app idle reaper: reaping disabled — unparked ${run.unparked}, stillCapped ${run.stillCapped}, unparkFailed ${run.unparkFailed}`,
      );
      return NextResponse.json({ success: true, ...run, timestamp: new Date().toISOString() });
    }

    console.log(
      `[Cron] Published-app idle reaper: processed ${run.processed}, stopped ${run.stopped}, active ${run.active}, noActivitySignal ${run.noActivitySignal}, lockBusy ${run.lockBusy}, refused ${run.refused}, stopFailed ${run.stopFailed}, failed ${run.failed}, unparked ${run.unparked}, stillCapped ${run.stillCapped}, unparkFailed ${run.unparkFailed}, settledSeconds ${run.settledSeconds.toFixed(1)} (idle threshold ${run.idleSeconds}s)`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reap_idle_apps',
      details: {
        processed: run.processed,
        stopped: run.stopped,
        settledSeconds: run.settledSeconds,
        active: run.active,
        // A `running` row with no wake and no hit stamp — a machine we have no
        // boundary for. Left alone by design and back-filled by the awake meter's
        // next tick, so a count that stays above zero means the two crons disagree
        // about the fleet.
        noActivitySignal: run.noActivitySignal,
        lockBusy: run.lockBusy,
        refused: run.refused,
        stopFailed: run.stopFailed,
        failed: run.failed,
        // The daily cap's door back out: apps released because their counter rolled
        // over to a new UTC day. Without this the cap is a one-way door — the
        // counter resets at midnight and the status does not.
        unparked: run.unparked,
        stillCapped: run.stillCapped,
        unparkFailed: run.unparkFailed,
        idleSeconds: run.idleSeconds,
        sourceFailed: run.sourceFailed,
      },
    });

    const alertReason = run.sourceFailed
      ? 'could not read its row source — no idle app was stopped this tick'
      : run.stopFailed > 0
        ? `could not stop ${run.stopFailed} idle app(s) — those machines may still be running and billing`
        : run.unparkFailed > 0
          ? // The other direction, and worth waking somebody for the opposite
            // reason: an app whose daily-cap park could not be released stays OFF
            // THE INTERNET, and nothing but this sweep ever reopens that door.
            `could not release ${run.unparkFailed} app(s) from a daily-cap park — those apps stay offline until a later tick succeeds`
          : null;

    if (alertReason) {
      Sentry.captureException(new Error(`Published-app idle reaper ${alertReason}`), {
        level: 'error',
        // Fingerprinted on the CAUSE, never the message: the message carries
        // changing counts and would open a fresh issue per tick.
        fingerprint: [
          run.sourceFailed
            ? 'idle-reaper-source-unreadable'
            : run.stopFailed > 0
              ? 'idle-reaper-stop-failed'
              : 'idle-reaper-unpark-failed',
        ],
        tags: {
          check: 'published_app_idle_reaper',
          reason: run.sourceFailed ? 'source_unreadable' : run.stopFailed > 0 ? 'stop_failed' : 'unpark_failed',
        },
        extra: {
          processed: run.processed,
          stopped: run.stopped,
          stopFailed: run.stopFailed,
          failed: run.failed,
          unparkFailed: run.unparkFailed,
          idleSeconds: run.idleSeconds,
        },
      });
      // Deliberately not awaiting `Sentry.flush` — a long-lived container drains its
      // own transport, and awaiting would add the flush timeout to every failing
      // tick for no guarantee this endpoint could act on.
      loggers.system.error(`[Cron] Published-app idle reaper FAILED: ${alertReason}`);
      return NextResponse.json(
        { success: false, error: `published-app idle reaper ${alertReason}`, ...run, timestamp: new Date().toISOString() },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, ...run, timestamp: new Date().toISOString() });
  } catch (error) {
    loggers.system.error('[Cron] Error reaping idle published apps', error as Error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
