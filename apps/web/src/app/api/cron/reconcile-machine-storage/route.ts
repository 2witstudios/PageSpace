import {
  defaultReconcileSandboxStorageDeps,
  reconcileSandboxStorageSerialized,
} from '@pagespace/lib/services/sandbox/sandbox-storage-billing';
import * as Sentry from '@sentry/nextjs';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that meters PERSISTENT-storage cost (Sprites Platform
 * Alignment 6-1). The platform bills for the bytes a sandbox has ACTUALLY
 * written (TRIM-friendly), not the provisioned allocation, so this bills EVERY
 * known sandbox — active or hibernating — from its last PERSISTED MEASURED
 * footprint. It NEVER wakes a sprite to measure; a never-measured row bills a
 * conservative 0 for that window.
 *
 * TWO persistence units, ONE meter and ONE schedule: agent SESSIONS (billed to
 * the session's drive owner, or to its own owner for a global-assistant
 * session) and drive ENVIRONMENTS (billed to the DRIVE OWNER, with no
 * fallback — an unresolvable drive skips the cycle rather than misattributing
 * a charge). Envs joined as a row source deliberately, rather than as a second
 * cron: the counters below aggregate both, and there is exactly one advisory
 * lock standing between a rolling deploy and a double-bill.
 *
 * A tick that accomplished nothing it should have — a row source that could not
 * be READ, or a run where EVERY row failed to bill — raises a SENTRY alert and
 * fails this endpoint (500, after the work that succeeded is reported). Either
 * one, left reporting success, is a permanently green cron quietly metering
 * nothing. The source-read failure is still isolated INSIDE the reconcile, so
 * one unreadable unit never stops the other's billing; what changes here is only
 * how the tick is reported.
 *
 * The Sentry call is the part that actually alerts, and it is not belt-and-braces:
 * the docker cron invokes this through `cron-curl`, which runs `curl -sS`
 * WITHOUT `-f`, so curl exits 0 on an HTTP 500 and the crontab's `|| echo`
 * fallback never fires — the 500's body just lands in the log looking like any
 * other tick. The status code is still the honest answer for any caller that
 * checks one (a manual trigger, an HTTP monitor), but on its own it would be
 * decorative here. Same shape, and the same reasoning, as
 * `verify-db-backup-freshness`.
 *
 * Path kept as `reconcile-machine-storage` (Phase 8 teardown renamed the
 * body, not the cron path or its advisory-lock key — both are external
 * contracts: the scheduler config references this URL, and the lock name
 * must stay identical across a rolling deploy).
 *
 * Idempotent / drift-correcting for SEQUENTIAL runs: each session tracks its
 * own last-billed watermark, so a rerun bills zero elapsed time and a missed
 * run is caught up exactly on the next one — see `reconcileSandboxStorage`
 * in @pagespace/lib. CONCURRENT invocations are made safe by
 * `reconcileSandboxStorageSerialized`'s Postgres advisory try-lock: a run that
 * cannot acquire it (another container, or a manual/API trigger, already
 * holds it) no-ops cleanly instead of racing the charge + watermark-advance
 * writes. The docker/cron crontab flock (defense in depth) still serializes
 * this ONE container's own scheduled ticks; the advisory lock is what makes
 * every OTHER caller overlap-safe too.
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
    const run = await reconcileSandboxStorageSerialized(defaultReconcileSandboxStorageDeps);

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Terminal storage reconcile: skipped — advisory lock held by another run');
      return NextResponse.json({
        success: true,
        outcome: 'lock_busy',
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[Cron] Terminal storage reconcile: processed ${run.processed}, charged ${run.charged}, skipped ${run.skipped}, failed ${run.failed}, chargedButUnadvanced ${run.chargedButUnadvanced}, stale ${run.staleMeasurements}, superseded ${run.watermarkSuperseded}, neverMeasured ${run.neverMeasured} (sessions ${run.measurementHealth.session.neverMeasured}/${run.measurementHealth.session.live}, envs ${run.measurementHealth.env.neverMeasured}/${run.measurementHealth.env.live}), failedSources [${run.failedSources.join(', ')}], total $${run.totalCostDollars.toFixed(6)}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_machine_storage',
      details: {
        processed: run.processed,
        charged: run.charged,
        skipped: run.skipped,
        failed: run.failed,
        chargedButUnadvanced: run.chargedButUnadvanced,
        staleMeasurements: run.staleMeasurements,
        // A non-zero `neverMeasured` that persists across runs is storage being
        // held and not charged for — the one failure this meter cannot see any
        // other way. `failedSources` names a persistence unit that went entirely
        // unread this tick.
        neverMeasured: run.neverMeasured,
        // A generation boundary landed mid-tick and the monotonic watermark
        // guard declined the advance — bounded, safe-direction, but counted
        // rather than invisible.
        watermarkSuperseded: run.watermarkSuperseded,
        // Split per persistence unit: an env's baseline-only measurement makes
        // its stale count saturate by construction, which would otherwise drown
        // a genuine session-side measurement outage in the flat totals.
        measurementHealth: run.measurementHealth,
        failedSources: run.failedSources,
        totalCostDollars: run.totalCostDollars,
      },
    });

    // A tick that could not READ a persistence unit is not a success, even
    // though it billed everything it could see.
    //
    // Before envs were folded in, a row-source failure propagated out of the
    // reconcile and landed in the catch below as a 500. `listSource`
    // deliberately stopped that from aborting the tick (an env-side read error
    // must never stop SESSION billing), but reporting the result as a green 200
    // would trade one silence for another: a deployment where `drive_envs` is
    // unmigrated or unreadable fails on EVERY tick, so "it accrues and is caught
    // up next tick" never comes true, and the loggers this repo does not route
    // to Sentry are the only trace. So the work is done and reported in full,
    // and THEN this alerts and fails — see the module doc on why the alert, not
    // the status code, is what actually reaches a human here.
    // TWO ways this tick can have accomplished nothing it should have, and
    // neither is a success even though the process did not crash.
    //
    // A row source that could not be READ is the first: its rows went unmetered
    // entirely. A tick where EVERY row failed is the second, and it is the same
    // silence one level down — a persistent fault reading `drives` (a
    // permissions regression, schema drift) makes the payer lookup throw for
    // every subject, so `failed === processed`, nothing is charged, and without
    // this the cron reports success on every tick forever.
    //
    // `chargedButUnadvanced` is deliberately NOT an alert condition: it is the
    // documented crash-window residual, bounded to one re-billed window, and it
    // is already counted, logged and audited.
    const alertReason =
      run.failedSources.length > 0
        ? `could not read row source(s): ${run.failedSources.join(', ')}`
        : run.processed > 0 && run.failed === run.processed
          ? `every row failed to bill (${run.failed} of ${run.processed})`
          : null;

    if (alertReason) {
      // Fingerprinted on the CAUSE, never the message: the message carries
      // changing counts and would open a fresh issue per tick, burying a fault
      // that recurs hourly in noise.
      const fingerprint =
        run.failedSources.length > 0
          ? ['storage-reconcile-source-unreadable', ...run.failedSources]
          : ['storage-reconcile-all-rows-failed'];
      Sentry.captureException(new Error(`Storage reconcile ${alertReason}`), {
        level: 'error',
        fingerprint,
        tags: {
          check: 'storage_reconcile',
          reason: run.failedSources.length > 0 ? 'source_unreadable' : 'all_rows_failed',
          failedSources: run.failedSources.join(','),
        },
        extra: {
          processed: run.processed,
          charged: run.charged,
          failed: run.failed,
          skipped: run.skipped,
          totalCostDollars: run.totalCostDollars,
        },
      });
      // `flush` resolves false when the queue did not drain OR when no client is
      // initialised — and that second case is the dangerous one, because then
      // `captureException` was a no-op too and this alert vanished silently. The
      // logger is a deliberately separate channel so a Sentry outage still leaves
      // evidence, and `alertDelivered` rides in the body so an HTTP monitor can
      // see the answer without Sentry being involved at all.
      let alertDelivered = false;
      try {
        alertDelivered = await Sentry.flush(2000);
      } catch (flushError) {
        loggers.system.error(
          '[Cron] Storage reconcile: Sentry.flush threw — the alert was almost certainly not delivered',
          flushError as Error,
        );
      }
      if (!alertDelivered) {
        loggers.system.error(
          '[Cron] Storage reconcile: a tick failed and the Sentry alert did NOT confirm delivery — ' +
            'either the transport is failing or no client is initialised, in which case captureException was a no-op. ' +
            'Check SENTRY_DSN and the transport.',
        );
      }

      return NextResponse.json(
        {
          success: false,
          error: `storage reconcile ${alertReason}`,
          alertDelivered,
          processed: run.processed,
          charged: run.charged,
          skipped: run.skipped,
          failed: run.failed,
          chargedButUnadvanced: run.chargedButUnadvanced,
          staleMeasurements: run.staleMeasurements,
          neverMeasured: run.neverMeasured,
          watermarkSuperseded: run.watermarkSuperseded,
          measurementHealth: run.measurementHealth,
          failedSources: run.failedSources,
          totalCostDollars: run.totalCostDollars,
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      processed: run.processed,
      charged: run.charged,
      skipped: run.skipped,
      failed: run.failed,
      chargedButUnadvanced: run.chargedButUnadvanced,
      staleMeasurements: run.staleMeasurements,
      neverMeasured: run.neverMeasured,
      watermarkSuperseded: run.watermarkSuperseded,
      measurementHealth: run.measurementHealth,
      failedSources: run.failedSources,
      totalCostDollars: run.totalCostDollars,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling terminal storage', error as Error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
