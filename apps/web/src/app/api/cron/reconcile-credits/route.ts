import { backfillCredits } from '@pagespace/lib/billing/credit-backfill';
import { reconcileMissedGrants } from '@pagespace/lib/billing/missed-grant-reconcile';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that reconciles prepaid AI-credit consumption and outstanding grants.
 *
 * Re-settles ledger rows stuck 'pending' and consumes any usage rows that never
 * decremented the balance, so every billable AI call is charged exactly once
 * even across crashes/deploys. Also sweeps 'missed_grant' rows (Spec MON-2,
 * WAL-5): a paid invoice whose tier had no ratio at funding time fails closed and
 * leaves one of these; here we re-resolve the tier from the LIVE subscription and
 * grant amount_paid × ratio once it has one. Local-only — makes no Stripe calls.
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
    const result = await backfillCredits();
    const missedGrants = await reconcileMissedGrants();

    console.log(
      `[Cron] Credit reconcile: retried ${result.retried}, orphans ${result.orphans}, expiredHolds ${result.expiredHolds}, missedGrantsReconciled ${missedGrants.reconciled}, missedGrantsStillMissing ${missedGrants.stillMissing}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_credits',
      details: {
        retried: result.retried,
        orphans: result.orphans,
        expiredHolds: result.expiredHolds,
        missedGrantsReconciled: missedGrants.reconciled,
        missedGrantsStillMissing: missedGrants.stillMissing,
      },
    });

    return NextResponse.json({
      success: true,
      ...result,
      missedGrantsReconciled: missedGrants.reconciled,
      missedGrantsStillMissing: missedGrants.stillMissing,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling credits', error as Error);
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
