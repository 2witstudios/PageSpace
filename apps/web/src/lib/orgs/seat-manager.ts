import { db, eq, and, organizations, orgSubscriptions } from '@pagespace/db';
import { stripe } from '../stripe';
import { getOrgMemberCount } from './guardrails';

const GRACE_PERIOD_DAYS = 3;

export interface SeatUpdateResult {
  success: boolean;
  newQuantity?: number;
  error?: string;
  prorated?: boolean;
}

export async function getActiveOrgSubscription(orgId: string) {
  const [sub] = await db
    .select()
    .from(orgSubscriptions)
    .where(and(
      eq(orgSubscriptions.orgId, orgId),
      eq(orgSubscriptions.status, 'active')
    ))
    .limit(1);

  return sub ?? null;
}

export async function adjustSeatsForMemberAdd(orgId: string): Promise<SeatUpdateResult> {
  const subscription = await getActiveOrgSubscription(orgId);
  if (!subscription) {
    return { success: true }; // Free tier, no subscription to adjust
  }

  const memberCount = await getOrgMemberCount(orgId);

  // Only increase if member count exceeds current seats
  if (memberCount <= subscription.quantity) {
    return { success: true, newQuantity: subscription.quantity };
  }

  try {
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{
        id: await getSubscriptionItemId(subscription.stripeSubscriptionId),
        quantity: memberCount,
      }],
      proration_behavior: 'always_invoice',
    });

    await db
      .update(orgSubscriptions)
      .set({ quantity: memberCount })
      .where(eq(orgSubscriptions.id, subscription.id));

    return { success: true, newQuantity: memberCount, prorated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to adjust seats';
    return { success: false, error: message };
  }
}

export async function adjustSeatsForMemberRemove(orgId: string): Promise<SeatUpdateResult> {
  const subscription = await getActiveOrgSubscription(orgId);
  if (!subscription) {
    return { success: true };
  }

  const memberCount = await getOrgMemberCount(orgId);

  // Only decrease if member count is less than current seats
  if (memberCount >= subscription.quantity) {
    return { success: true, newQuantity: subscription.quantity };
  }

  try {
    // Set grace period - seat count decreases at end of grace period
    const gracePeriodEnd = new Date();
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + GRACE_PERIOD_DAYS);

    await db
      .update(orgSubscriptions)
      .set({ gracePeriodEnd })
      .where(eq(orgSubscriptions.id, subscription.id));

    // Schedule the actual seat decrease after grace period
    // The seat count in Stripe updates immediately for billing purposes
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{
        id: await getSubscriptionItemId(subscription.stripeSubscriptionId),
        quantity: memberCount,
      }],
      proration_behavior: 'create_prorations',
    });

    await db
      .update(orgSubscriptions)
      .set({ quantity: memberCount })
      .where(eq(orgSubscriptions.id, subscription.id));

    return { success: true, newQuantity: memberCount, prorated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to adjust seats';
    return { success: false, error: message };
  }
}

export async function updateSeatCount(
  orgId: string,
  newQuantity: number
): Promise<SeatUpdateResult> {
  if (newQuantity < 1) {
    return { success: false, error: 'Seat count must be at least 1' };
  }

  const subscription = await getActiveOrgSubscription(orgId);
  if (!subscription) {
    return { success: false, error: 'No active subscription found' };
  }

  const memberCount = await getOrgMemberCount(orgId);
  if (newQuantity < memberCount) {
    return {
      success: false,
      error: `Cannot reduce seats below current member count (${memberCount})`,
    };
  }

  try {
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{
        id: await getSubscriptionItemId(subscription.stripeSubscriptionId),
        quantity: newQuantity,
      }],
      proration_behavior: 'always_invoice',
    });

    await db
      .update(orgSubscriptions)
      .set({ quantity: newQuantity, gracePeriodEnd: null })
      .where(eq(orgSubscriptions.id, subscription.id));

    return { success: true, newQuantity, prorated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update seats';
    return { success: false, error: message };
  }
}

async function getSubscriptionItemId(stripeSubscriptionId: string): Promise<string> {
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const item = subscription.items.data[0];
  if (!item) {
    throw new Error('No subscription item found');
  }
  return item.id;
}

export async function getOrgBillingOverview(orgId: string) {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      billingTier: organizations.billingTier,
      stripeCustomerId: organizations.stripeCustomerId,
      billingEmail: organizations.billingEmail,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return null;

  const subscription = await getActiveOrgSubscription(orgId);
  const memberCount = await getOrgMemberCount(orgId);

  return {
    org,
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      quantity: subscription.quantity,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      gracePeriodEnd: subscription.gracePeriodEnd,
    } : null,
    memberCount,
  };
}
