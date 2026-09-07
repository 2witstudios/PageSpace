import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { reconcileStoppedDevPreviewsForCron } from '@/lib/dev-preview/preview-runtime';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that converges dev-server previews a user switched OFF whose
 * relay is somehow still up.
 *
 * A Stop is durable the moment it is written — the action records the intent
 * even when the holder's lock is contended or the lock pool is degraded, and
 * defers the relay work to whoever next re-plans. Normally that is the
 * realtime detector's next `ports/watch` frame. But a holder nobody is
 * watching produces no frames, and a stop is exactly when a dev server tends
 * to go quiet, so without this the row would say "switched off" while the
 * relay kept serving until the sprite died.
 *
 * The sweep can only ever STOP a relay, structurally: it plans with no
 * listener snapshot, which the core turns into `stop-relay` or nothing and
 * which makes any plan that would START a relay a refusal. It never wakes a
 * sprite (an attach is a control-plane read). Dark deployments do no work.
 *
 * No cron-level lock, and a per-holder try-lock with no retries: busy means a
 * live path already owns that holder. Every write underneath is a
 * compare-and-set, so overlapping runs converge — the
 * `reconcile-orphaned-sprites` posture.
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
    const run = await reconcileStoppedDevPreviewsForCron();

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_dev_previews',
      details: { processed: run.processed, stopped: run.stopped, skipped: run.skipped, failed: run.failed },
    });

    return NextResponse.json({ success: true, ...run, timestamp: new Date().toISOString() });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling stopped dev previews', error as Error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
