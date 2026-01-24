import { NextRequest, NextResponse } from 'next/server';
import { db, eq, and, inArray, desc, users, subscriptions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/stripe/reactivate-subscription
 * Reactivate a subscription that was scheduled for cancellation.
 * Removes the cancel_at_period_end flag.
 */
export async function POST(request: NextRequest) {

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get current active subscription (filter by status to avoid returning stale records)
    const [currentSubscription] = await db.select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ['active', 'trialing', 'past_due'])
      ))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);

    if (!currentSubscription?.stripeSubscriptionId) {
      return NextResponse.json(
        { error: 'No subscription found' },
        { status: 400 }
      );
    }

    // Check if subscription is actually scheduled for cancellation
    const stripeSubscription = await stripe.subscriptions.retrieve(
      currentSubscription.stripeSubscriptionId
    );

    if (!stripeSubscription.cancel_at_period_end) {
      return NextResponse.json(
        { error: 'Subscription is not scheduled for cancellation' },
        { status: 400 }
      );
    }

    // If managed by a schedule, release it first
    if (stripeSubscription.schedule) {
      const scheduleId = typeof stripeSubscription.schedule === 'string'
        ? stripeSubscription.schedule
        : stripeSubscription.schedule.id;
      await stripe.subscriptionSchedules.release(scheduleId);
    }

    // Reactivate subscription
    const subscription = await stripe.subscriptions.update(
      currentSubscription.stripeSubscriptionId,
      { cancel_at_period_end: false }
    );

    // Update local record - also clear any schedule info
    await db.update(subscriptions)
      .set({
        cancelAtPeriodEnd: false,
        stripeScheduleId: null,
        scheduledPriceId: null,
        scheduledChangeDate: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, currentSubscription.id));

    return NextResponse.json({
      subscriptionId: subscription.id,
      cancelAtPeriodEnd: false,
      status: subscription.status,
      message: 'Subscription reactivated successfully',
    });

  } catch (error) {
    loggers.api.error('Error reactivating subscription', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to reactivate subscription' },
      { status: 500 }
    );
  }
}
