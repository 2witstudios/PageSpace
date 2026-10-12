/**
 * org-gift — the I/O shell of an admin gifting an organization (Spec SEAT-8, [D-OW-23]);
 * the decision is org-gift-core's planOrgGift.
 *
 * Zero trust: the org and its subscription id are re-read from the database under the
 * org's billing lock (the lock provisioning, seat sync and the webhook mirror hold), never
 * taken from the request. Stripe is reached only through {@link OrgGiftStripe}, so the
 * admin route passes its client and tests pass an in-memory one. Each write carries an
 * idempotency key, so a retried request replays instead of gifting twice.
 *
 * Funding is NOT written here: the gift's $0 invoice reaches the webhook's invoice.paid,
 * and the one funding path (applyOrgPoolRefill) funds the pool at list × ratio because the
 * invoice is on the org's own subscription and carries the gift metadata.
 */
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { orgSubscriptions } from '@pagespace/db/schema/organizations';
import { isBillingEnabled } from '../deployment-mode';
import { loggers } from '../logging/logger-config';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { findMembershipRole, findOrganizationById } from '../organizations/repository';
import { orgBillingLockKey } from './org-subscription-core';
import {
  planOrgGift,
  type OrgGiftCouponParams,
  type OrgGiftRefusal,
  type OrgGiftSubscriptionUpdate,
} from './org-gift-core';

/** The two Stripe writes a gift makes — narrow, so tests supply an in-memory Stripe. */
export interface OrgGiftStripe {
  createCoupon(params: OrgGiftCouponParams, idempotencyKey: string): Promise<{ id: string }>;
  updateSubscription(subscriptionId: string, params: OrgGiftSubscriptionUpdate, idempotencyKey: string): Promise<{ id: string; status: string }>;
}

export type OrgGiftResult =
  | { kind: 'refused'; reason: OrgGiftRefusal }
  | { kind: 'gifted'; subscriptionId: string; couponId: string; status: string; restoresNow: boolean };

export async function giftOrgSubscription(
  input: { orgId: string; adminUserId: string; reason: string },
  stripe: OrgGiftStripe,
): Promise<OrgGiftResult> {
  const found = await findOrganizationById(input.orgId);
  const org = found ? { adminRole: await findMembershipRole(input.orgId, input.adminUserId) } : null;
  const result = await db.transaction(async (tx): Promise<OrgGiftResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgBillingLockKey(input.orgId)}, 0))`);
    const [stored] = await tx
      .select({ stripeSubscriptionId: orgSubscriptions.stripeSubscriptionId, status: orgSubscriptions.status, gifted: orgSubscriptions.gifted })
      .from(orgSubscriptions)
      .where(eq(orgSubscriptions.orgId, input.orgId))
      .limit(1);
    const plan = planOrgGift({ ...input, billingEnabled: isBillingEnabled(), org, stored: stored ? { ...stored, gifted: stored.gifted === true } : null });
    if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason };

    const coupon = await stripe.createCoupon(plan.coupon, plan.couponKey);
    const sub = await stripe.updateSubscription(plan.subscriptionId, plan.update, plan.updateKey);
    return { kind: 'gifted', subscriptionId: sub.id, couponId: coupon.id, status: sub.status, restoresNow: plan.restoresNow };
  });

  if (result.kind === 'refused') {
    loggers.api.info('admin org gift refused', { orgId: input.orgId, adminUserId: input.adminUserId, reason: result.reason });
    return result;
  }
  loggers.api.info('admin gifted org subscription', { orgId: input.orgId, adminUserId: input.adminUserId, ...result });
  // AUD-1: in the org's own log too (ids only; the admin trail keeps the reason).
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: 'org.billing.subscription_changed',
    actorId: input.adminUserId,
    resourceType: 'org_subscription',
    resourceId: input.orgId,
    details: { source: 'admin_gift', stripeSubscriptionId: result.subscriptionId, couponId: result.couponId, restoresNow: result.restoresNow },
  });
  return result;
}
