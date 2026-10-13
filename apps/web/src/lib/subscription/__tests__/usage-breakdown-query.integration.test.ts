/**
 * The personal usage breakdown against a real Postgres (Spec WAL-9): it is the person's OWN
 * credits, so an org drive's compute — charged to the org pool, recorded under the person who
 * ran it — never appears in it, while what their own wallet paid does.
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { ensureTestDb } from '@/test/ensure-test-db';
import { getUserUsageBreakdown } from '../usage-breakdown-query';

const created: { userIds: string[]; orgIds: string[] } = { userIds: [], orgIds: [] };

beforeAll(ensureTestDb);

afterEach(async () => {
  await db.delete(creditLedger).where(inArray(creditLedger.userId, created.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, created.userIds));
  await db.delete(wallets).where(inArray(wallets.userId, created.userIds));
  if (created.orgIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.orgIds = [];
});

/** One settled usage row of `cents` on `walletId`, recorded under `userId`. */
async function usage(userId: string, walletId: string, cents: number, source: 'terminal' | 'chat') {
  const [log] = await db.insert(aiUsageLogs).values({
    id: createId(), userId, provider: 'sprites', model: 'sandbox', cost: cents / 150, source, timestamp: new Date(),
  }).returning();
  await db.insert(creditLedger).values({
    userId, walletId, entryType: 'usage', bucket: 'monthly', amountCents: -cents, chargeMillicents: cents * 1000, aiUsageLogId: log.id, consumeStatus: 'applied',
  });
}

describe('the personal usage breakdown is the person\'s own credits', () => {
  it('WAL-9 an org drive\'s compute, charged to the org pool under the member who ran it, is not in their personal breakdown; what their own wallet paid is', async () => {
    const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'pro' });
    created.userIds.push(marcus.id);
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: marcus.id }).returning();
    created.orgIds.push(org.id);
    const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 10_000 }).returning();
    const [own] = await db.insert(wallets).values({
      userId: marcus.id,
      monthlyRemainingCents: 5_000,
      monthlyAllowanceCents: 5_000,
      monthlyPeriodStart: new Date(Date.now() - 86_400_000),
      monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    }).returning();

    await usage(marcus.id, pool.id, 900, 'terminal');
    await usage(marcus.id, own.id, 40, 'chat');

    const breakdown = await getUserUsageBreakdown(marcus.id, 'pro');

    expect(breakdown.totalSpendCents).toBe(40);
    expect(breakdown.byFeature.map((f) => f.source)).toEqual(['chat']);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, pool.id))).toHaveLength(1);
  });
});
