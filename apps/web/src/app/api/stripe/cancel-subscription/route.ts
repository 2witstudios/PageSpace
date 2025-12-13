import { NextRequest, NextResponse } from 'next/server';
import { db, eq, and, inArray, desc, users, subscriptions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * POST /api/stripe/cancel-subscription
 * Schedule subscription cancellation at period end.
 * User keeps access until the end of their billing period.
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
        { error: 'No active subscription found' },
        { status: 400 }
      );
    }

    // First retrieve subscription to check for schedule
    const stripeSubscription = await stripe.subscriptions.retrieve(
      currentSubscription.stripeSubscriptionId
    );

    // If managed by a schedule, release it first (user chose to cancel, discarding pending downgrade)
    if (stripeSubscription.schedule) {
      const scheduleId = typeof stripeSubscription.schedule === 'string'
        ? stripeSubscription.schedule
        : stripeSubscription.schedule.id;
      await stripe.subscriptionSchedules.release(scheduleId);
    }

    // Cancel at period end - expand items to get current_period_end
    const subscription = await stripe.subscriptions.update(
      currentSubscription.stripeSubscriptionId,
      { cancel_at_period_end: true, expand: ['items'] }
    );

    // Get current_period_end from subscription item (properly typed in Stripe SDK v18)
    const firstItem = subscription.items?.data?.[0];
    if (!firstItem) {
      return NextResponse.json(
        { error: 'Subscription has no items' },
        { status: 400 }
      );
    }
    const currentPeriodEnd = firstItem.current_period_end;

    // Update local record - also clear any schedule info
    await db.update(subscriptions)
      .set({
        cancelAtPeriodEnd: true,
        stripeScheduleId: null,
        scheduledPriceId: null,
        scheduledChangeDate: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, currentSubscription.id));

    return NextResponse.json({
      subscriptionId: subscription.id,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(currentPeriodEnd * 1000).toISOString(),
      message: 'Subscription will be cancelled at the end of the billing period',
    });

  } catch (error) {
    loggers.api.error('Error cancelling subscription', error instanceof Error ? error : undefined, { error });

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to cancel subscription' },
      { status: 500 }
    );
  }
}
