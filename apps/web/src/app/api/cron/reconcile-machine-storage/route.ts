import {
  defaultReconcileSandboxStorageDeps,
  reconcileSandboxStorageSerialized,
} from '@pagespace/lib/services/sandbox/sandbox-storage-billing';
import * as Sentry from '@sentry/nextjs';
import type { StorageSubjectKind } from '@pagespace/lib/services/sandbox/sandbox-storage-reconcile';
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
 * A tick that accomplished nothing it should have raises a SENTRY alert and
 * fails this endpoint (500, after the work that succeeded is reported) — left
 * reporting success it would be a permanently green cron quietly metering
 * nothing. Source-read failures stay isolated INSIDE the reconcile, so one
 * unreadable unit never stops the other's billing; what changes here is only how
 * the tick is reported.
 *
 * Severity is split by whether the unit is LIVE. Envs ship dark, so an
 * unreadable `drive_envs` is captured as a warning and the tick still succeeds —
 * a dark feature must not redden a cron that is metering real sessions
 * correctly. The session source, and a whole-tick billing wipeout, are loud.
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
      `[Cron] Terminal storage reconcile: processed ${run.processed}, charged ${run.charged}, skipped ${run.skipped}, failed ${run.failed}, chargedButUnadvanced ${run.chargedButUnadvanced}, stale ${run.staleMeasurements}, superseded ${run.watermarkSuperseded}, spanClamped ${run.spanClamped}, billable ${run.billableRows}, neverMeasured ${run.neverMeasured} (sessions ${run.measurementHealth.session.neverMeasured}/${run.measurementHealth.session.live}, envs ${run.measurementHealth.env.neverMeasured}/${run.measurementHealth.env.live}), failedSources [${run.failedSources.join(', ')}], total $${run.totalCostDollars.toFixed(6)}`,
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
        // A row's window had been frozen for over a day and was capped rather
        // than billed retroactively at today's footprint.
        spanClamped: run.spanClamped,
        billableRows: run.billableRows,
        billingByKind: run.billingByKind,
        // Split per persistence unit: an env's baseline-only measurement makes
        // its stale count saturate by construction, which would otherwise drown
        // a genuine session-side measurement outage in the flat totals.
        //
        // These count ROWS, not outcomes — `live` includes rows the tick then
        // SKIPPED for an unresolvable payer. Measurement staleness is a fact
        // about the row either way; do not read `live` as "billed".
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

    // WHICH failures are allowed to redden a LIVE billing cron.
    //
    // The rule is that a dark feature must not page anyone. Envs ship dark and
    // nothing provisions them yet, so an unreadable `drive_envs` — an unmigrated
    // image, a permissions gap on a tenant that will never create an env — must
    // not fail a cron that is metering real sessions perfectly well. It is
    // logged, counted in `failedSources`, and captured at WARNING level so the
    // fault is discoverable without being an incident. When envs become
    // user-visible this distinction goes away and the env source joins the loud
    // set; the `LOUD_SOURCES` list below is the one line that changes.
    //
    // What IS loud: the SESSION source failing (real money, live feature), and a
    // tick where every row of more than one failed to bill. That `> 1` is the
    // smallest claim the data supports rather than a tuning knob — one row
    // failing is indistinguishable from one unlucky transient the meter already
    // isolates and retries, while two or more failing together makes a shared
    // cause the likely reading. On a one-row deployment the per-row counters,
    // not this alert, are the signal.
    //
    // `chargedButUnadvanced` is deliberately not a condition either: the
    // documented crash-window residual, bounded to one re-billed window, and
    // already counted, logged and audited.
    const LOUD_SOURCES: StorageSubjectKind[] = ['session'];
    const loudSources = run.failedSources.filter((source) => LOUD_SOURCES.includes(source));
    const quietSources = run.failedSources.filter((source) => !LOUD_SOURCES.includes(source));

    if (quietSources.length > 0) {
      // Discoverable, not an incident. No `flush` and no non-2xx: this is a dark
      // feature's read failing, and the tick's real work succeeded.
      Sentry.captureMessage(`Storage reconcile could not read dark row source(s): ${quietSources.join(', ')}`, {
        level: 'warning',
        fingerprint: ['storage-reconcile-dark-source-unreadable', ...quietSources],
        tags: { check: 'storage_reconcile', reason: 'dark_source_unreadable' },
      });
    }

    // The SECOND loud condition: a live unit that had charges to make and made
    // none of them.
    //
    // Asked PER LIVE KIND and against `billingByKind`, and both halves are
    // scars. Comparing against `processed` failed because a row pricing to $0
    // lands in none of charged/skipped/failed — envs meter ~$0 by construction,
    // so ONE unmeasured env silenced twenty unbilled sessions. Comparing
    // cross-kind totals failed because an env charging satisfies `charged > 0`
    // while every session fails. Asking each live kind about its own billable
    // rows leaves nothing to dilute.
    //
    // `> 1` because one row failing is indistinguishable from one unlucky
    // transient the meter already isolates and retries; on a one-row deployment
    // the per-row counters, not this alert, are the signal. Envs are excluded
    // for the same reason they are excluded from `LOUD_SOURCES`.
    const wipedOut = LOUD_SOURCES.filter(
      (kind) => run.billingByKind[kind].billable > 1 && run.billingByKind[kind].charged === 0,
    );
    // Named from the WIPED-OUT kinds' own counters, not the tick-wide totals.
    // Otherwise the fingerprint contradicts the condition that produced it: three
    // sessions failing on the charge path beside forty envs skipped for an
    // unresolvable payer would fire correctly on the session wipeout and then
    // label it `all_rows_skipped`, filing a charge-path fault in the
    // payer-lookup bucket — in the one block whose whole purpose is precision.
    const wipedOutSkipped = wipedOut.reduce((total, kind) => total + run.billingByKind[kind].skipped, 0);
    const wipedOutFailed = wipedOut.reduce((total, kind) => total + run.billingByKind[kind].failed, 0);
    const wipeoutCause = wipedOutSkipped >= wipedOutFailed ? 'all_rows_skipped' : 'all_rows_failed';

    const alertReason =
      loudSources.length > 0
        ? `could not read row source(s): ${loudSources.join(', ')}`
        : wipedOut.length > 0
          ? `${wipedOut.join(', ')} billed nothing though ` +
            `${wipedOut.map((kind) => run.billingByKind[kind].billable).join('/')} rows had charges to make ` +
            `(${wipedOutSkipped} skipped, ${wipedOutFailed} failed)`
          : null;

    if (alertReason) {
      // Fingerprinted on the CAUSE, never the message: the message carries
      // changing counts and would open a fresh issue per tick, burying a fault
      // that recurs hourly in noise.
      Sentry.captureException(new Error(`Storage reconcile ${alertReason}`), {
        level: 'error',
        fingerprint:
          loudSources.length > 0
            ? ['storage-reconcile-source-unreadable', ...loudSources]
            : [`storage-reconcile-${wipeoutCause.replace(/_/g, '-')}`],
        tags: {
          check: 'storage_reconcile',
          reason: loudSources.length > 0 ? 'source_unreadable' : wipeoutCause,
          failedSources: run.failedSources.join(','),
        },
        extra: {
          processed: run.processed,
          charged: run.charged,
          failed: run.failed,
          skipped: run.skipped,
          billableRows: run.billableRows,
          billingByKind: run.billingByKind,
          totalCostDollars: run.totalCostDollars,
        },
      });
      // Deliberately NOT awaiting `Sentry.flush` here. This runs in a long-lived
      // container, not a per-request serverless invocation, so the transport
      // drains on its own — and awaiting it would add up to its timeout to every
      // failing tick's response for no delivery guarantee this endpoint can act
      // on. The logger below is the independent channel that survives a Sentry
      // outage.
      loggers.system.error(`[Cron] Storage reconcile FAILED: ${alertReason}`);

      return NextResponse.json(
        {
          success: false,
          error: `storage reconcile ${alertReason}`,
          processed: run.processed,
          charged: run.charged,
          skipped: run.skipped,
          failed: run.failed,
          chargedButUnadvanced: run.chargedButUnadvanced,
          staleMeasurements: run.staleMeasurements,
          neverMeasured: run.neverMeasured,
          watermarkSuperseded: run.watermarkSuperseded,
          spanClamped: run.spanClamped,
          billableRows: run.billableRows,
          billingByKind: run.billingByKind,
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
      spanClamped: run.spanClamped,
      billableRows: run.billableRows,
      billingByKind: run.billingByKind,
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
