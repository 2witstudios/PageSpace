import { backfillCredits } from '@pagespace/lib/billing/credit-backfill';
import { reconcileMissedGrants } from '@pagespace/lib/billing/missed-grant-reconcile';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { getTierFromPrice } from '@/lib/stripe/price-config';

/**
 * Cron endpoint that reconciles prepaid AI-credit consumption and outstanding grants.
 *
 * Re-settles ledger rows stuck 'pending' and consumes any usage rows that never
 * decremented the balance, so every billable AI call is charged exactly once
 * even across crashes/deploys. Also sweeps 'missed_grant' rows (Spec MON-2,
 * WAL-5): a paid invoice whose tier had no ratio at funding time fails closed and
 * leaves one of these; here we re-resolve the tier from the user's subscriptions rows
 * (via the Stripe price map) and grant amount_paid × ratio once it has one. Any row
 * that FAILS to reconcile makes the run a 500 and is not audited as a success, so a
 * broken sweep pages someone instead of hiding behind a 200. Local-only — makes no
 * Stripe calls.
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
    const missedGrants = await reconcileMissedGrants({
      priceTier: (priceId, amountCents) => getTierFromPrice(priceId, amountCents),
    });
    const counts = {
      ...result,
      missedGrantsReconciled: missedGrants.reconciled,
      missedGrantsStillMissing: missedGrants.stillMissing,
      missedGrantsIndeterminate: missedGrants.indeterminate,
      missedGrantsFailed: missedGrants.failed,
    };

    if (missedGrants.failed > 0) {
      loggers.system.error('[Cron] Credit reconcile: missed-grant rows failed to reconcile', undefined, counts);
      return NextResponse.json(
        { success: false, error: `${missedGrants.failed} missed-grant row(s) failed to reconcile`, ...counts },
        { status: 500 },
      );
    }

    console.log(
      `[Cron] Credit reconcile: retried ${result.retried}, orphans ${result.orphans}, expiredHolds ${result.expiredHolds}, missedGrantsReconciled ${missedGrants.reconciled}, missedGrantsStillMissing ${missedGrants.stillMissing}, missedGrantsIndeterminate ${missedGrants.indeterminate}, missedGrantsFailed ${missedGrants.failed}`,
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
        missedGrantsIndeterminate: missedGrants.indeterminate,
        missedGrantsFailed: missedGrants.failed,
      },
    });

    return NextResponse.json({
      success: true,
      ...counts,
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
