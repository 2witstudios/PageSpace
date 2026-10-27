import { NextResponse } from 'next/server';
import { reconcileAllPublishedVisibility } from '@pagespace/lib/organizations/published-visibility';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { createPublishedObjectStore, isPublishConfigured } from '@/lib/canvas/published-storage';

/**
 * Cron endpoint: make the public publish bucket match every org's LIVE publishing policies (Spec POL-4).
 *
 * A paused site is moved to `suspended/<prefix>/` and a restored one moved back (see
 * organizations/published-visibility-core.ts). The move runs right after a policy change, but the object store can
 * fail part way or be down; this sweep, every 10 minutes, finishes whatever is left: it re-parks anything that
 * reappeared in a hidden site's public prefix and restores any parked site whose policy says visible again. It
 * reads the policy, never a marker, so it is idempotent: a tick with nothing to do lists and changes nothing.
 *
 * A prefix that fails to move makes the run a 500 so it pages; the next tick retries it.
 * Where publishing is not configured (no bucket) it does nothing.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;
  if (!isPublishConfigured()) return NextResponse.json({ success: true, skipped: 'publishing_not_configured' });

  try {
    const outcomes = await reconcileAllPublishedVisibility(createPublishedObjectStore());
    const count = (action: string) => outcomes.filter((o) => o.action === action).length;
    const summary = { prefixes: outcomes.length, parked: count('parked'), restored: count('restored'), unchanged: count('unchanged'), failed: count('failed') };
    audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'reconcile_published_visibility', details: { ...summary } });
    if (summary.failed > 0) {
      loggers.system.error('[Cron] Published visibility: prefixes failed', undefined, { ...summary, failedPrefixes: outcomes.filter((o) => o.action === 'failed').map((o) => o.prefix) });
      return NextResponse.json({ success: false, error: `${summary.failed} prefix(es) failed`, ...summary }, { status: 500 });
    }
    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    loggers.system.error('[Cron] Published visibility reconcile failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
