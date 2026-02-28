import { db, eq, and, organizations, orgSubscriptions } from '@pagespace/db';
import type Stripe from 'stripe';

export async function handleOrgSubscriptionChange(subscription: Stripe.Subscription) {
  const orgId = subscription.metadata?.orgId;
  if (!orgId || subscription.metadata?.type !== 'organization') {
    return; // Not an org subscription
  }

  const subscriptionItem = subscription.items.data[0];
  if (!subscriptionItem) return;

  const currentPeriodStart = subscriptionItem.current_period_start
    ? new Date(subscriptionItem.current_period_start * 1000)
    : new Date();
  const currentPeriodEnd = subscriptionItem.current_period_end
    ? new Date(subscriptionItem.current_period_end * 1000)
    : new Date();

  // Upsert org subscription
  const [existing] = await db
    .select({ id: orgSubscriptions.id })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.stripeSubscriptionId, subscription.id))
    .limit(1);

  if (existing) {
    await db
      .update(orgSubscriptions)
      .set({
        status: subscription.status,
        stripePriceId: subscriptionItem.price.id,
        quantity: subscriptionItem.quantity ?? 1,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      })
      .where(eq(orgSubscriptions.id, existing.id));
  } else {
    await db.insert(orgSubscriptions).values({
      orgId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscriptionItem.price.id,
      status: subscription.status,
      quantity: subscriptionItem.quantity ?? 1,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
  }

  // Update org billing tier based on price
  const tier = getOrgTierFromPrice(subscriptionItem.price.id);
  if (tier) {
    await db
      .update(organizations)
      .set({ billingTier: tier })
      .where(eq(organizations.id, orgId));
  }
}

export async function handleOrgSubscriptionDeleted(subscription: Stripe.Subscription) {
  const orgId = subscription.metadata?.orgId;
  if (!orgId || subscription.metadata?.type !== 'organization') {
    return;
  }

  await db
    .update(orgSubscriptions)
    .set({ status: 'canceled' })
    .where(eq(orgSubscriptions.stripeSubscriptionId, subscription.id));

  await db
    .update(organizations)
    .set({ billingTier: 'free' })
    .where(eq(organizations.id, orgId));
}

// Map org-specific price IDs to tiers
// These would be configured per environment similar to existing stripe-config.ts
const ORG_PRICE_TO_TIER: Record<string, string> = {};

function getOrgTierFromPrice(priceId: string): string | null {
  return ORG_PRICE_TO_TIER[priceId] ?? null;
}
