import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { db } from '@pagespace/db/db'
import { eq, and, inArray, desc } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { getStorageConfigFromSubscription } from '@pagespace/lib/services/subscription-utils';
import { TIERS, toSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { tierAllowanceCents } from '@pagespace/lib/billing/money-model';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/**
 * MON-2: the included-credit figure per tier, computed HERE from `tierAllowanceCents`
 * (D-OW-17: `MONEY_MODEL_V2_ACTIVE` is now a code constant, identical in every
 * process — web, marketing, and any "use client" bundle — so this route and
 * `settings/plan`'s own client-side derivation would in fact agree either way).
 * `settings/plan` still fetches this route and patches its plan data with
 * `planCredits` via `withCreditOverrides` (`@/lib/subscription/plans`); that seam is
 * unchanged and still correct, just no longer load-bearing for the env/client
 * asymmetry it was originally built to close.
 */
function planCreditsByTier(): Record<SubscriptionTier, number> {
  return Object.fromEntries(TIERS.map((tier) => [tier, tierAllowanceCents(tier)])) as Record<SubscriptionTier, number>;
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) {
      return authResult;
    }

    const { userId } = authResult;

    // Get user data
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Get current active subscription (filter by status to avoid returning stale records)
    let subscription = null;
    if (user.stripeCustomerId) {
      const subscriptionRecord = await db.select()
        .from(subscriptions)
        .where(and(
          eq(subscriptions.userId, user.id),
          inArray(subscriptions.status, ['active', 'trialing', 'past_due'])
        ))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(1);

      if (subscriptionRecord.length > 0) {
        subscription = subscriptionRecord[0];
      }
    }

    // Compute storage config from subscription tier
    // Coerce the untyped column through the canonical vocabulary (schema contract).
    const subscriptionTier = toSubscriptionTier(user.subscriptionTier);
    const storageConfig = getStorageConfigFromSubscription(subscriptionTier);

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'subscription_status', resourceId: 'self', details: { tier: subscriptionTier } });

    return NextResponse.json({
      subscriptionTier,
      // A-9: a legacy $100 personal Business subscriber kept at their price.
      subscriptionGrandfathered: user.subscriptionGrandfathered === true,
      stripeCustomerId: user.stripeCustomerId,
      subscription: subscription ? {
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        scheduledPriceId: subscription.scheduledPriceId,
        scheduledChangeDate: subscription.scheduledChangeDate,
      } : null,
      storage: {
        used: user.storageUsedBytes || 0,
        quota: storageConfig.quotaBytes,
        tier: storageConfig.tier,
      },
      // MON-2: server-authoritative included-credit figure per tier; see
      // planCreditsByTier's doc comment above.
      planCredits: planCreditsByTier(),
    });

  } catch (error) {
    console.error('Error fetching subscription status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch subscription status' },
      { status: 500 }
    );
  }
}