import { db, eq, organizations, orgSubscriptions } from '@pagespace/db';
import type Stripe from 'stripe';
import { stripeConfig } from '../stripe-config';
import type { OrgBillingTier } from './billing-plans';

export async function handleOrgSubscriptionChange(subscription: Stripe.Subscription) {
  const orgId = subscription.metadata?.orgId;
  if (!orgId || subscription.metadata?.type !== 'organization') {
    return; // Not an org subscription
  }

  const subscriptionItem = subscription.items.data[0];
  if (!subscriptionItem) return;

  const periodStart = subscriptionItem.current_period_start;
  const periodEnd = subscriptionItem.current_period_end;
  if (!periodStart || !periodEnd) {
    throw new Error(`Missing period dates for org subscription ${subscription.id}`);
  }
  const currentPeriodStart = new Date(periodStart * 1000);
  const currentPeriodEnd = new Date(periodEnd * 1000);

  // Atomic upsert — handles race conditions from concurrent webhook deliveries
  await db.insert(orgSubscriptions).values({
    orgId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: subscriptionItem.price.id,
    status: subscription.status,
    quantity: subscriptionItem.quantity ?? 1,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  }).onConflictDoUpdate({
    target: orgSubscriptions.stripeSubscriptionId,
    set: {
      status: subscription.status,
      stripePriceId: subscriptionItem.price.id,
      quantity: subscriptionItem.quantity ?? 1,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: new Date(),
    },
  });

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

// Map org-specific Stripe price IDs to billing tiers.
// Uses the same stripeConfig pattern as the individual subscription system.
const ORG_PRICE_TO_TIER: Record<string, OrgBillingTier> = {
  [stripeConfig.priceIds.pro]: 'pro',
  [stripeConfig.priceIds.business]: 'business',
};

function getOrgTierFromPrice(priceId: string): OrgBillingTier | null {
  return ORG_PRICE_TO_TIER[priceId] ?? null;
}
