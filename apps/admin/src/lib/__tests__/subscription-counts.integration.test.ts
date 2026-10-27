import { afterAll, describe, expect, it } from 'vitest';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { getActiveSubscriptionsByTier } from '../monitoring-queries';
import { stripeConfig } from '../stripe-config';

afterAll(() => pool.end());

describe('paid organization subscription counts (real Postgres)', () => {
  it('counts only active, verified, automatically collected non-gift Business subscriptions', async () => {
    const baseline = await getActiveSubscriptionsByTier();
    const owner = await factories.createUser();
    const orgIds: string[] = [];
    try {
      const cases = [
        { status: 'active', gifted: false },
        { status: 'active', gifted: true },
        { status: 'active', gifted: null },
        { status: 'trialing', gifted: false },
        { status: 'past_due', gifted: false },
        { status: 'canceled', gifted: false },
        { status: 'active', gifted: false, funded: false },
        // [D-OW-44]: an invoice-billed subscription reads active before anything is collected.
        { status: 'active', gifted: false, collectionMethod: 'send_invoice' },
      ];
      for (const { funded = true, ...candidate } of cases) {
        const suffix = crypto.randomUUID();
        const [org] = await db.insert(organizations).values({ name: 'Counts fixture', slug: `counts-${suffix}`, ownerId: owner.id }).returning();
        orgIds.push(org.id);
        await db.insert(orgSubscriptions).values({
          orgId: org.id,
          stripeSubscriptionId: `sub_counts_${suffix}`,
          stripeBasePriceId: stripeConfig.orgPriceIds.businessBase,
          stripeBaseItemId: `si_base_${suffix}`,
          stripeSeatPriceId: stripeConfig.orgPriceIds.extraSeat,
          stripeSeatItemId: `si_seat_${suffix}`,
          ...candidate,
        });
        if (funded) await factories.fundOrgSubscription(org.id);
      }
      expect(await getActiveSubscriptionsByTier()).toEqual(baseline.map(row => ({
        ...row, count: row.count + (row.tier === 'business' ? 1 : 0),
      })));
      await db.update(orgSubscriptions).set({ gifted: false }).where(eq(orgSubscriptions.orgId, orgIds[2]));
      expect(await getActiveSubscriptionsByTier()).toEqual(baseline.map(row => ({
        ...row, count: row.count + (row.tier === 'business' ? 2 : 0),
      })));
    } finally {
      if (orgIds.length) {
        await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
        await db.delete(organizations).where(inArray(organizations.id, orgIds));
      }
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
