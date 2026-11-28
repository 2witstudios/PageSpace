// @vitest-environment node
/**
 * The org storage add-on shell against a REAL Postgres (the org billing lock, the status read
 * and the org_subscriptions mirror), with Stripe replaced by a tiny in-memory subscription.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children first, users last.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => {
  const fake = {
    periodEnd: 0,
    items: [] as Array<{ id: string; price: { id: string }; quantity: number; current_period_end: number }>,
    declineNextCharge: false,
    nextItem: 1,
  };
  return { fake };
});

vi.mock('@/lib/stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro' },
    orgPriceIds: { businessBase: 'price_base', extraSeat: 'price_seat' },
    storageAddonPriceId: 'price_storage',
    portalConfigurationIds: { personal: 'bpc_p', organization: 'bpc_o' },
  },
}));

vi.mock('@/lib/stripe', () => {
  class StripeCardError extends Error {
    type = 'StripeCardError';
  }
  const charge = (prorationBehavior: string) => {
    if (prorationBehavior === 'always_invoice' && fake.declineNextCharge) {
      fake.declineNextCharge = false;
      throw new StripeCardError('Your card was declined.');
    }
  };
  return {
    stripe: {
      subscriptions: {
        retrieve: async (id: string) => ({
          id,
          customer: 'cus_org',
          status: 'active',
          collection_method: 'charge_automatically',
          created: 0,
          metadata: {},
          cancel_at_period_end: false,
          items: { has_more: false, data: fake.items.map((i) => ({ ...i })) },
        }),
      },
      subscriptionItems: {
        create: async (params: { price: string; quantity: number; proration_behavior: string }) => {
          charge(params.proration_behavior);
          const item = { id: `si_storage_${fake.nextItem++}`, price: { id: params.price }, quantity: params.quantity, current_period_end: fake.periodEnd };
          fake.items.push(item);
          return item;
        },
        update: async (id: string, params: { quantity: number; proration_behavior: string }) => {
          charge(params.proration_behavior);
          const item = fake.items.find((i) => i.id === id);
          if (!item) throw new Error('no such item');
          item.quantity = params.quantity;
          return item;
        },
      },
    },
    Stripe: { errors: { StripeError: Error } },
  };
});

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptionFunding, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { getOrgStorageSummary, setOrgStorageBlocks } from '../storage-billing';

const GB = 1024 ** 3;
let dbAvailable = false;
const orgIds: string[] = [];
const userIds: string[] = [];

async function activeOrg(opts: { gifted?: boolean; funded?: boolean } = {}): Promise<string> {
  const owner = await factories.createUser({ email: `owner+${Date.now()}${Math.random().toString(36).slice(2, 8)}@storage.test`, name: 'Owner' });
  userIds.push(owner.id);
  const created = await createOrganization({ name: 'Storage Co', slug: `storage-${Math.random().toString(36).slice(2, 10)}`, ownerId: owner.id });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  const orgId = created.organization.id;
  orgIds.push(orgId);
  const subscriptionId = `sub_${orgId}`;
  await db.insert(orgSubscriptions).values({
    orgId,
    stripeSubscriptionId: subscriptionId,
    stripeBasePriceId: 'price_base',
    stripeBaseItemId: 'si_base',
    stripeSeatPriceId: 'price_seat',
    stripeSeatItemId: 'si_seat',
    status: 'active',
    gifted: opts.gifted ?? false,
    currentPeriodEnd: new Date(fake.periodEnd * 1000),
  });
  if (opts.funded !== false) {
    await db.insert(orgSubscriptionFunding).values({ orgId, stripeSubscriptionId: subscriptionId, stripeInvoiceId: `in_${orgId}`, basis: 'paid', paidCents: 5000 });
  }
  return orgId;
}

async function rowFor(orgId: string) {
  const [row] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
  return row;
}

describe('org storage add-on (real Postgres, in-memory Stripe)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('storage-billing.integration.test.ts', error);
    }
  });

  beforeEach(() => {
    fake.periodEnd = Math.floor(Date.now() / 1000) + 20 * 86_400;
    fake.items = [
      { id: 'si_base', price: { id: 'price_base' }, quantity: 1, current_period_end: fake.periodEnd },
      { id: 'si_seat', price: { id: 'price_seat' }, quantity: 0, current_period_end: fake.periodEnd },
    ];
    fake.declineNextCharge = false;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    if (orgIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.orgId, orgIds));
      await db.delete(orgSubscriptionFunding).where(inArray(orgSubscriptionFunding.orgId, orgIds));
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('given an active org, buying 2 blocks should add a storage item, mirror it, and raise the org quota by 100GB', async () => {
    if (!dbAvailable) return;
    const orgId = await activeOrg();
    const before = await getOrgStorageSummary(orgId);
    expect(before).toMatchObject({ available: true, blocks: 0, quotaBytes: 50 * GB });

    const outcome = await setOrgStorageBlocks(orgId, 2);
    expect(outcome).toMatchObject({ kind: 'done', result: { kind: 'applied', charged: true } });
    expect(fake.items.find((i) => i.price.id === 'price_storage')?.quantity).toBe(2);
    expect(await rowFor(orgId)).toMatchObject({ storageBlocks: 2, storageRevision: 1 });
    expect((await getOrgStorageSummary(orgId)).quotaBytes).toBe(150 * GB);
  });

  it('given blocks removed mid-period, the paid blocks should stay in the quota until period end', async () => {
    if (!dbAvailable) return;
    const orgId = await activeOrg();
    await setOrgStorageBlocks(orgId, 3);
    await setOrgStorageBlocks(orgId, 1);
    expect(fake.items.find((i) => i.price.id === 'price_storage')?.quantity).toBe(1);
    const summary = await getOrgStorageSummary(orgId);
    expect(summary).toMatchObject({ blocks: 1, entitledBlocks: 3, quotaBytes: 200 * GB });
    expect(summary.graceUntil).toBe(new Date(fake.periodEnd * 1000).toISOString());
  });

  it('given a declined card, nothing should change in Stripe or the mirror', async () => {
    if (!dbAvailable) return;
    const orgId = await activeOrg();
    fake.declineNextCharge = true;
    const outcome = await setOrgStorageBlocks(orgId, 2);
    expect(outcome).toMatchObject({ kind: 'done', result: { kind: 'failed' } });
    expect(fake.items.some((i) => i.price.id === 'price_storage')).toBe(false);
    expect(await rowFor(orgId)).toMatchObject({ storageBlocks: 0, storageRevision: 0 });
  });

  it('given a lapsed (never funded) org, the change should be refused', async () => {
    if (!dbAvailable) return;
    const orgId = await activeOrg({ funded: false });
    expect(await setOrgStorageBlocks(orgId, 1)).toEqual({ kind: 'lapsed' });
    expect((await getOrgStorageSummary(orgId)).unavailableReason).toBe('lapsed');
  });

  it('given a gifted org, the change should be refused', async () => {
    if (!dbAvailable) return;
    const orgId = await activeOrg({ gifted: true });
    expect(await setOrgStorageBlocks(orgId, 1)).toEqual({ kind: 'gifted' });
  });
});
