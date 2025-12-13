import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * POST /api/stripe/create-subscription
 * Create a new subscription for users upgrading from free tier.
 * Returns clientSecret for PaymentElement confirmation.
 */
export async function POST(request: NextRequest) {

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { priceId, promotionCodeId } = body;

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

    // Check if user already has a paid subscription
    if (user.subscriptionTier !== 'free') {
      return NextResponse.json(
        { error: 'User already has an active subscription. Use update-subscription instead.' },
        { status: 400 }
      );
    }

    // Get or create Stripe customer with rollback on failure
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;

      try {
        await db.update(users)
          .set({ stripeCustomerId: customerId, updatedAt: new Date() })
          .where(eq(users.id, userId));
      } catch (dbError) {
        // Rollback: delete the orphaned Stripe customer
        await stripe.customers.del(customerId);
        throw dbError;
      }
    }

    // Create subscription with incomplete status to collect payment
    // Use confirmation_secret expansion (newer API) instead of payment_intent
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.confirmation_secret'],
      metadata: { userId: user.id },
      // Apply promotion code if provided
      ...(promotionCodeId && {
        discounts: [{ promotion_code: promotionCodeId }],
      }),
    });

    const invoice = subscription.latest_invoice as Stripe.Invoice & {
      confirmation_secret?: { client_secret: string; type: string };
    };

    const clientSecret = invoice.confirmation_secret?.client_secret;

    if (!clientSecret) {
      loggers.api.error('No client secret found in confirmation_secret', { subscriptionId: subscription.id });
      return NextResponse.json(
        { error: 'Failed to create payment intent' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      subscriptionId: subscription.id,
      clientSecret,
      status: subscription.status,
    });

  } catch (error) {
    loggers.api.error('Error creating subscription', error instanceof Error ? error : undefined, { error });

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create subscription' },
      { status: 500 }
    );
  }
}
