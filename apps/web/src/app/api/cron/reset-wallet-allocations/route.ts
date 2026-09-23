import { resetDueAllocations } from '@pagespace/lib/billing/wallet-funding-shell';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint for the wallet allocation period reset (Spec WAL-3, D-OW-12).
 *
 * Resets every CHILD wallet (a drive or agent-page wallet) whose governing period has
 * started since its own: an org drive's allocation on the org pool's refill date, a
 * personal drive's on its owner's personal renewal. Spend returns to zero, wallet debt
 * is netted against the new allocation and cleared, top-ups and donations are left
 * alone. Root wallets are not touched: invoice.paid refills them, and the gate's lazy
 * roll for comped personal accounts (credit-gate.ts) still owns that case.
 *
 * Idempotent: a wallet already carrying its governing period start is never reset
 * again in that period, so an overlapping or repeated tick resets once. Any wallet
 * that fails makes the run a 500 so it pages instead of hiding behind a 200.
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
    const result = await resetDueAllocations({ now: new Date() });

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reset_wallet_allocations',
      details: { ...result },
    });

    if (result.failed > 0) {
      loggers.system.error('[Cron] Wallet allocation reset: wallets failed to reset', undefined, { ...result });
      return NextResponse.json(
        { success: false, error: `${result.failed} wallet(s) failed to reset`, ...result },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    loggers.system.error('[Cron] Wallet allocation reset failed', error instanceof Error ? error : undefined);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
