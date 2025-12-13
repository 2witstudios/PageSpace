import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { db, eq, and, inArray, desc, subscriptions, users } from '@pagespace/db';
import { getStorageConfigFromSubscription, type SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

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
    const subscriptionTier = (user.subscriptionTier || 'free') as SubscriptionTier;
    const storageConfig = getStorageConfigFromSubscription(subscriptionTier);

    return NextResponse.json({
      subscriptionTier: user.subscriptionTier,
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
    });

  } catch (error) {
    console.error('Error fetching subscription status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch subscription status' },
      { status: 500 }
    );
  }
}