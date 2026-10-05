/**
 * The seat-caps read model against a real Postgres (WAL-7 caps per seat, D-OW-38 "seat allowance
 * remaining"; UI-7 Members & seats). Northwind's pool; the seat allowance policy is 150 credits a
 * month. Marcus has a 50-credit daily cap and no monthly cap of his own, has spent 96 credits this
 * period (one call today) and has a 10-credit hold in flight; Lena has caps 20 a day and 100 a
 * month and has spent nothing; Jono has no cap row.
 *
 * Requires DATABASE_URL; deletes every row it creates, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { listOrgSeatCaps } from '../drive-wallet-service';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

let ok = false;
const w = { orgId: '', poolId: '', jono: '', marcus: '', lena: '', userIds: [] as string[], emptyOrgId: '' };

describe('org seat caps read model (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      ok = true;
    } catch (error) {
      requireDb('org-seat-caps.integration.test.ts', error);
      return;
    }
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
    const [empty] = await db.insert(organizations).values({ name: 'No Pool', slug: `np-${createId()}`, ownerId: jono.id }).returning();
    w.emptyOrgId = empty.id;
    await db.insert(orgMembers).values({ orgId: empty.id, userId: jono.id, role: 'OWNER' });
  });

  afterAll(async () => {
    if (ok) {
      await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
      await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
      await db.delete(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolId));
      await db.delete(wallets).where(eq(wallets.id, w.poolId));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, [w.orgId, w.emptyOrgId]));
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
      await db.delete(organizations).where(inArray(organizations.id, [w.orgId, w.emptyOrgId]));
      await db.delete(users).where(inArray(users.id, w.userIds));
    }
    await pool.end();
  });

  it('UI-7 (partial) WAL-7 (partial): each member\'s caps, the monthly limit in force (a seat with no monthly cap draws the allowance, never unlimited), and what is left', async () => {
    if (!ok) return;
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

  it('an org with no pool yet has no seat figures to show', async () => {
    if (!ok) return;
    expect(await listOrgSeatCaps(w.emptyOrgId)).toEqual({ walletId: null, seatAllowanceCents: 100, seats: [] });
  });
});
