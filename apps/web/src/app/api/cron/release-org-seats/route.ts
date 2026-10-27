import { releaseDueSeats } from '@pagespace/lib/organizations/seat-service';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { defaultSeatBilling } from '@/lib/org-billing/seat-billing';

/**
 * Cron endpoint for the org seat period-end release (Spec SEAT-5).
 *
 * Removing a member frees their seat at PERIOD END, never mid-period: the quantity on the org's
 * extra-seat Stripe item is left alone when someone leaves, so a re-add inside the period reuses
 * the paid seat with no charge. This sweep, every 15 minutes, finds org subscriptions whose
 * period ends within the next hour and sets the quantity to the seats actually held — lowered
 * without proration, or restored (prorated) when Stripe bills fewer seats than are held — so the
 * renewal invoice bills the right count.
 *
 * Idempotent: an org already at its held count is left alone, and a write that is replayed
 * carries the same idempotency key. An org that fails makes the run a 500 so it pages; the next
 * tick retries it. Where billing is off (onprem, tenant) it does nothing.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;
  if (!isBillingEnabled()) return NextResponse.json({ success: true, skipped: 'billing_disabled' });

  try {
    const result = await releaseDueSeats({ now: new Date() }, defaultSeatBilling());
    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'release_org_seats',
      details: { ...result },
    });
    if (result.failed > 0) {
      loggers.system.error('[Cron] Org seat release: orgs failed', undefined, { ...result });
      return NextResponse.json({ success: false, error: `${result.failed} org(s) failed`, ...result }, { status: 500 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    loggers.system.error('[Cron] Org seat release failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
