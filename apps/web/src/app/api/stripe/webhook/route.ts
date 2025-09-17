import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, eq, subscriptions, stripeEvents, users } from '@pagespace/db';

export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });
  try {
    // Get raw body for signature verification
    const payload = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
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
      console.log(`Event ${event.id} already processed`);
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

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      // Mark event as processed successfully
      await db.update(stripeEvents)
        .set({ processedAt: new Date() })
        .where(eq(stripeEvents.id, event.id));

    } catch (processError) {
      console.error(`Error processing event ${event.id}:`, processError);

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
    console.error('Webhook error:', error);
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}

async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  // Type assertion for missing properties in Stripe types
  const typedSubscription = subscription as Stripe.Subscription & {
    current_period_start: number;
    current_period_end: number;
    cancel_at_period_end: boolean;
  };

  // Find user by stripe customer ID
  const user = await db.select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user.length) {
    throw new Error(`User not found for customer ID: ${customerId}`);
  }

  const userId = user[0].id;

  // Determine subscription tier
  const isEntitled = ['active', 'trialing'].includes(subscription.status);
  const subscriptionTier = isEntitled ? 'pro' : 'normal';

  // Upsert subscription record
  await db.insert(subscriptions).values({
    userId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: subscription.items.data[0].price.id,
    status: subscription.status,
    currentPeriodStart: new Date(typedSubscription.current_period_start * 1000),
    currentPeriodEnd: new Date(typedSubscription.current_period_end * 1000),
    cancelAtPeriodEnd: typedSubscription.cancel_at_period_end,
  }).onConflictDoUpdate({
    target: subscriptions.stripeSubscriptionId,
    set: {
      status: subscription.status,
      currentPeriodStart: new Date(typedSubscription.current_period_start * 1000),
      currentPeriodEnd: new Date(typedSubscription.current_period_end * 1000),
      cancelAtPeriodEnd: typedSubscription.cancel_at_period_end,
      updatedAt: new Date(),
    }
  });

  // Update user subscription tier
  await db.update(users)
    .set({
      subscriptionTier,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  // Update storage tier using the storage service
  const { updateStorageTierFromSubscription } = await import('@pagespace/lib/services/storage-limits');
  await updateStorageTierFromSubscription(userId, subscriptionTier);

  console.log(`Updated subscription for user ${userId}: ${subscriptionTier}`);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  // Find user by stripe customer ID
  const user = await db.select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user.length) {
    throw new Error(`User not found for customer ID: ${customerId}`);
  }

  const userId = user[0].id;

  // Downgrade to normal tier
  await db.update(users)
    .set({
      subscriptionTier: 'normal',
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  // Update storage tier using the storage service
  const { updateStorageTierFromSubscription } = await import('@pagespace/lib/services/storage-limits');
  await updateStorageTierFromSubscription(userId, 'normal');

  // Mark subscription as canceled
  await db.update(subscriptions)
    .set({
      status: 'canceled',
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, subscription.id));

  console.log(`Downgraded user ${userId} to normal tier`);
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

      console.log(`Linked customer ${customerId} to user with email ${customerEmail}`);
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
    console.warn(`User not found for customer ID: ${customerId}`);
    return;
  }

  // Payment failure is handled by subscription status changes
  // This is mainly for logging and potential notification logic
  console.log(`Payment failed for user ${user[0].id}`);
}