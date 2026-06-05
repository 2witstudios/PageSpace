import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getCreditBalance } from '@/lib/subscription/credit-balance';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isCreditsModeEnabled } from '@pagespace/lib/billing/credit-pricing';

const isSubscriptionTier = (value: string): value is SubscriptionTier =>
  value === 'free' || value === 'pro' || value === 'founder' || value === 'business';

/**
 * GET /api/credits — the authenticated user's prepaid AI-credit balance.
 *
 * Returns the monthly allowance bucket (rolls over each period), the never-expiring
 * top-up bucket, the spendable total (net of in-flight reservations), and the
 * reserved amount. Drives the credit-balance widget and the buy-credits surfaces.
 *
 * Also carries `creditsMode` (the per-environment switch, read at request time) so the
 * client can render the new credits UI vs the legacy daily-quota UI from the same image
 * — NEXT_PUBLIC_* can't differ per-env, so the mode must come from the server at runtime.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (isAuthError(auth)) return auth;

    const { userId } = auth;

    const rows = await db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const rawTier = rows[0]?.subscriptionTier;
    const tier: SubscriptionTier = rawTier && isSubscriptionTier(rawTier) ? rawTier : 'free';

    const balance = await getCreditBalance(userId, tier);

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'credit_balance',
      resourceId: 'self',
    });

    return NextResponse.json({ ...balance, creditsMode: isCreditsModeEnabled() });
  } catch (error) {
    console.error('Error fetching credit balance:', error);
    return NextResponse.json({ error: 'Failed to fetch credit balance' }, { status: 500 });
  }
}
