/**
 * org-gift — the I/O shell of an admin gifting an organization and revoking that gift (Spec
 * SEAT-8, [D-OW-23], [D-OW-54]); the decisions are org-gift-core's planOrgGift / planOrgUngift.
 *
 * Zero trust: the org and its subscription are re-read from the database under the org's
 * billing lock (the lock provisioning, seat sync, the webhook mirror and the pool refill's
 * gift read hold), never taken from the request. Stripe is reached only through
 * {@link OrgGiftStripe}, so the admin routes pass their client and tests pass an in-memory
 * one. Each write carries an idempotency key, and the coupon is retrieved before it is
 * created, so a gift interrupted between its writes completes on any retry.
 *
 * Funding is NOT written here: the gift's $0 invoices reach the webhook's invoice.paid, and
 * the one funding path (applyOrgPoolRefill) funds the pool at list × ratio for the pinned
 * gifted seats because the invoice is on the org's own subscription and carries the gift
 * metadata.
 */
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { orgSubscriptions } from '@pagespace/db/schema/organizations';
import { isBillingEnabled } from '../deployment-mode';
import { loggers } from '../logging/logger-config';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { countOrgSeatParts, findMembershipRole, findOrganizationById } from '../organizations/repository';
import { seatQuantity } from '../organizations/seats';
import { orgBillingLockKey, orgExtraSeatQuantity, planSeatQuantitySync } from './org-subscription-core';
import { TIER_PLAN_LIMITS } from './subscription-tiers';
import {
  orgGiftVoidKey,
  planOrgGift,
  planOrgUngift,
  type OrgGiftCouponParams,
  type OrgGiftRefusal,
  type OrgGiftStored,
  type OrgGiftSubscriptionUpdate,
  type OrgUngiftSubscriptionUpdate,
} from './org-gift-core';

/** The Stripe calls a gift and its revoke make — narrow, so tests supply an in-memory Stripe. */
export interface OrgGiftStripe {
  /** The coupon, or null when Stripe has none with this id. */
  retrieveCoupon(id: string): Promise<{ id: string } | null>;
  createCoupon(params: OrgGiftCouponParams, idempotencyKey: string): Promise<{ id: string }>;
  /** Ids of the subscription's invoices still open (unpaid, collectable). */
  listOpenInvoiceIds(subscriptionId: string): Promise<string[]>;
  voidInvoice(invoiceId: string, idempotencyKey: string): Promise<void>;
  updateSubscription(
    subscriptionId: string,
    params: OrgGiftSubscriptionUpdate | OrgUngiftSubscriptionUpdate,
    idempotencyKey: string,
  ): Promise<{ id: string; status: string }>;
  /** The seat item's quantity, set with no proration (a revoke re-syncs it to the seats held). */
  setSeatQuantity(params: { itemId: string; quantity: number; prorationBehavior: 'none' }, idempotencyKey: string): Promise<{ quantity: number }>;
}

export type OrgGiftResult =
  | { kind: 'refused'; reason: OrgGiftRefusal }
  | {
      kind: 'gifted';
      subscriptionId: string;
      couponId: string;
      status: string;
      restoresNow: boolean;
      giftedExtraSeats: number;
      voidedInvoiceIds: string[];
    };

export type OrgUngiftResult =
  | { kind: 'refused'; reason: OrgGiftRefusal }
  | { kind: 'ungifted'; subscriptionId: string; status: string; extraSeatQuantity: number };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface StoredGiftRow extends OrgGiftStored {
  extraSeatQuantity: number;
  seatRevision: number;
}

