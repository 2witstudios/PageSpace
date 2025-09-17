import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth-helpers';
import { db, eq, subscriptions, users } from '@pagespace/db';

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

    // Get current subscription info
    let subscription = null;
    if (user.stripeCustomerId) {
      const subscriptionRecord = await db.select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id))
        .limit(1);

      if (subscriptionRecord.length > 0) {
        subscription = subscriptionRecord[0];
      }
    }

    return NextResponse.json({
      subscriptionTier: user.subscriptionTier,
      stripeCustomerId: user.stripeCustomerId,
      subscription: subscription ? {
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      } : null,
      storage: {
        used: user.storageUsedBytes,
        quota: user.storageQuotaBytes,
        tier: user.storageTier,
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