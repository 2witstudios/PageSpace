import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { drainAppHostingStripeReclaims } from '@/lib/app-hosting/stripe-reclaim';

/**
 * Cron endpoint that drains `app_hosting_stripe_reclaims` — dedicated published
 * apps' Stripe subscriptions rescued from an unpublish before their local mirror
 * row was cascaded away. See `stripe-reclaim.ts` for why the cancel is immediate
 * and unlocked.
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
    const run = await drainAppHostingStripeReclaims();

    console.log(
      `[Cron] App-hosting Stripe reclaim: processed ${run.processed}, canceled ${run.canceled}, alreadyCanceled ${run.alreadyCanceled}, failed ${run.failed}${run.capped ? ' (CAPPED — backlog remains, draining next tick)' : ''}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reclaim_app_hosting_stripe',
      details: run,
    });

    return NextResponse.json({ success: true, ...run, timestamp: new Date().toISOString() });
  } catch (error) {
    loggers.system.error('[Cron] Error draining app-hosting Stripe reclaims', error as Error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
