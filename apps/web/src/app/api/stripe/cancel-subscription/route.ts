import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, eq, users, subscriptions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * POST /api/stripe/cancel-subscription
 * Schedule subscription cancellation at period end.
 * User keeps access until the end of their billing period.
 */
export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
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

    // Cancel at period end
    const subscription = await stripe.subscriptions.update(
      currentSubscription.stripeSubscriptionId,
      { cancel_at_period_end: true }
    );

    // Update local record
    await db.update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.id, currentSubscription.id));

    return NextResponse.json({
      subscriptionId: subscription.id,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
      message: 'Subscription will be cancelled at the end of the billing period',
    });

  } catch (error) {
    console.error('Error cancelling subscription:', error);

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
