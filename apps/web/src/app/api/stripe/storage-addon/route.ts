import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and, inArray, desc } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe } from '@/lib/stripe';
import { isStorageAddonConfigured, personalPlanItems } from '@/lib/stripe/price-config';
import { randomUUID } from 'crypto';
import { classifyStorageAddonFailure, stripeStorageAddonPort } from '@/lib/stripe/storage-addon-billing';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { toPersonalSubscriptionTier, STORAGE_ADDON } from '@pagespace/lib/billing/subscription-tiers';
import {
  applyStorageAddonChange,
  entitledStorageBlocks,
  isValidStorageBlockCount,
  storageAddonMonthlyCents,
  type StoredStorageAddon,
} from '@pagespace/lib/billing/storage-addon';

const READ_AUTH = { allow: ['session'] as const, requireCSRF: false };
const WRITE_AUTH = { allow: ['session'] as const, requireCSRF: true };

/** Statuses on which blocks can be bought or removed: past_due must settle first. */
const CHANGEABLE_STATUSES = ['active', 'trialing'];

async function findLiveSubscription(userId: string) {
  const [row] = await db.select()
    .from(subscriptions)
    .where(and(
      eq(subscriptions.userId, userId),
      inArray(subscriptions.status, ['active', 'trialing', 'past_due']),
    ))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  return row;
}

function storedOf(row: typeof subscriptions.$inferSelect): StoredStorageAddon {
  return {
    itemId: row.stripeStorageItemId,
    blocks: row.storageBlocks,
    graceBlocks: row.storageGraceBlocks,
    graceUntil: row.storageGraceUntil,
    revision: row.storageRevision,
  };
}

