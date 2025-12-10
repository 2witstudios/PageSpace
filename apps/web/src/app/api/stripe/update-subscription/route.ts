import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, eq, users, subscriptions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * POST /api/stripe/update-subscription
 * Change subscription plan (upgrade or downgrade).
 * - Upgrades: Applied immediately with proration
 * - Downgrades: Scheduled at period end (no proration)
 */
export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { priceId, isDowngrade = false } = body;

    if (!priceId) {
      return NextResponse.json(
        { error: 'Price ID is required' },
        { status: 400 }
      );
    }

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.stripeCustomerId) {
      return NextResponse.json(
        { error: 'No Stripe customer found' },
        { status: 400 }
      );
    }

    // Get current subscription
    const [currentSubscription] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));

    if (!currentSubscription?.stripeSubscriptionId) {
      return NextResponse.json(
        { error: 'No active subscription found' },
        { status: 400 }
      );
    }

    // Fetch subscription from Stripe - expand items to get current_period_end
    const subscription = await stripe.subscriptions.retrieve(
      currentSubscription.stripeSubscriptionId,
      { expand: ['items'] }
    );

    if (!['active', 'trialing'].includes(subscription.status)) {
      return NextResponse.json(
        { error: 'Subscription is not active' },
        { status: 400 }
      );
    }

    const currentItemId = subscription.items.data[0]?.id;
    if (!currentItemId) {
      return NextResponse.json(
        { error: 'No subscription items found' },
        { status: 400 }
      );
    }

    // Update subscription
    if (isDowngrade) {
      // Use subscription schedule to properly defer downgrade to period end.
      // This ensures the user keeps their current plan features until the
      // billing cycle ends, then automatically switches to the new plan.
      const subscriptionItem = subscription.items.data[0];
      const currentPriceId = subscriptionItem.price.id;
      const currentPeriodEnd = subscriptionItem.current_period_end;

      // Check if subscription already has a schedule attached
      let schedule: Stripe.SubscriptionSchedule;
      if (subscription.schedule) {
        // Retrieve existing schedule (schedule can be string or SubscriptionSchedule)
        const scheduleId = typeof subscription.schedule === 'string'
          ? subscription.schedule
          : subscription.schedule.id;
        schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      } else {
        // Create a new schedule from the existing subscription
        schedule = await stripe.subscriptionSchedules.create({
          from_subscription: subscription.id,
        });
      }

      // Update schedule with two phases:
      // 1. Current plan until period end
      // 2. New (downgraded) plan starting at period end
      await stripe.subscriptionSchedules.update(schedule.id, {
        phases: [
          {
            items: [{ price: currentPriceId }],
            start_date: schedule.phases[0].start_date,
            end_date: currentPeriodEnd,
          },
          {
            items: [{ price: priceId }],
            start_date: currentPeriodEnd,
          },
        ],
      });

      return NextResponse.json({
        subscriptionId: subscription.id,
        scheduleId: schedule.id,
        status: 'scheduled',
        message: 'Plan change scheduled for next billing period',
        effectiveDate: new Date(currentPeriodEnd * 1000).toISOString(),
      });

    } else {
      // Apply upgrade immediately with proration
      const updatedSubscription = await stripe.subscriptions.update(
        subscription.id,
        {
          items: [{
            id: currentItemId,
            price: priceId,
          }],
          proration_behavior: 'create_prorations',
        }
      );

      return NextResponse.json({
        subscriptionId: updatedSubscription.id,
        status: updatedSubscription.status,
        message: 'Plan upgraded successfully',
      });
    }

  } catch (error) {
    console.error('Error updating subscription:', error);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update subscription' },
      { status: 500 }
    );
  }
}
