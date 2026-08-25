import {
  defaultAwakeMeterDeps,
  meterAwakePublishedAppsSerialized,
} from '@pagespace/lib/services/app-hosting/awake-meter';
import * as Sentry from '@sentry/nextjs';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that HEARTBEAT-SETTLES every awake published app.
 *
 * A published app's machine runs with `autostop: "off"` so that every awake
 * boundary is an API call we made — but a machine can stay up for weeks between
 * those boundaries, and settling only at stop would leave the whole of that time
 * as an unbilled liability riding on one process not crashing. This tick bounds
 * that exposure to the cadence, exactly as the realtime shell handler settles a
 * live PTY rather than waiting for hangup. It also RE-GATES: the settle consumes
 * the wake's hold, so each tick re-holds, and a payer who has run out of credits
 * has their app stopped and parked instead of staying awake for free.
 *
 * SHIPS DARK. `APP_HOSTING_ENABLED` unset makes the meter report `disabled` and
 * read nothing — and, critically, that is reported as a green 200. A dark feature
 * must never redden a live cron.
 *
 * WHAT IS LOUD. Only conditions that mean real money went wrong on a feature that
 * is actually running: a row source that could not be read at all (nothing was
 * metered), and `settledButUnadvanced` (money moved and the window did not close,
 * so the same span WILL be billed again next tick — a genuine double-bill in
 * progress). `failed`, `unresolvedPayer` and `skipped` are per-row and
 * self-correcting: the window stays open and the next tick bills it in full, so
 * they are counted and audited rather than alerted on.
 *
 * As with the storage reconcile, the Sentry capture is what actually reaches a
 * human — the docker cron invokes this through `curl -sS` without `-f`, so an
 * HTTP 500 exits 0 and its body just lands in a log. The status code stays the
 * honest answer for a caller that checks one.
 *
 * CONCURRENCY: `meterAwakePublishedAppsSerialized` holds a Postgres advisory
 * try-lock for the whole run, so a second container, a manual trigger or an API
 * invocation racing the schedule is a clean no-op rather than a double-bill —
 * `trackUsage` and the watermark advance are two separate un-transactioned writes.
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
    const run = await meterAwakePublishedAppsSerialized(defaultAwakeMeterDeps);

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Published-app awake meter: skipped — advisory lock held by another run');
      return NextResponse.json({ success: true, outcome: 'lock_busy', timestamp: new Date().toISOString() });
    }

    if (run.outcome === 'disabled') {
      // Not a failure and not an anomaly: APP_HOSTING_ENABLED is off, which is
      // the default everywhere. Reported green so the cron stays quiet until the
      // feature is switched on.
      return NextResponse.json({ success: true, outcome: 'disabled', timestamp: new Date().toISOString() });
    }

    console.log(
      `[Cron] Published-app awake meter: processed ${run.processed}, settled ${run.settled}, repaired ${run.repaired}, stamped ${run.stamped}, skipped ${run.skipped}, unresolvedPayer ${run.unresolvedPayer}, parked ${run.parked}, failed ${run.failed}, clamped ${run.clamped}, superseded ${run.watermarkSuperseded}, settledButUnadvanced ${run.settledButUnadvanced}, awakeSeconds ${run.totalAwakeSeconds.toFixed(1)}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'meter_published_apps',
      details: {
        processed: run.processed,
        settled: run.settled,
        // A window closed at a mirrored stop boundary — a stop whose status write
        // was lost, repaired from the event mirror instead of billing a stopped
        // machine until the weekly reconcile noticed.
        repaired: run.repaired,
        // A `running` row that carried no window. Its clock was started at NOW and
        // nothing was billed for the unknown span; a count that stays above zero
        // means machines are being started outside the wake seam.
        stamped: run.stamped,
        skipped: run.skipped,
        unresolvedPayer: run.unresolvedPayer,
        parked: run.parked,
        failed: run.failed,
        // Expected to be ZERO in steady state: a settle whose span exceeded a day
        // and was shortened, which forgives revenue.
        clamped: run.clamped,
        watermarkSuperseded: run.watermarkSuperseded,
        settledButUnadvanced: run.settledButUnadvanced,
        totalAwakeSeconds: run.totalAwakeSeconds,
        sourceFailed: run.sourceFailed,
      },
    });

    const alertReason = run.sourceFailed
      ? 'could not read its row source — no app was metered this tick'
      : run.settledButUnadvanced > 0
        ? `settled ${run.settledButUnadvanced} app(s) whose watermark did not advance — those windows will be billed again next tick`
        : null;

    if (alertReason) {
      Sentry.captureException(new Error(`Published-app awake meter ${alertReason}`), {
        level: 'error',
        // Fingerprinted on the CAUSE, never the message: the message carries
        // changing counts and would open a fresh issue per tick.
        fingerprint: [run.sourceFailed ? 'awake-meter-source-unreadable' : 'awake-meter-settled-unadvanced'],
        tags: {
          check: 'published_app_awake_meter',
          reason: run.sourceFailed ? 'source_unreadable' : 'settled_but_unadvanced',
        },
        extra: {
          processed: run.processed,
          settled: run.settled,
          failed: run.failed,
          settledButUnadvanced: run.settledButUnadvanced,
          totalAwakeSeconds: run.totalAwakeSeconds,
        },
      });
      // Deliberately not awaiting `Sentry.flush` — a long-lived container drains
      // its own transport, and awaiting would add the flush timeout to every
      // failing tick for no guarantee this endpoint could act on.
      loggers.system.error(`[Cron] Published-app awake meter FAILED: ${alertReason}`);
      return NextResponse.json(
        { success: false, error: `published-app awake meter ${alertReason}`, ...run, timestamp: new Date().toISOString() },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, ...run, timestamp: new Date().toISOString() });
  } catch (error) {
    loggers.system.error('[Cron] Error metering published-app awake seconds', error as Error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