/**
 * GET /api/stripe/storage-addon
 * The person's storage add-on: whether they can buy it, what they hold, and the price.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, READ_AUTH);
    if (isAuthError(auth)) return auth.error;

    const [user] = await db.select({ subscriptionTier: users.subscriptionTier }).from(users).where(eq(users.id, auth.userId));
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const row = await findLiveSubscription(auth.userId);
    const tier = toPersonalSubscriptionTier(user.subscriptionTier);
    const stored = row ? storedOf(row) : null;
    const now = new Date();
    // A gifted plan carries a subscription-wide 100% coupon that would also zero out
    // storage, so gifted plans cannot buy blocks.
    const available = isBillingEnabled() && isStorageAddonConfigured() && tier === 'pro'
      && !!row && CHANGEABLE_STATUSES.includes(row.status) && !row.gifted;

    return NextResponse.json({
      available,
      tier,
      gifted: row?.gifted ?? false,
      blocks: stored?.blocks ?? 0,
      entitledBlocks: stored ? entitledStorageBlocks(stored, now) : 0,
      graceUntil: stored && entitledStorageBlocks(stored, now) > stored.blocks ? stored.graceUntil?.toISOString() ?? null : null,
      currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
      blockBytes: STORAGE_ADDON.blockBytes,
      maxBlocks: STORAGE_ADDON.maxBlocks,
      blockPriceCents: storageAddonMonthlyCents(1),
    });
  } catch (error) {
    loggers.api.error('Error reading storage add-on', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to read storage add-on' }, { status: 500 });
  }
}

/**
 * POST /api/stripe/storage-addon  { blocks }
 * Set the number of storage blocks on the person's Pro subscription. An increase is
 * charged now (prorated); a decrease takes effect at period end with no refund.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, WRITE_AUTH);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    if (!isBillingEnabled()) return NextResponse.json({ error: 'Not available' }, { status: 404 });
    if (!isStorageAddonConfigured()) {
      return NextResponse.json({ error: 'Extra storage is not available yet' }, { status: 503 });
    }

    const body = await request.json().catch(() => null) as { blocks?: unknown } | null;
    const target = body?.blocks;
    if (!isValidStorageBlockCount(target)) {
      return NextResponse.json({ error: `blocks must be a whole number from 0 to ${STORAGE_ADDON.maxBlocks}` }, { status: 400 });
    }

    const [user] = await db.select({ subscriptionTier: users.subscriptionTier }).from(users).where(eq(users.id, userId));
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (toPersonalSubscriptionTier(user.subscriptionTier) !== 'pro') {
      return NextResponse.json({ error: 'Extra storage requires the Pro plan' }, { status: 403 });
    }

    const live = await findLiveSubscription(userId);
    if (!live) return NextResponse.json({ error: 'No active subscription found' }, { status: 400 });
    if (!CHANGEABLE_STATUSES.includes(live.status)) {
      return NextResponse.json({ error: 'Update your payment method before changing storage' }, { status: 402 });
    }
    // A gift's subscription-wide 100% coupon would make every block free.
    if (live.gifted) {
      return NextResponse.json({ error: 'Extra storage is not available on a gifted plan. Contact support.' }, { status: 403 });
    }

    // Set once Stripe has accepted the change, so a failed mirror write below is logged
    // with everything needed to reconcile it (Stripe writes cannot roll back).
    let appliedInStripe: { blocks: number; graceBlocks: number; graceUntil: Date | null; revision: number; itemId: string | null } | null = null;
    const attemptId = randomUUID();
    const outcome = await db.transaction(async (tx) => {
      // Serialize changes per subscription: the plan reads the stored revision and grace.
      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, live.id)).for('update');
      if (!row) return { kind: 'missing' as const };

      const subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId, { expand: ['items'] });
      const items = personalPlanItems(subscription.items);
      if (!items || !CHANGEABLE_STATUSES.includes(subscription.status)) return { kind: 'unrecognized' as const };
      const periodEndTs = (items.planItem as { current_period_end?: number }).current_period_end;
      if (!periodEndTs) return { kind: 'unrecognized' as const };

      // Stripe's live item is the current quantity; the mirror supplies grace and revision.
      const stored: StoredStorageAddon = {
        ...storedOf(row),
        itemId: items.storageItem?.id ?? null,
        blocks: items.storageItem?.quantity ?? 0,
      };
      const result = await applyStorageAddonChange({
        payer: { kind: 'user', id: userId },
        stored,
        target,
        periodEnd: new Date(periodEndTs * 1000),
        now: new Date(),
        attemptId,
        port: stripeStorageAddonPort(stripe, subscription.id),
      });
      if (result.kind === 'applied') {
        appliedInStripe = result.stored;
        await tx.update(subscriptions)
          .set({
            stripeStorageItemId: result.stored.itemId,
            storageBlocks: result.stored.blocks,
            storageGraceBlocks: result.stored.graceBlocks,
            storageGraceUntil: result.stored.graceUntil,
            storageRevision: result.stored.revision,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, row.id));
      }
      return { kind: 'result' as const, result, before: stored.blocks, subscriptionId: subscription.id };
    }).catch((error: unknown) => {
      if (appliedInStripe) {
        loggers.api.error('Storage add-on applied in Stripe but the subscription mirror was not saved; reconcile it', error instanceof Error ? error : undefined, {
          userId, subscriptionRowId: live.id, applied: appliedInStripe,
        });
      }
      throw error;
    });

    if (outcome.kind === 'missing') return NextResponse.json({ error: 'No active subscription found' }, { status: 400 });
    if (outcome.kind === 'unrecognized') {
      return NextResponse.json({ error: 'Your subscription cannot be changed here. Contact support.' }, { status: 409 });
    }
    const { result } = outcome;
    if (result.kind === 'invalid') {
      return NextResponse.json({ error: `blocks must be a whole number from 0 to ${STORAGE_ADDON.maxBlocks}` }, { status: 400 });
    }
    if (result.kind === 'failed') {
      if (result.unresolved) {
        loggers.api.error('Storage add-on change failed and its rollback failed; Stripe item differs from the mirror, reconcile it', result.unresolved.rollbackError instanceof Error ? result.unresolved.rollbackError : undefined, {
          userId, itemId: result.unresolved.itemId, stripeQuantity: result.unresolved.quantity, mirrorBlocks: outcome.before,
        });
      }
      const failure = classifyStorageAddonFailure(result.error);
      loggers.api.warn('Storage add-on change refused', { userId, target, declined: failure.declined, error: result.error instanceof Error ? result.error.message : String(result.error) });
      return NextResponse.json({ error: failure.message }, { status: failure.declined ? 402 : 502 });
    }

    if (result.kind === 'applied') {
      auditRequest(request, {
        eventType: 'data.write',
        userId,
        resourceType: 'subscription',
        resourceId: outcome.subscriptionId,
        details: { action: 'storage_addon', from: outcome.before, to: result.stored.blocks, charged: result.charged },
      });
    }

    const now = new Date();
    return NextResponse.json({
      blocks: result.stored.blocks,
      entitledBlocks: entitledStorageBlocks(result.stored, now),
      graceUntil: entitledStorageBlocks(result.stored, now) > result.stored.blocks ? result.stored.graceUntil?.toISOString() ?? null : null,
      charged: result.kind === 'applied' ? result.charged : false,
    });
  } catch (error) {
    loggers.api.error('Error changing storage add-on', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to change storage' }, { status: 500 });
  }
}
