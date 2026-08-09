import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getCreditBalance } from '@/lib/subscription/credit-balance';
import { toSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/**
 * GET /api/credits — the authenticated user's prepaid credit balance.
 *
 * Returns the monthly allowance bucket (rolls over each period), the never-expiring
 * top-up bucket, the spendable total (net of in-flight reservations), and the
 * reserved amount. Drives the credit-balance widget and the buy-credits surfaces.
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
    const tier: SubscriptionTier = toSubscriptionTier(rawTier);

    const balance = await getCreditBalance(userId, tier);

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'credit_balance',
      resourceId: 'self',
    });

    return NextResponse.json({ ...balance, subscriptionTier: tier });
  } catch (error) {
    console.error('Error fetching credit balance:', error);
    return NextResponse.json({ error: 'Failed to fetch credit balance' }, { status: 500 });
  }
}
