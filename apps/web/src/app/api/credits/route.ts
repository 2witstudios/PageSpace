import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getOwnCreditsBalance } from '@pagespace/lib/billing/own-credits-balance';
import { toPersonalSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/**
 * GET /api/credits — the authenticated user's prepaid credit balance.
 *
 * Returns the allowance bucket (paid tiers: re-granted and rolled over each period;
 * free: a one-time starter grant, `periodEnd` null), the never-expiring
 * top-up bucket, the spendable total (GROSS of in-flight holds — `reserved` is
 * reported separately, never netted out), and that reserved amount. Drives the credit-balance widget and the buy-credits surfaces.
 *
 * A claimed AI agent's own credits are its owner's (ADR 0008 Decision 8): it is shown the
 * owner's balance at the owner's tier — the wallet its AI calls spend — with `billedTo` naming
 * the owner. Everyone else gets their own balance and `billedTo: null`.
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
    const tier: SubscriptionTier = toPersonalSubscriptionTier(rawTier);

    const balance = await getOwnCreditsBalance(userId, tier);

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'credit_balance',
      resourceId: 'self',
    });

    return NextResponse.json(balance);
  } catch (error) {
    console.error('Error fetching credit balance:', error);
    return NextResponse.json({ error: 'Failed to fetch credit balance' }, { status: 500 });
  }
}
