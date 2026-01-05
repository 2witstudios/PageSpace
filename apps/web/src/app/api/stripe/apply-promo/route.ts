import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { getUserFriendlyStripeError } from '@/lib/stripe-errors';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

interface ApplyPromoRequest {
  subscriptionId: string;
  promotionCodeId: string;
}

/**
 * POST /api/stripe/apply-promo
 * Apply a promotion code to an incomplete subscription by recreating it.
 *
 * For "first-time customer" promo codes to work, the promo must be applied
 * at subscription creation time (before any PaymentIntent exists).
 * This endpoint cancels the existing subscription and creates a new one
 * with the promo code applied from the start.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json() as ApplyPromoRequest;
    const { subscriptionId, promotionCodeId } = body;

    if (!subscriptionId || !promotionCodeId) {
      return NextResponse.json(
        { error: 'Subscription ID and promotion code ID are required' },
        { status: 400 }
      );
    }

    // Get user to verify ownership
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get the subscription with expanded invoice and payment_intent
    const oldSubscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent'],
    });

    if (oldSubscription.metadata?.userId !== userId) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // Only allow applying promo to incomplete subscriptions
    if (oldSubscription.status !== 'incomplete') {
      return NextResponse.json(
        { error: 'Promotion codes can only be applied to pending subscriptions' },
        { status: 400 }
      );
    }

    // Extract details from old subscription
    const priceId = oldSubscription.items.data[0].price.id;
    const customerId = oldSubscription.customer as string;
    const oldInvoice = oldSubscription.latest_invoice as Stripe.Invoice & {
      payment_intent?: Stripe.PaymentIntent | string | null;
    };
    const oldPaymentIntent = typeof oldInvoice?.payment_intent === 'object'
      ? oldInvoice.payment_intent
      : null;

    // Cancel the PaymentIntent first (to clear "initiated PaymentIntent" flag)
    if (oldPaymentIntent && oldPaymentIntent.status !== 'canceled') {
      await stripe.paymentIntents.cancel(oldPaymentIntent.id);
      loggers.api.info('Canceled old PaymentIntent for promo application', {
        paymentIntentId: oldPaymentIntent.id,
        subscriptionId,
      });
    }

    // Cancel the old subscription (voids the invoice)
    await stripe.subscriptions.cancel(subscriptionId);
    loggers.api.info('Canceled old subscription for promo application', {
      subscriptionId,
      userId,
    });

    // Create new subscription WITH promo applied from the start
    const newSubscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.confirmation_secret'],
      metadata: { userId },
      discounts: [{ promotion_code: promotionCodeId }],
    });

    const newInvoice = newSubscription.latest_invoice as Stripe.Invoice & {
      confirmation_secret?: { client_secret: string };
    };

    const clientSecret = newInvoice.confirmation_secret?.client_secret;

    if (!clientSecret) {
      loggers.api.error('No client secret in new subscription', {
        newSubscriptionId: newSubscription.id,
      });
      return NextResponse.json(
        { error: 'Failed to create payment intent for new subscription' },
        { status: 500 }
      );
    }

    loggers.api.info('Promo code applied via subscription recreation', {
      oldSubscriptionId: subscriptionId,
      newSubscriptionId: newSubscription.id,
      promotionCodeId,
      userId,
      amountDue: newInvoice.amount_due,
    });

    // Get discount info from the new invoice
    // In Stripe v20, discounts can be string IDs or expanded objects
    const discountItem = newInvoice.discounts?.[0];
    const discount = typeof discountItem === 'object' ? discountItem as Stripe.Discount : null;
    // In Stripe v20, coupon is nested under source.coupon
    const coupon = discount?.source?.coupon;

    return NextResponse.json({
      success: true,
      subscriptionId: newSubscription.id,
      clientSecret,
      amountDue: newInvoice.amount_due,
      discount: coupon && typeof coupon === 'object' ? {
        couponId: coupon.id,
        percentOff: coupon.percent_off,
        amountOff: coupon.amount_off,
      } : null,
    });

  } catch (error) {
    loggers.api.error('Error applying promo code', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: getUserFriendlyStripeError(error) },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to apply promotion code' },
      { status: 500 }
    );
  }
}
