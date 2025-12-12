import { NextRequest, NextResponse } from 'next/server';
import { db, eq, subscriptions, stripeEvents, users } from '@pagespace/db';
import { stripe, Stripe, getTierFromPrice } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

export async function POST(request: NextRequest) {
  try {
    // Get raw body for signature verification
    const payload = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    // Verify webhook signature
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      loggers.api.error('STRIPE_WEBHOOK_SECRET environment variable is not set');
      return NextResponse.json({ error: 'Webhook configuration error' }, { status: 500 });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret
      );
    } catch (err) {
      loggers.api.error('Webhook signature verification failed', err instanceof Error ? err : undefined);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Check for idempotency - insert event ID first
    try {
      await db.insert(stripeEvents).values({
        id: event.id,
        type: event.type,
      });
    } catch {
      // Event already processed
      loggers.api.info('Event already processed', { eventId: event.id });
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Process the event
    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await handleSubscriptionChange(event.data.object as Stripe.Subscription);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;

        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;

        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;

        case 'invoice.paid':
          await handleInvoicePaid(event.data.object as Stripe.Invoice);
          break;

        default:
          loggers.api.info('Unhandled webhook event type', { eventType: event.type, eventId: event.id });
      }

      // Mark event as processed successfully
      await db.update(stripeEvents)
        .set({ processedAt: new Date() })
        .where(eq(stripeEvents.id, event.id));

    } catch (processError) {
      loggers.api.error('Error processing webhook event', processError instanceof Error ? processError : undefined, { eventId: event.id });

      // Mark event as failed
      await db.update(stripeEvents)
        .set({
          error: processError instanceof Error ? processError.message : 'Unknown error',
          processedAt: new Date()
        })
        .where(eq(stripeEvents.id, event.id));

      return NextResponse.json(
        { error: 'Event processing failed' },
        { status: 500 }
      );
    }

    return NextResponse.json({ received: true }, { status: 200 });

  } catch (error) {
    loggers.api.error('Webhook error', error instanceof Error ? error : undefined);
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}

async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  // Find user by stripe customer ID
  const user = await db.select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user.length) {
    // Don't throw - this could be a race condition where customer was just created
    // Stripe will send another webhook when the subscription is updated
    loggers.api.warn('User not found for customer ID, skipping subscription update', { customerId });
    return;
  }

  const userId = user[0].id;

  // Validate subscription has items before accessing
  const firstItem = subscription.items?.data?.[0];
  if (!firstItem) {
    throw new Error(`Subscription ${subscription.id} has no items`);
  }

  // Determine subscription tier based on price or subscription status
  const isEntitled = ['active', 'trialing'].includes(subscription.status);

  let subscriptionTier: 'free' | 'pro' | 'founder' | 'business';

  if (!isEntitled) {
    // If not active/trialing, set to free regardless of price
    subscriptionTier = 'free';
  } else {
    // Use centralized price → tier mapping
    const priceId = firstItem.price.id;
    const priceAmount = firstItem.price.unit_amount;
    subscriptionTier = getTierFromPrice(priceId, priceAmount);
  }

  // Get period from the first subscription item (API version 2025-08-27 change)
  // Use intersection type to safely extend SubscriptionItem with the new fields
  const itemWithPeriod = firstItem as Stripe.SubscriptionItem & {
    current_period_start: number;
    current_period_end: number;
  };
  const currentPeriodStartTs = itemWithPeriod.current_period_start;
  const currentPeriodEndTs = itemWithPeriod.current_period_end;

  // Validate dates
  if (!currentPeriodStartTs || !currentPeriodEndTs) {
    loggers.api.error('Missing period dates for subscription (checked item-level)', undefined, {
      subscriptionId: subscription.id,
      itemId: firstItem.id,
      start: currentPeriodStartTs,
      end: currentPeriodEndTs
    });
    throw new Error(`Missing period dates for subscription ${subscription.id}`);
  }

  const currentPeriodStart = new Date(currentPeriodStartTs * 1000);
  const currentPeriodEnd = new Date(currentPeriodEndTs * 1000);

  if (isNaN(currentPeriodStart.getTime()) || isNaN(currentPeriodEnd.getTime())) {
    loggers.api.error('Invalid period dates for subscription', undefined, {
      subscriptionId: subscription.id,
      startRaw: currentPeriodStartTs,
      endRaw: currentPeriodEndTs,
      startParsed: currentPeriodStart.toISOString(),
      endParsed: currentPeriodEnd.toISOString()
    });
    throw new Error(`Invalid period dates for subscription ${subscription.id}`);
  }

  // Use transaction to ensure subscription and user updates are atomic
  await db.transaction(async (tx) => {
    // Upsert subscription record
    await tx.insert(subscriptions).values({
      userId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: firstItem.price.id,
      status: subscription.status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    }).onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: {
        status: subscription.status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: new Date(),
      }
    });

    // Update user subscription tier
    await tx.update(users)
      .set({
        subscriptionTier,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  });

  // Storage limits are now computed dynamically from subscription tier - no sync needed

  loggers.api.info('Updated subscription for user', { userId, subscriptionTier });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  // Find user by stripe customer ID
  const user = await db.select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user.length) {
    // Don't throw - user might have been deleted or this is a test customer
    loggers.api.warn('User not found for customer ID, skipping subscription deletion', { customerId });
    return;
  }

  const userId = user[0].id;

  // Use transaction to ensure user and subscription updates are atomic
  await db.transaction(async (tx) => {
    // Downgrade to free tier
    await tx.update(users)
      .set({
        subscriptionTier: 'free',
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Mark subscription as canceled
    await tx.update(subscriptions)
      .set({
        status: 'canceled',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
  });

  // Storage limits are now computed dynamically from subscription tier - no sync needed

  loggers.api.info('Downgraded user to free tier', { userId });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode === 'subscription' && session.customer) {
    const customerId = session.customer as string;
    const customerEmail = session.customer_details?.email;

    if (customerEmail) {
      // Update user with stripe customer ID
      await db.update(users)
        .set({
          stripeCustomerId: customerId,
          updatedAt: new Date(),
        })
        .where(eq(users.email, customerEmail));

      loggers.api.info('Linked Stripe customer to user', { customerId, email: customerEmail });
    }
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Find user by stripe customer ID
  const user = await db.select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user.length) {
    loggers.api.warn('User not found for customer ID on payment failure', { customerId });
    return;
  }

  // Payment failure is handled by subscription status changes
  // This is mainly for logging and potential notification logic
  loggers.api.info('Payment failed for user', { userId: user[0].id });
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Find user by stripe customer ID
  const user = await db.select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user.length) {
    loggers.api.warn('User not found for customer ID on invoice paid', { customerId });
    return;
  }

  // Log successful payment
  // This confirms payment was received (more reliable than subscription status alone)
  loggers.api.info('Invoice paid', { userId: user[0].id, invoiceId: invoice.id, amountPaid: invoice.amount_paid });

  // Future: Track discount info for "You saved $X" display
  // if (invoice.discount) {
  //   console.log(`Discount applied: ${invoice.discount.coupon?.name}`);
  // }
}