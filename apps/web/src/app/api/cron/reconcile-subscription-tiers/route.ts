import { reconcileSubscriptionTiers } from '@pagespace/lib/billing/subscription-tier-reconcile';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { getTierFromPrice } from '@/lib/stripe';

/**
 * Cron endpoint that reconciles the denormalized `users.subscriptionTier`
 * cache against the `subscriptions` table (#2149). The cache is written only
 * by the Stripe webhook, so a missed/failed webhook leaves it stale
 * indefinitely — this sweep is the periodic backstop, modeled on
 * reconcile-credits' relationship to computeBalanceDrift. Repairable drift is
 * corrected in place; indeterminate drift (an entitled subscription on a
 * price id the tier map doesn't recognize) is logged/audited for a human,
 * never auto-repaired downward.
 *
 * Replaces the one-shot repair scripts this drift class used to require
 * (scripts/sync-legacy-subscriptions.ts).
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
    const result = await reconcileSubscriptionTiers({
      priceTier: (priceId) => getTierFromPrice(priceId),
    });

    console.log(
      `[Cron] Subscription tier reconcile: scanned ${result.scanned}, drifted ${result.drifted}, repaired ${result.repaired}, flaggedOnly ${result.flaggedOnly}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_subscription_tiers',
      details: {
        scanned: result.scanned,
        drifted: result.drifted,
        repaired: result.repaired,
        flaggedOnly: result.flaggedOnly,
      },
    });

    return NextResponse.json({
      success: true,
      scanned: result.scanned,
      drifted: result.drifted,
      repaired: result.repaired,
      flaggedOnly: result.flaggedOnly,
      details: result.details,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling subscription tiers', error as Error);
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
