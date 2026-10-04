import { resetDuePeriods } from '@pagespace/lib/billing/wallet-funding-shell';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint for the hourly period sweep (Spec WAL-3, D-OW-12) — the ONLY reset that is
 * not an invoice.
 *
 * First it rolls the personal root of every comped paid account (no renewal-capable
 * subscription, so invoice.paid will never renew it) whose period has ended: once, onto
 * the period starting at its stored UTC renewal date. The credit gate no longer rolls
 * anything (ew9v06jeb). Then it resets every CHILD wallet (a drive or agent-page wallet)
 * whose governing period has started since its own: an org drive's allocation on the org
 * pool's refill date, a personal drive's on its owner's personal renewal — so a child
 * under a root rolled this run resets in the same run. Spend returns to zero, wallet debt
 * is netted against the new allocation and cleared, top-ups and donations are left alone.
 * Org pools and subscribed roots are refilled by invoice.paid only.
 *
 * Idempotent: a root roll is keyed by its new period's start, and a wallet already
 * carrying its governing period start is never reset again in that period, so an
 * overlapping or repeated tick resets once. Any wallet that fails makes the run a 500 so
 * it pages instead of hiding behind a 200.
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
    const { roots, allocations } = await resetDuePeriods({ now: new Date() });
    const counts = { ...allocations, roots };

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reset_wallet_allocations',
      details: counts,
    });

    const failed = allocations.failed + roots.failed;
    if (failed > 0) {
      loggers.system.error('[Cron] Wallet period sweep: wallets failed to reset', undefined, counts);
      return NextResponse.json(
        { success: false, error: `${failed} wallet(s) failed to reset`, ...counts },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, ...counts });
  } catch (error) {
    loggers.system.error('[Cron] Wallet allocation reset failed', error instanceof Error ? error : undefined);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
