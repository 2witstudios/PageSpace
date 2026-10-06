/**
 * The seat-caps read model against a real Postgres (WAL-7 caps per seat, D-OW-38 "seat allowance
 * remaining"; UI-7 Members & seats). Northwind's pool; the seat allowance policy is 150 credits a
 * month. Marcus has a 50-credit daily cap and no monthly cap of his own, has spent 96 credits this
 * period (one call today) and has a 10-credit hold in flight; Lena has caps 20 a day and 100 a
 * month and has spent nothing; Jono has no cap row.
 *
 * Requires DATABASE_URL; deletes every row it creates, users last, and ends the pool.
 */
import { assert, describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { listMyWallets, listOrgSeatCaps } from '../drive-wallet-service';
import { loadSeatCapFacts, loadSeatCapFactsForUsers } from '../../billing/seat-allowance';
import { listSpendChoices } from '../../billing/spend-resolution';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// Reachability is settled before collection, so a DB-less run skips the suite (requireDb throws unless opted out).
const ok = await db.select({ id: wallets.id }).from(wallets).limit(1).then(
  () => true,
  (error: unknown) => {
    requireDb('org-seat-caps.integration.test.ts', error);
    return false;
  },
);
const w = { orgId: '', poolId: '', jono: '', marcus: '', lena: '', userIds: [] as string[], emptyOrgId: '', driveId: '' };

describe.skipIf(!ok)('org seat caps read model (real Postgres)', () => {
  beforeAll(async () => {
    const jono = await factories.createUser({ name: 'Jono Woodall' });
    const marcus = await factories.createUser({ name: 'Marcus Oyelaran' });
    const lena = await factories.createUser({ name: 'Lena Schulz' });
    Object.assign(w, { jono: jono.id, marcus: marcus.id, lena: lena.id, userIds: [jono.id, marcus.id, lena.id] });
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `nw-${createId()}`, ownerId: jono.id, policies: { seatAllowanceCents: 150 } }).returning();
    w.orgId = org.id;
    await factories.createOrgSubscription(org.id);
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: jono.id, role: 'OWNER' },
      { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
      { orgId: org.id, userId: lena.id, role: 'MEMBER' },
    ]);
    const [poolWallet] = await db.insert(wallets).values({
      ownerType: 'org', orgId: org.id, monthlyRemainingCents: 9_000,
      monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    }).returning();
    w.poolId = poolWallet.id;
    await db.insert(walletConsumerCaps).values([
      { walletId: poolWallet.id, consumerKey: `user:${marcus.id}`, dailyCapCents: 50, monthlyCapCents: null },
      { walletId: poolWallet.id, consumerKey: `user:${lena.id}`, dailyCapCents: 20, monthlyCapCents: 100 },
    ]);
    await db.insert(creditLedger).values({
      userId: marcus.id, walletId: poolWallet.id, entryType: 'usage', bucket: 'monthly', amountCents: -96, chargeMillicents: 96_000, consumeStatus: 'applied', spendKind: 'ai',
    });
    await db.insert(creditHolds).values({ userId: marcus.id, walletId: poolWallet.id, estCents: 10, spendKind: 'ai', expiresAt: new Date(Date.now() + 3_600_000) });
    const product = await factories.createDrive(jono.id, { name: 'Product', slug: `p-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    w.driveId = product.id;
    await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
    const [empty] = await db.insert(organizations).values({ name: 'No Pool', slug: `np-${createId()}`, ownerId: jono.id }).returning();
    w.emptyOrgId = empty.id;
    await db.insert(orgMembers).values({ orgId: empty.id, userId: jono.id, role: 'OWNER' });
  });

  afterAll(async () => {
    await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
    await db.delete(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolId));
    await db.delete(driveMembers).where(eq(driveMembers.driveId, w.driveId));
    await db.delete(drives).where(eq(drives.id, w.driveId));
    await db.delete(wallets).where(eq(wallets.id, w.poolId));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, [w.orgId, w.emptyOrgId]));
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
    await db.delete(organizations).where(inArray(organizations.id, [w.orgId, w.emptyOrgId]));
    await db.delete(users).where(inArray(users.id, w.userIds));
    await pool.end();
  });

  it('UI-7 (partial) WAL-7 (partial): each member\'s caps, the monthly limit in force (a seat with no monthly cap draws the allowance, never unlimited), and what is left', async () => {
    const read = await listOrgSeatCaps(w.orgId);
    expect(read.walletId).toBe(w.poolId);
    expect(read.seatAllowanceCents).toBe(150);
    const byUser = Object.fromEntries(read.seats.map((s) => [s.userId, s]));
    // Marcus: 150 allowance − 96 spent − 10 held = 44 left this month; 50 − 96 − 10 → 0 left today.
    expect(byUser[w.marcus]).toEqual({
      userId: w.marcus, displayName: 'Marcus Oyelaran',
      dailyCapCents: 50, monthlyCapCents: null, monthlyLimitCents: 150, monthlyRemainingCents: 44, dailyRemainingCents: 0,
    });
    expect(byUser[w.lena]).toEqual({
      userId: w.lena, displayName: 'Lena Schulz',
      dailyCapCents: 20, monthlyCapCents: 100, monthlyLimitCents: 100, monthlyRemainingCents: 100, dailyRemainingCents: 20,
    });
    expect(byUser[w.jono]).toEqual({
      userId: w.jono, displayName: 'Jono Woodall',
      dailyCapCents: null, monthlyCapCents: null, monthlyLimitCents: 150, monthlyRemainingCents: 150, dailyRemainingCents: null,
    });
  });

  it('WAL-7 (partial): the list agrees with the gate: Marcus\'s seat choice remaining is the smaller of his monthly and daily remaining', async () => {
    const read = await listOrgSeatCaps(w.orgId);
    const mine = read.seats.find((s) => s.userId === w.marcus);
    const choices = await listSpendChoices(w.marcus, w.driveId);
    const seat = choices.find((c) => c.source === 'seat_allowance');
    assert(mine && seat, JSON.stringify({ mine, choices }));
    const caps = [mine.monthlyRemainingCents, mine.dailyRemainingCents].filter((n): n is number => n !== null);
    expect(seat.remainingCents).toBe(Math.min(...caps));
  });

  it('WAL-7 (partial): the seat-caps route and GET /api/wallets give every member the same seat remaining (one computation, seatAllowancesFor)', async () => {
    const read = await listOrgSeatCaps(w.orgId);
    for (const userId of w.userIds) {
      const row = read.seats.find((s) => s.userId === userId);
      const mine = (await listMyWallets(userId, 'session')).seats.find((s) => s.orgId === w.orgId);
      assert(row && mine, JSON.stringify({ userId, row, mine }));
      expect(mine.allowanceCents).toBe(row.monthlyLimitCents);
      expect(mine.remainingCents).toBe(Math.min(row.monthlyRemainingCents, row.dailyRemainingCents ?? row.monthlyRemainingCents));
    }
  });

  it('the batched seat facts (one read for every member) equal the gate\'s one-member read for each', async () => {
    const [poolRow] = await db.select({ start: wallets.monthlyPeriodStart }).from(wallets).where(eq(wallets.id, w.poolId));
    const input = { poolId: w.poolId, poolPeriodStart: poolRow.start, policySeatAllowanceCents: 150, now: new Date() };
    const batch = await loadSeatCapFactsForUsers(db, { ...input, userIds: [...w.userIds, w.marcus] });
    expect([...batch.keys()].sort()).toEqual([...w.userIds].sort());
    for (const userId of w.userIds) {
      expect(batch.get(userId)).toEqual(await loadSeatCapFacts(db, { ...input, userId }));
    }
    expect((await loadSeatCapFactsForUsers(db, { ...input, userIds: [] })).size).toBe(0);
  });

  it('an org with no pool yet has no seat figures to show', async () => {
    expect(await listOrgSeatCaps(w.emptyOrgId)).toEqual({ walletId: null, seatAllowanceCents: 100, seats: [] });
  });
});
