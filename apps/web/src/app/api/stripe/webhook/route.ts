import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, isNull, lte } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { subscriptions, stripeEvents } from '@pagespace/db/schema/subscriptions';
import { stripe, Stripe, getTierFromPrice } from '@/lib/stripe';
import { isSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { deriveTierFromSubscriptions } from '@pagespace/lib/billing/subscription-tier-sync';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveControlPlaneTier } from './control-plane-tier';
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import { userEmailMatch } from '@pagespace/lib/auth/user-repository';
import { applyStripeFunding } from '@pagespace/lib/billing/credit-funding';
import { getCreditPack } from '@pagespace/lib/billing/credit-pricing';
import { emitCreditsUpdated } from '@/lib/subscription/credit-balance';
import { sendSubscriptionReceiptEmail, sendTopupReceiptEmail } from '@/lib/billing/send-payment-receipt-email';
import { classifyDedupeOutcome, DEFAULT_LEASE_MS, type DedupeOutcome } from './dedupe';

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

    // Idempotency: claim this event id BEFORE processing. onConflictDoNothing().returning()
    // distinguishes a TRUE duplicate (conflict → no row returned) from a transient DB fault
    // (throws) — so we never silently ack (200) an event we actually failed to record, which
    // would let Stripe drop the redelivery and permanently lose paid funding. The decision is
    // a pure function (classifyDedupeOutcome) so every outcome is unit-tested without a DB.
    const now = new Date();
    let outcome: DedupeOutcome;
    try {
      const insertedRows = await db
        .insert(stripeEvents)
        .values({ id: event.id, type: event.type })
        .onConflictDoNothing({ target: stripeEvents.id })
        .returning({ id: stripeEvents.id });

      let existingProcessedAt: Date | null | undefined;
      let existingClaimedAt: Date | null | undefined;
      if (insertedRows.length === 0) {
        // Lost the race / redelivery: inspect the prior row. processedAt is null until
        // processing completes; createdAt is the lease anchor (when the id was claimed).
        const existing = await db
          .select({
            processedAt: stripeEvents.processedAt,
            createdAt: stripeEvents.createdAt,
          })
          .from(stripeEvents)
          .where(eq(stripeEvents.id, event.id))
          .limit(1);
        existingProcessedAt = existing[0]?.processedAt ?? null;
        existingClaimedAt = existing[0]?.createdAt ?? null;
      }

      outcome = classifyDedupeOutcome({
        inserted: insertedRows.length > 0,
        existingProcessedAt,
        existingClaimedAt,
        now,
      });

      if (outcome === 'reclaim') {
        // Atomic takeover of an abandoned marker (worker died after claiming but before
        // finishing). The WHERE guard — still unprocessed AND claimed before the lease
        // cutoff — lets exactly one concurrent redelivery win; it re-leases the row
        // (createdAt = now) and reprocesses. Losers match zero rows and fall back to retry.
        // The `lte` cutoff mirrors classifyDedupeOutcome's `age >= leaseMs` boundary exactly.
        const leaseCutoff = new Date(now.getTime() - DEFAULT_LEASE_MS);
        const reclaimed = await db
          .update(stripeEvents)
          .set({ createdAt: now, error: null })
          .where(
            and(
              eq(stripeEvents.id, event.id),
              isNull(stripeEvents.processedAt),
              lte(stripeEvents.createdAt, leaseCutoff)
            )
          )
          .returning({ id: stripeEvents.id });
        if (reclaimed.length > 0) {
          loggers.api.warn('Reclaimed abandoned Stripe event marker; reprocessing', {
            eventId: event.id,
          });
          outcome = 'process';
        } else {
          // Another delivery reclaimed it first, or it just finished — let Stripe redeliver.
          outcome = 'retry';
        }
      }
    } catch (insertError) {
      // A genuine DB fault (pool timeout, connection drop) — never a duplicate, since
      // onConflictDoNothing absorbs the unique violation. Force Stripe to redeliver.
      loggers.api.error(
        'Stripe webhook idempotency insert failed',
        insertError instanceof Error ? insertError : undefined,
        { eventId: event.id }
      );
      outcome = classifyDedupeOutcome({ inserted: false, error: insertError });
    }

    if (outcome === 'duplicate-ack') {
      // A prior delivery already processed this event to completion.
      loggers.api.info('Event already processed', { eventId: event.id });
      return NextResponse.json({ received: true }, { status: 200 });
    }
    if (outcome === 'retry') {
      // Either a transient insert failure, or a prior attempt that claimed the id but has
      // not finished (in flight or failed mid-way). 500 so Stripe redelivers instead of
      // dropping funding. Funding is idempotent on creditLedger.stripeRef, so reprocessing
      // credits the balance exactly once.
      loggers.api.warn('Stripe webhook signaling retry (insert fault or unfinished prior attempt)', {
        eventId: event.id,
      });
      return NextResponse.json({ error: 'Event not yet processed' }, { status: 500 });
    }
    // outcome === 'process' — first recording of this event; handle it below.

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

        case 'checkout.session.completed': {
          // Whole path is retryable: a transient failure in EITHER the handler or
          // funding clears the idempotency marker so Stripe redelivers (see below).
          const session = event.data.object as Stripe.Checkout.Session;
          await withFundingRetry(event.id, async () => {
            await handleCheckoutCompleted(session);
            // Fund the top-up bucket from a credit-pack purchase (no-op for other modes).
            await applyStripeFunding(event);
          });
          // Push the buyer's new balance to their open tabs so the top-up appears
          // live, and send a payment receipt. Both best-effort, post-commit; never
          // block the webhook ack (see sendTopupReceiptEmail's own try/catch).
          // The whole block is wrapped in its own try/catch: this runs AFTER funding
          // already committed, so a failure here (e.g. the name lookup) must never
          // escape to the outer catch — that would mark the event processedAt/error
          // and make a Stripe redelivery classify as duplicate-ack, permanently
          // skipping the receipt with no retry path even though funding succeeded.
          if (
            session.mode === 'payment' &&
            session.metadata?.kind === 'credit_pack' &&
            session.metadata?.userId
          ) {
            void emitCreditsUpdated(session.metadata.userId);

            try {
              const buyerEmail = session.customer_details?.email;
              if (buyerEmail) {
                const packLabel = getCreditPack(session.metadata.packId ?? '')?.label ?? 'Credit top-up';
                const buyer = await db
                  .select({ name: users.name })
                  .from(users)
                  .where(eq(users.id, session.metadata.userId))
                  .limit(1);
                void sendTopupReceiptEmail({
                  session,
                  packLabel,
                  email: buyerEmail,
                  userName: buyer[0]?.name ?? 'there',
                  eventId: event.id,
                });
              }
            } catch (error) {
              loggers.api.warn('Could not look up buyer for top-up receipt', {
                eventId: event.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          break;
        }

        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;

        case 'invoice.paid': {
          const invoice = event.data.object as Stripe.Invoice;
          await withFundingRetry(event.id, async () => {
            await handleInvoicePaid(invoice);
            // Reset the monthly credit bucket to the tier allowance on each renewal.
            // Derive the tier from the PAID invoice line so a refill that races ahead
            // of the subscription webhook still grants the correct (paid) allowance.
            await applyStripeFunding(event, { tier: tierFromInvoice(invoice) });
          });
          // Push the refilled balance to the user's open tabs, and send a payment
          // receipt. Both best-effort, post-commit — a receipt-send failure must
          // never affect funding that already succeeded (see
          // sendSubscriptionReceiptEmail's own try/catch) or force a Stripe retry.
          // Skipped for $0 invoices (proration/trial) — nothing to receipt.
          // The lookup itself is also wrapped: it runs AFTER funding already
          // committed, so letting it escape to the outer catch would mark the event
          // processedAt/error and make a Stripe redelivery classify as duplicate-ack,
          // permanently skipping the receipt with no retry path.
          try {
            const customerId = invoice.customer as string | null;
            if (customerId) {
              const refilled = await db
                .select({ id: users.id, name: users.name, email: users.email })
                .from(users)
                .where(eq(users.stripeCustomerId, customerId))
                .limit(1);
              if (refilled[0]) {
                void emitCreditsUpdated(refilled[0].id);
                if (invoice.amount_paid > 0) {
                  void sendSubscriptionReceiptEmail({
                    invoice,
                    email: refilled[0].email,
                    userName: refilled[0].name,
                    eventId: event.id,
                  });
                }
              }
            }
          } catch (error) {
            loggers.api.warn('Could not look up refilled user for subscription receipt', {
              eventId: event.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }

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

/**
 * Run a funding-relevant event path with RETRYABLE failure semantics.
 *
 * The stripeEvents idempotency marker is committed BEFORE processing, so any error
 * in this path would otherwise be lost forever: Stripe's redelivery short-circuits
 * as "already processed" (the insert above conflicts and returns 200), and the local
 * backfill cron reconciles only usage rows, not Stripe funding. To keep paid credit
 * from vanishing on a transient DB error, we delete that marker on ANY failure and
 * rethrow — the webhook then returns 500 and Stripe redelivers, reprocessing the
 * whole path. Funding is idempotent on creditLedger.stripeRef, so the balance is
 * credited exactly once even though the event is processed twice.
 *
 * The cleanup must wrap the WHOLE path, not just the funding call: the pre-funding
 * handler also does DB I/O (handleInvoicePaid looks the user up; handleCheckoutCompleted
 * links the customer), and a transient failure there must be retryable too — otherwise
 * the event is marked processed and funding never runs on redelivery.
 *
 * Safe to reprocess: on these events the pre-funding handlers are log-only/idempotent
 * (handleInvoicePaid only logs; handleCheckoutCompleted's sole throwable is an
 * idempotent customer-link upsert, and acts only for mode 'subscription' — a credit-pack
 * top-up is mode 'payment'; its provisioning POST swallows its own errors).
 */
async function withFundingRetry(eventId: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    await db.delete(stripeEvents).where(eq(stripeEvents.id, eventId));
    throw err;
  }
}

/**
 * Derive the subscription tier from a paid invoice's line price. This is authoritative
 * for the monthly refill because it reflects what was actually billed, independent of
 * whether our DB's users.subscriptionTier has caught up with the subscription webhook
 * (the two events can arrive in either order). Returns undefined when the invoice has
 * no recognizable subscription price — including getTierFromPrice's 'free' fallback for
 * an unmapped price — so the funding shell falls back to the stored user tier rather
 * than wrongly downgrading a paid user. Mirrors the extraction in stripe/invoices/route.ts.
 */
function tierFromInvoice(invoice: Stripe.Invoice): SubscriptionTier | undefined {
  const lines = invoice.lines?.data ?? [];
  const line = lines.find((l) => l.pricing?.price_details?.price) ?? lines[0];
  const priceData = line?.pricing?.price_details?.price;
  const priceId = typeof priceData === 'string' ? priceData : priceData?.id;
  if (!priceId) return undefined;
  const unitAmount = line?.pricing?.unit_amount_decimal
    ? Math.round(parseFloat(line.pricing.unit_amount_decimal) * 100)
    : null;
  const tier = getTierFromPrice(priceId, unitAmount);
  return tier === 'free' ? undefined : tier;
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

  // Derive the tier through the single canonical resolver (subscription-tier-sync.ts):
  // an entitled (active/trialing) row maps through the price→tier map; anything
  // else derives to 'free'. The periodic reconciler (reconcile-subscription-tiers
  // cron) uses this same function across the whole subscriptions table, so there
  // is exactly one rule for what a subscription state implies about the tier.
  const subscriptionTier = deriveTierFromSubscriptions(
    [{ status: subscription.status, stripePriceId: firstItem.price.id }],
    (priceId) => getTierFromPrice(priceId, firstItem.price.unit_amount),
  ).tier;

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
    const isGifted = subscription.metadata?.type === 'gift_subscription';
    await tx.insert(subscriptions).values({
      userId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: firstItem.price.id,
      status: subscription.status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      gifted: isGifted,
      // Clear schedule fields on insert (schedule details set by update-subscription route)
      stripeScheduleId: subscription.schedule ? String(subscription.schedule) : null,
      scheduledPriceId: null,
      scheduledChangeDate: null,
    }).onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: {
        status: subscription.status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        gifted: isGifted,
        // Clear schedule fields if schedule was released/completed
        ...(subscription.schedule === null && {
          stripeScheduleId: null,
          scheduledPriceId: null,
          scheduledChangeDate: null,
        }),
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
        .where(userEmailMatch(customerEmail));

      loggers.api.info('Linked Stripe customer to user', { customerId, email: maskEmail(customerEmail) });
    }

    // Bridge to control-plane: trigger tenant provisioning if metadata.slug is present
    const slug = session.metadata?.slug;
    if (slug) {
      const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
      if (!controlPlaneUrl) {
        loggers.api.warn('CONTROL_PLANE_URL not set, skipping tenant provisioning', { slug });
      } else {
        try {
          const rawTier = session.metadata?.tier;
          // Only remap tiers from the canonical SaaS vocabulary (fixes the
          // 'founder' bug — control-plane has no founder price/tier). A
          // control-plane-only value control-plane's own checkout can set
          // here (e.g. 'enterprise', which control-plane sells directly and
          // the SaaS vocabulary doesn't) must pass through UNCHANGED — it is
          // already valid for control-plane's tenant-validation, and forcing
          // it through the SaaS vocabulary would silently downgrade a paid
          // enterprise tenant to 'pro'.
          const tier = rawTier && isSubscriptionTier(rawTier) ? resolveControlPlaneTier(rawTier) : rawTier || 'pro';
          const ownerEmail = session.customer_details?.email || '';
          const response = await fetch(`${controlPlaneUrl}/api/tenants`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': process.env.CONTROL_PLANE_API_KEY || '',
            },
            body: JSON.stringify({
              slug,
              name: slug,
              ownerEmail,
              tier,
            }),
          });
          if (!response.ok) {
            loggers.api.warn('Control-plane provisioning returned non-2xx', {
              slug,
              tier,
              status: response.status,
            });
          } else {
            loggers.api.info('Control-plane provisioning triggered', {
              slug,
              tier,
              status: response.status,
            });
          }
        } catch (error) {
          loggers.api.error('Failed to trigger control-plane provisioning', error instanceof Error ? error : undefined, { slug });
        }
      }
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