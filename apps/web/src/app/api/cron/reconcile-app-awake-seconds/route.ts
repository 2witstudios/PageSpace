import {
  defaultAwakeReconcileDeps,
  reconcileAwakeSecondsSerialized,
} from '@pagespace/lib/services/app-hosting/awake-reconcile';
import * as Sentry from '@sentry/nextjs';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * WEEKLY cron that checks what we billed for published-app awake time against
 * Fly's managed Prometheus — the only independent record that a machine was up.
 *
 * Fly has no billing API, and its own machine event log holds only the last 20
 * entries with no pagination, so awake-seconds history is NOT rebuildable after
 * the fact: our own start/stop calls are the primary record and the local event
 * mirror is where they are kept. Managed Prometheus retains roughly 15 days, which
 * is what fixes this cadence — weekly leaves a full window of slack for one missed
 * run, where monthly would routinely ask about samples that no longer exist.
 *
 * IT COMPARES AND ALERTS; IT MOVES NO MONEY. A scraped gauge is not evidence of a
 * charge, and auto-adjusting a customer's ledger from one would let a metrics
 * artifact issue refunds and back-charges nobody reviewed. What it produces is a
 * named, DIRECTIONAL signal — `over_billed` (a customer paid for time Fly did not
 * see: the serious direction) versus `under_billed` (a boundary we never recorded:
 * our own loss) — while the window is still open for a human to act on.
 *
 * SHIPS DARK, TWICE OVER. `APP_HOSTING_ENABLED` off reports `disabled`; no
 * Prometheus org slug or token reports `unconfigured`. Both are green 200s: a dark
 * or unconfigured feature must never redden a cron.
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
    const run = await reconcileAwakeSecondsSerialized(defaultAwakeReconcileDeps);

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Published-app awake reconcile: skipped — advisory lock held by another run');
      return NextResponse.json({ success: true, outcome: 'lock_busy', timestamp: new Date().toISOString() });
    }
    if (run.outcome === 'disabled' || run.outcome === 'unconfigured') {
      console.log(`[Cron] Published-app awake reconcile: ${run.outcome}`);
      return NextResponse.json({ success: true, outcome: run.outcome, timestamp: new Date().toISOString() });
    }

    console.log(
      `[Cron] Published-app awake reconcile: processed ${run.processed}, compared ${run.compared}, noSeries ${run.noSeries}, failed ${run.failed}, drifted ${run.drifted} (window ${run.windowDays}d)`,
    );

    audit({
      eventType: 'data.read',
      resourceType: 'cron_job',
      resourceId: 'reconcile_app_awake_seconds',
      details: {
        processed: run.processed,
        compared: run.compared,
        // No `fly_instance_up` series at all — never woken, or aged out of
        // retention. Ordinary, and not a fault.
        noSeries: run.noSeries,
        failed: run.failed,
        drifted: run.drifted,
        windowDays: run.windowDays,
        // Worst first, over-billed ahead of under-billed. Capped for reporting;
        // `drifted` is the true count.
        reports: run.reports,
      },
    });

    if (run.drifted > 0) {
      // A WARNING, not an error, and deliberately so: drift is a finding for a
      // human to read, not an incident to page on. The two directions are split
      // into separate fingerprints because they are different problems with
      // different owners — one is a possible refund, the other is our own
      // unrecorded boundary.
      const overBilled = run.reports.filter((report) => report.drift.direction === 'over_billed').length;
      Sentry.captureMessage(
        `Published-app awake reconcile found ${run.drifted} app(s) whose billed awake time disagrees with fly_instance_up`,
        {
          level: overBilled > 0 ? 'error' : 'warning',
          fingerprint: [overBilled > 0 ? 'awake-reconcile-over-billed' : 'awake-reconcile-under-billed'],
          tags: {
            check: 'published_app_awake_reconcile',
            reason: overBilled > 0 ? 'over_billed' : 'under_billed',
          },
          extra: { drifted: run.drifted, overBilled, compared: run.compared, reports: run.reports },
        },
      );
    }

    // Returned green even with drift: the run itself succeeded, and it did exactly
    // what it exists to do. Failing the endpoint would make a finding look like an
    // outage of the finder.
    return NextResponse.json({ success: true, ...run, timestamp: new Date().toISOString() });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling published-app awake seconds', error as Error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
