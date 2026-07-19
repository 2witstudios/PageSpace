import { backfillCredits } from '@pagespace/lib/billing/credit-backfill';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that reconciles prepaid AI-credit consumption.
 *
 * Re-settles ledger rows stuck 'pending' and consumes any usage rows that never
 * decremented the balance, so every billable AI call is charged exactly once
 * even across crashes/deploys. Local-only — makes no Stripe calls.
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

    console.log(
      `[Cron] Credit reconcile: retried ${result.retried}, orphans ${result.orphans}, expiredHolds ${result.expiredHolds}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_credits',
      details: { retried: result.retried, orphans: result.orphans, expiredHolds: result.expiredHolds },
    });

    return NextResponse.json({
      success: true,
      ...result,
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