async function lockAndReadStored(tx: Tx, orgId: string): Promise<StoredGiftRow | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgBillingLockKey(orgId)}, 0))`);
  const [row] = await tx
    .select({
      stripeSubscriptionId: orgSubscriptions.stripeSubscriptionId,
      stripeSeatItemId: orgSubscriptions.stripeSeatItemId,
      status: orgSubscriptions.status,
      gifted: orgSubscriptions.gifted,
      giftedExtraSeats: orgSubscriptions.giftedExtraSeats,
      extraSeatQuantity: orgSubscriptions.extraSeatQuantity,
      seatRevision: orgSubscriptions.seatRevision,
    })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1);
  return row ? { ...row, gifted: row.gifted === true } : null;
}

async function readOrg(orgId: string, adminUserId: string) {
  const found = await findOrganizationById(orgId);
  return found ? { adminRole: await findMembershipRole(orgId, adminUserId) } : null;
}

export async function giftOrgSubscription(
  input: { orgId: string; adminUserId: string; reason: string; extraSeats: number },
  stripe: OrgGiftStripe,
): Promise<OrgGiftResult> {
  const org = await readOrg(input.orgId, input.adminUserId);
  const result = await db.transaction(async (tx): Promise<OrgGiftResult> => {
    const stored = await lockAndReadStored(tx, input.orgId);
    const plan = planOrgGift({ ...input, billingEnabled: isBillingEnabled(), org, stored });
    if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason };

    // The pin is written first, in this transaction: it commits only with the gift, and the
    // pool refill reads it under this same lock, so a gift invoice never sees a half-applied gift.
    // The gift sets the seat item to the pin, so the stored quantity moves with it (a new
    // revision, so no later seat change reuses a key).
    await tx
      .update(orgSubscriptions)
      .set({
        giftedExtraSeats: plan.giftedExtraSeats,
        ...(stored && stored.extraSeatQuantity !== plan.giftedExtraSeats
          ? { extraSeatQuantity: plan.giftedExtraSeats, seatRevision: stored.seatRevision + 1 }
          : {}),
      })
      .where(eq(orgSubscriptions.orgId, input.orgId));

    // A lapsed org's failed renewal must not keep retrying a charge on the gifted period.
    const voidedInvoiceIds = await stripe.listOpenInvoiceIds(plan.subscriptionId);
    for (const invoiceId of voidedInvoiceIds) await stripe.voidInvoice(invoiceId, orgGiftVoidKey(input.orgId, invoiceId));

    const coupon = (await stripe.retrieveCoupon(plan.coupon.id)) ?? (await stripe.createCoupon(plan.coupon, plan.couponKey));
    const sub = await stripe.updateSubscription(plan.subscriptionId, plan.update, plan.updateKey);
    return {
      kind: 'gifted',
      subscriptionId: sub.id,
      couponId: coupon.id,
      status: sub.status,
      restoresNow: plan.restoresNow,
      giftedExtraSeats: plan.giftedExtraSeats,
      voidedInvoiceIds,
    };
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
    details: {
      source: 'admin_gift',
      stripeSubscriptionId: result.subscriptionId,
      couponId: result.couponId,
      restoresNow: result.restoresNow,
      giftedExtraSeats: result.giftedExtraSeats,
      voidedInvoiceIds: result.voidedInvoiceIds,
    },
  });
  return result;
}

/**
 * Revoke an admin gift: the coupon and gift metadata come off the org's own subscription with
 * no proration, so the org pays from its next renewal; the pin is cleared and the seat item is
 * re-synced to the seats the org actually holds, so it is never billed for gifted seats nobody
 * holds.
 */
export async function ungiftOrgSubscription(
  input: { orgId: string; adminUserId: string; reason: string },
  stripe: OrgGiftStripe,
): Promise<OrgUngiftResult> {
  const org = await readOrg(input.orgId, input.adminUserId);
  const result = await db.transaction(async (tx): Promise<OrgUngiftResult> => {
    const stored = await lockAndReadStored(tx, input.orgId);
    const plan = planOrgUngift({ ...input, billingEnabled: isBillingEnabled(), org, stored });
    if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason };
    await tx
      .update(orgSubscriptions)
      .set({ giftedExtraSeats: null, gifted: false })
      .where(eq(orgSubscriptions.orgId, input.orgId));
    const sub = await stripe.updateSubscription(plan.subscriptionId, plan.update, plan.updateKey);

    // The gift held the seat item at its pin; with the pin gone it returns to the seats the
    // org actually holds (members + live invites), with no proration — the period was gifted.
    // Counted under this same lock, so no invite or removal races it.
    const s = stored as StoredGiftRow;
    const { held } = seatQuantity({ ...(await countOrgSeatParts(input.orgId, tx)), included: TIER_PLAN_LIMITS.business.includedSeats });
    const sync = planSeatQuantitySync({
      orgId: input.orgId,
      stored: { seatItemId: s.stripeSeatItemId, extraSeatQuantity: s.extraSeatQuantity, seatRevision: s.seatRevision },
      seats: held,
      prorationBehavior: 'none',
    });
    let extraSeatQuantity = orgExtraSeatQuantity(held);
    if (sync.kind === 'update') {
      const item = await stripe.setSeatQuantity({ itemId: sync.itemId, quantity: sync.quantity, prorationBehavior: 'none' }, sync.idempotencyKey);
      extraSeatQuantity = item.quantity;
      await tx
        .update(orgSubscriptions)
        .set({ extraSeatQuantity: item.quantity, seatRevision: sync.nextRevision })
        .where(eq(orgSubscriptions.orgId, input.orgId));
    }
    return { kind: 'ungifted', subscriptionId: sub.id, status: sub.status, extraSeatQuantity };
  });

  if (result.kind === 'refused') {
    loggers.api.info('admin org ungift refused', { orgId: input.orgId, adminUserId: input.adminUserId, reason: result.reason });
    return result;
  }
  loggers.api.info('admin revoked org gift', { orgId: input.orgId, adminUserId: input.adminUserId, ...result });
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: 'org.billing.subscription_changed',
    actorId: input.adminUserId,
    resourceType: 'org_subscription',
    resourceId: input.orgId,
    details: { source: 'admin_ungift', stripeSubscriptionId: result.subscriptionId, extraSeatQuantity: result.extraSeatQuantity },
  });
  return result;
}
