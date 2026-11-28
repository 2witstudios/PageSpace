import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { orgSubscriptions } from '@pagespace/db/schema/organizations';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { orgBillingLockKey, orgSubscriptionItems } from '@pagespace/lib/billing/org-subscription-core';
import { getOrgStatus } from '@pagespace/lib/organizations/status';
import { getOrgStorageQuota } from '@pagespace/lib/services/storage-limits';
import { STORAGE_ADDON } from '@pagespace/lib/billing/subscription-tiers';
import {
  applyStorageAddonChange,
  entitledStorageBlocks,
  storageAddonMonthlyCents,
  type StorageAddonApplyResult,
  type StoredStorageAddon,
} from '@pagespace/lib/billing/storage-addon';
import { stripe as appStripe } from '@/lib/stripe';
import { stripeConfig } from '@/lib/stripe-config';
import { stripeStorageAddonPort } from '@/lib/stripe/storage-addon-billing';
import { stripeOrgBilling } from './org-subscription';
import { randomUUID } from 'crypto';
import { loggers } from '@pagespace/lib/logging/logger-config';

type OrgSubscriptionRow = typeof orgSubscriptions.$inferSelect;

function storedOf(row: OrgSubscriptionRow): StoredStorageAddon {
  return {
    itemId: row.stripeStorageItemId,
    blocks: row.storageBlocks,
    graceBlocks: row.storageGraceBlocks,
    graceUntil: row.storageGraceUntil,
    revision: row.storageRevision,
  };
}

function orgStoragePrices() {
  return {
    basePriceId: stripeConfig.orgPriceIds.businessBase,
    seatPriceId: stripeConfig.orgPriceIds.extraSeat,
    storagePriceId: stripeConfig.storageAddonPriceId,
  };
}

export interface OrgStorageSummary {
  /** Whether the Owner can change the org's storage blocks right now. */
  available: boolean;
  /** Why it cannot, when it cannot. */
  unavailableReason: 'not_configured' | 'no_subscription' | 'lapsed' | 'gifted' | null;
  blocks: number;
  entitledBlocks: number;
  graceUntil: string | null;
  currentPeriodEnd: string | null;
  usedBytes: number;
  quotaBytes: number;
  blockBytes: number;
  maxBlocks: number;
  blockPriceCents: number;
}

/** The org's storage use and add-on, as Owner and Admins see it (no Stripe ids). */
export async function getOrgStorageSummary(orgId: string): Promise<OrgStorageSummary> {
  const [row] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
  const [quota, status] = await Promise.all([getOrgStorageQuota(orgId), getOrgStatus(orgId)]);
  const stored = row ? storedOf(row) : null;
  const now = new Date();
  const entitled = stored ? entitledStorageBlocks(stored, now) : 0;
  const unavailableReason: OrgStorageSummary['unavailableReason'] = !stripeConfig.storageAddonPriceId
    ? 'not_configured'
    : !row
      ? 'no_subscription'
      : status.status !== 'active'
        ? 'lapsed'
        : row.gifted
          ? 'gifted'
          : null;
  return {
    available: isBillingEnabled() && unavailableReason === null,
    unavailableReason,
    blocks: stored?.blocks ?? 0,
    entitledBlocks: entitled,
    graceUntil: stored && entitled > stored.blocks ? stored.graceUntil?.toISOString() ?? null : null,
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    usedBytes: quota.usedBytes,
    quotaBytes: quota.quotaBytes,
    blockBytes: STORAGE_ADDON.blockBytes,
    maxBlocks: STORAGE_ADDON.maxBlocks,
    blockPriceCents: storageAddonMonthlyCents(1),
  };
}

export type SetOrgStorageResult =
  | { kind: 'not_configured' }
  | { kind: 'no_subscription' }
  | { kind: 'lapsed' }
  | { kind: 'gifted' }
  | { kind: 'unrecognized' }
  | { kind: 'done'; before: number; result: StorageAddonApplyResult };

/**
 * Set the org's storage blocks (Owner only; the route checks the role). Runs under the org's
 * billing lock, like every other billing step, so it never races a seat change or the mirror.
 * Stripe's live storage item is the current quantity; the row supplies grace and revision.
 */
export async function setOrgStorageBlocks(orgId: string, target: number): Promise<SetOrgStorageResult> {
  if (!stripeConfig.storageAddonPriceId) return { kind: 'not_configured' };
  // Set once Stripe has accepted the change: Stripe writes cannot roll back, so a failed
  // mirror write is logged with everything needed to reconcile it.
  let appliedInStripe: StoredStorageAddon | null = null;
  const attemptId = randomUUID();
  return db.transaction(async (tx): Promise<SetOrgStorageResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgBillingLockKey(orgId)}, 0))`);
    const [row] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
    if (!row) return { kind: 'no_subscription' };
    // SEAT-9: a lapsed org cannot add spend; a gift's 100% coupon would make every block free.
    if ((await getOrgStatus(orgId, { executor: tx })).status !== 'active') return { kind: 'lapsed' };
    if (row.gifted) return { kind: 'gifted' };

    const subscription = await stripeOrgBilling(appStripe).retrieveSubscription(row.stripeSubscriptionId);
    const linkage = orgSubscriptionItems(subscription, orgStoragePrices());
    if (!linkage || subscription.status !== 'active' || subscription.currentPeriodEnd === null) return { kind: 'unrecognized' };

    const stored: StoredStorageAddon = {
      ...storedOf(row),
      itemId: linkage.storageItem?.id ?? null,
      blocks: linkage.storageItem?.quantity ?? 0,
    };
    const result = await applyStorageAddonChange({
      payer: { kind: 'org', id: orgId },
      stored,
      target,
      periodEnd: new Date(subscription.currentPeriodEnd * 1000),
      now: new Date(),
      attemptId,
      port: stripeStorageAddonPort(appStripe, subscription.id),
    });
    if (result.kind === 'applied') {
      appliedInStripe = result.stored;
      await tx.update(orgSubscriptions)
        .set({
          stripeStorageItemId: result.stored.itemId,
          storageBlocks: result.stored.blocks,
          storageGraceBlocks: result.stored.graceBlocks,
          storageGraceUntil: result.stored.graceUntil,
          storageRevision: result.stored.revision,
          updatedAt: new Date(),
        })
        .where(eq(orgSubscriptions.id, row.id));
    }
    return { kind: 'done', before: stored.blocks, result };
  }).catch((error: unknown) => {
    if (appliedInStripe) {
      loggers.api.error('Org storage add-on applied in Stripe but org_subscriptions was not saved; reconcile it', error instanceof Error ? error : undefined, {
        orgId, applied: appliedInStripe,
      });
    }
    throw error;
  });
}
