import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getOrCreateAccountToken } from '@pagespace/lib/billing/apple/apple-account';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/iap/apple/account-token
 *
 * The caller's App Store account token — the UUID the device passes to StoreKit as
 * `appAccountToken` on every purchase, so the signed transaction (and every server
 * notification about it) names the PageSpace account that bought it. Created on first
 * call, stable after.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    if (!isBillingEnabled()) {
      return NextResponse.json({ error: 'Purchases are not available on this deployment' }, { status: 404 });
    }

    const accountToken = await getOrCreateAccountToken(auth.userId);
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'app_store_account', resourceId: 'self' });
    return NextResponse.json({ accountToken });
  } catch (error) {
    loggers.api.error('App Store account token failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to prepare the purchase' }, { status: 500 });
  }
}
