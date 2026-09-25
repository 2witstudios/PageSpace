/**
 * Proves the lib integration harness is ARMED for the funding-legs invariant (D-OW-13):
 * this file sets no GUC and installs nothing itself, so it only passes when
 * integration-db-teardown.ts did both — a deleted SET or install line fails here instead of
 * silently turning the catch-all off.
 *
 * Integration config only (vitest.integration.config.ts, CI's lib `test:integration` step):
 * the default config runs integration files WITHOUT that setup, so it excludes this file.
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { WALLET_LEG_INVARIANT_GUC } from '../wallet-leg-invariant';

let dbAvailable = false;
const userIds: string[] = [];

describe('the lib integration harness arms the funding-legs invariant', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('wallet-leg-invariant-armed.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable || userIds.length === 0) return;
    await db.delete(wallets).where(inArray(wallets.userId, userIds)).catch(() => undefined);
    await db.delete(wallets).where(inArray(wallets.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('every pool connection carries the GUC, checked on several at once', async () => {
    if (!dbAvailable) return;
    const clients = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
    try {
      const settings = await Promise.all(
        clients.map(async (c) => (await c.query<{ armed: string | null }>(`SELECT current_setting('${WALLET_LEG_INVARIANT_GUC}', true) AS armed`)).rows[0]?.armed),
      );
      expect(settings).toEqual(['on', 'on', 'on', 'on', 'on']);
    } finally {
      for (const c of clients) c.release();
    }
  });

  it('both commit-time triggers exist and are deferred', async () => {
    if (!dbAvailable) return;
    const { rows } = await pool.query<{ tgname: string; deferred: boolean; relname: string }>(
      `SELECT t.tgname, t.tginitdeferred AS deferred, c.relname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE 'pagespace_test_wallet_legs_%' ORDER BY t.tgname`,
    );
    expect(rows).toEqual([
      { tgname: 'pagespace_test_wallet_legs_on_legs', deferred: true, relname: 'wallet_funding_legs' },
      { tgname: 'pagespace_test_wallet_legs_on_wallets', deferred: true, relname: 'wallets' },
    ]);
  });

  it('a plain write that breaks topupRemainingCents == SUM(legs) is refused — no SET, no install in this test', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser({ subscriptionTier: 'free' });
    userIds.push(user.id);
    const driveWalletId = await db.transaction(async (tx) => {
      const [root] = await tx.insert(wallets).values({ userId: user.id }).returning({ id: wallets.id });
      const [drive] = await tx.insert(wallets).values({
        userId: user.id, subjectType: 'drive', subjectId: `drive-${user.id}`, parentWalletId: root.id, topupRemainingCents: 500,
      }).returning({ id: wallets.id });
      await tx.insert(walletFundingLegs).values({ walletId: drive.id, funderKind: 'owner', funderUserId: user.id, originalCents: 500, remainingCents: 500, nonRefundable: false });
      return drive.id;
    });

    await expect(db.update(wallets).set({ topupRemainingCents: 499 }).where(eq(wallets.id, driveWalletId))).rejects.toMatchObject({ cause: { code: '23514' } });

    const [row] = await db.select({ topup: wallets.topupRemainingCents }).from(wallets).where(eq(wallets.id, driveWalletId));
    expect(row.topup).toBe(500);
    // Children before the parent (no cascade on parentWalletId).
    await db.delete(wallets).where(eq(wallets.id, driveWalletId));
  });
});
