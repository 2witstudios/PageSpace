import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

interface CancelCheckoutRequest {
  subscriptionId: string;
}

/**
 * POST /api/stripe/cancel-checkout
 * Cancel an incomplete subscription when user abandons checkout.
 *
 * Safety: Only cancels subscriptions in 'incomplete' status that
 * belong to the authenticated user.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = (await request.json()) as CancelCheckoutRequest;
    const { subscriptionId } = body;

    if (!subscriptionId) {
      return NextResponse.json(
        { error: 'Subscription ID is required' },
        { status: 400 }
      );
    }

    // Get user to verify ownership
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get the subscription with expanded invoice and payment_intent
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent'],
    });

    // Verify ownership
    if (subscription.metadata?.userId !== userId) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // CRITICAL: Only allow canceling incomplete subscriptions
    if (subscription.status !== 'incomplete') {
      return NextResponse.json(
        { error: 'Only incomplete subscriptions can be canceled via this endpoint' },
        { status: 400 }
      );
    }

    // Extract payment intent from expanded invoice
    const invoice = subscription.latest_invoice as Stripe.Invoice & {
      payment_intent?: Stripe.PaymentIntent | string | null;
    };
    const paymentIntent =
      typeof invoice?.payment_intent === 'object' ? invoice.payment_intent : null;

    // Cancel the PaymentIntent first (if exists and not already canceled)
    if (paymentIntent && paymentIntent.status !== 'canceled') {
      await stripe.paymentIntents.cancel(paymentIntent.id);
      loggers.api.info('Canceled PaymentIntent for abandoned checkout', {
        paymentIntentId: paymentIntent.id,
        subscriptionId,
        userId,
      });
    }

    // Cancel the subscription (voids the draft invoice)
    await stripe.subscriptions.cancel(subscriptionId);
    loggers.api.info('Canceled incomplete subscription for abandoned checkout', {
      subscriptionId,
      userId,
    });

    return NextResponse.json({
      success: true,
      message: 'Checkout canceled successfully',
    });
  } catch (error) {
    loggers.api.error(
      'Error canceling checkout',
      error instanceof Error ? error : undefined
    );

    if (error instanceof Stripe.errors.StripeError) {
      // Don't expose Stripe errors to client for this cleanup operation
      // Just log them and return success (best effort cleanup)
      loggers.api.warn('Stripe error during checkout cancellation', {
        code: error.code,
        message: error.message,
      });

      // Return success anyway - don't block UI for cleanup failures
      return NextResponse.json({
        success: true,
        message: 'Checkout canceled',
      });
    }

    return NextResponse.json(
      { error: 'Failed to cancel checkout' },
      { status: 500 }
    );
  }
}
