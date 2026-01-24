import { NextRequest, NextResponse } from 'next/server';
import { db, eq, and, inArray, desc, users, subscriptions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/stripe/cancel-schedule
 * Cancel a pending plan change (downgrade) without cancelling the subscription.
 * Releases the subscription schedule and clears schedule info from database.
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

    // Get current active subscription
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

    // Check if there's a schedule to cancel
    if (!currentSubscription.stripeScheduleId) {
      return NextResponse.json(
        { error: 'No pending plan change to cancel' },
        { status: 400 }
      );
    }

    // Release the schedule in Stripe
    await stripe.subscriptionSchedules.release(currentSubscription.stripeScheduleId);

    // Clear schedule info from database
    await db.update(subscriptions)
      .set({
        stripeScheduleId: null,
        scheduledPriceId: null,
        scheduledChangeDate: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, currentSubscription.id));

    return NextResponse.json({
      success: true,
      message: 'Pending plan change cancelled successfully',
    });

  } catch (error) {
    loggers.api.error('Error cancelling schedule', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to cancel pending plan change' },
      { status: 500 }
    );
  }
}
