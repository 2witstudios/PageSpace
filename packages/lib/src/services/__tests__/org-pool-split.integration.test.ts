/**
 * The pool split read model against a real Postgres (D-OW-38 "pool split"; UI-7 Plan & seats; SPEND-10:
 * Org Admins see every wallet, the pool and the unallocated balance). Northwind's pool holds 4,500
 * credits this period; Product's wallet has 1,200 allocated and 1,008 spent; Engineering's 900 allocated
 * and 1,233 spent (over, with debt); Finance has no wallet. Two members drew 115 credits from their seats.
 *
 * Requires DATABASE_URL; deletes every row it creates, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { getOrgPoolSplit } from '../drive-wallet-service';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

let ok = false;
const w = { orgId: '', emptyOrgId: '', poolId: '', wallets: [] as string[], drives: [] as string[], userIds: [] as string[], product: '', eng: '', fin: '' };
const periodEnd = new Date(Date.now() + 20 * 86_400_000);

describe('org pool split read model (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      ok = true;
    } catch (error) {
      requireDb('org-pool-split.integration.test.ts', error);
      return;
    }
    const jono = await factories.createUser({ name: 'Jono' });
    const marcus = await factories.createUser({ name: 'Marcus' });
    w.userIds = [jono.id, marcus.id];
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `nw-${createId()}`, ownerId: jono.id, policies: { seatAllowanceCents: 150 } }).returning();
    w.orgId = org.id;
    await factories.createOrgSubscription(org.id);
    await db.insert(orgMembers).values([{ orgId: org.id, userId: jono.id, role: 'OWNER' }, { orgId: org.id, userId: marcus.id, role: 'MEMBER' }]);
    const product = await factories.createDrive(jono.id, { name: 'Product', slug: `p-${createId()}`, orgId: org.id });
    const eng = await factories.createDrive(jono.id, { name: 'Engineering', slug: `e-${createId()}`, orgId: org.id });
    const fin = await factories.createDrive(jono.id, { name: 'Finance', slug: `f-${createId()}`, orgId: org.id });
    Object.assign(w, { product: product.id, eng: eng.id, fin: fin.id, drives: [product.id, eng.id, fin.id] });
    const [poolWallet] = await db.insert(wallets).values({
      ownerType: 'org', orgId: org.id, monthlyRemainingCents: 4_500,
      monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000), monthlyPeriodEnd: periodEnd,
    }).returning();
    w.poolId = poolWallet.id;
    const [pw] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 1_200, spentCents: 1_008 }).returning();
    const [ew] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: eng.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 900, spentCents: 1_233, debtCents: 333 }).returning();
    w.wallets = [pw.id, ew.id];
    await db.insert(creditLedger).values([
      { userId: marcus.id, walletId: poolWallet.id, entryType: 'usage', bucket: 'monthly', amountCents: -96, chargeMillicents: 96_000, consumeStatus: 'applied', spendKind: 'ai' },
      { userId: jono.id, walletId: poolWallet.id, entryType: 'usage', bucket: 'monthly', amountCents: -19, chargeMillicents: 19_000, consumeStatus: 'applied', spendKind: 'ai' },
      // Last period's spend never counts against this one.
      { userId: jono.id, walletId: poolWallet.id, entryType: 'usage', bucket: 'monthly', amountCents: -500, chargeMillicents: 500_000, consumeStatus: 'applied', spendKind: 'ai', createdAt: new Date(Date.now() - 40 * 86_400_000) },
    ]);
    const [empty] = await db.insert(organizations).values({ name: 'Empty', slug: `e-${createId()}`, ownerId: jono.id }).returning();
    w.emptyOrgId = empty.id;
  });

  afterAll(async () => {
    if (ok) {
      await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
      await db.delete(wallets).where(inArray(wallets.id, w.wallets));
      await db.delete(wallets).where(eq(wallets.id, w.poolId));
      await db.delete(drives).where(inArray(drives.id, w.drives));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
      await db.delete(organizations).where(inArray(organizations.id, [w.orgId, w.emptyOrgId]));
      await db.delete(users).where(inArray(users.id, w.userIds));
    }
    await pool.end();
  });

  it('UI-7 (partial) SPEND-10 (partial): the pool, what is unallocated, the seats and every drive wallet, plus drives with none', async () => {
    if (!ok) return;
    const split = await getOrgPoolSplit(w.orgId);
    expect(split).toMatchObject({
      walletId: w.poolId,
      availableCents: 4_500,
      // Product still has 192 of its allocation outstanding; Engineering is spent past its own.
      unallocatedCents: 4_500 - 192,
      periodEnd: periodEnd.toISOString(),
      seats: { memberCount: 2, allowanceCents: 150, spentCents: 115 },
      drivesWithoutWallet: [{ id: w.fin, name: 'Finance' }],
    });
    expect(split.driveWallets).toEqual([
      { driveId: w.eng, driveName: 'Engineering', walletId: w.wallets[1], allocationCents: 900, spentCents: 1_233, status: 'over' },
      { driveId: w.product, driveName: 'Product', walletId: w.wallets[0], allocationCents: 1_200, spentCents: 1_008, status: 'active' },
    ]);
  });

  it('an org with no pool yet reports no pool', async () => {
    if (!ok) return;
    expect(await getOrgPoolSplit(w.emptyOrgId)).toEqual({ walletId: null, availableCents: 0, unallocatedCents: 0, periodEnd: null, seats: { memberCount: 0, allowanceCents: 100, spentCents: 0 }, driveWallets: [], drivesWithoutWallet: [] });
  });
});
