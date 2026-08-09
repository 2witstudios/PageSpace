import { reconcileOpenRouterCosts } from '@pagespace/lib/billing/cost-reconcile';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that reconciles AI-call billing against OpenRouter's authoritative cost.
 *
 * For each OpenRouter usage row still 'pending' reconcile, fetches the final
 * `/api/v1/generation` cost and writes a correcting credit-ledger adjustment + balance
 * delta when the drift clears tolerance. Idempotent and bounded; makes external HTTP
 * calls to OpenRouter (hence its own cron, separate from the local-only credit reconcile).
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
    const result = await reconcileOpenRouterCosts();

    console.log(
      `[Cron] AI cost reconcile: fetched ${result.fetched}, corrected ${result.corrected}, unavailable ${result.unavailable}, skipped ${result.skipped}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_ai_cost',
      details: {
        fetched: result.fetched,
        corrected: result.corrected,
        unavailable: result.unavailable,
        skipped: result.skipped,
      },
    });

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling AI cost', error as Error);
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
