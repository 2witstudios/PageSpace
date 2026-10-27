/**
 * getLiveInFlightHolds integration tests (real Postgres).
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
 * Mirrors credit-gate-concurrency.integration.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { creditHolds } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import { users } from '@pagespace/db/schema/auth';
import { factories } from '@pagespace/db/test/factories';
import { getLiveInFlightHolds } from '../live-concurrency-query';
import { requireDb } from '@pagespace/db/test/require-db';

let dbAvailable = false;

async function cleanup(userId: string): Promise<void> {
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

/** Holds are per wallet (WAL-5): each user's personal root wallet. */
async function walletOf(userId: string): Promise<string> {
  const [wallet] = await db.insert(wallets).values({ ownerType: 'user', userId }).returning({ id: wallets.id });
  return wallet.id;
}

describe('getLiveInFlightHolds', () => {
  beforeAll(async () => {
    try {
      await db.select().from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('live-concurrency-query.test.ts', error);
      dbAvailable = false;
    }
  });

  it('given no holds, should return 0', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      expect(await getLiveInFlightHolds(user.id)).toBe(0);
    } finally {
      await cleanup(user.id);
    }
  });

  it('given unexpired holds, should count only this user\'s rows', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    const other = await factories.createUser();
    try {
      const future = new Date(Date.now() + 60_000);
      const userWallet = await walletOf(user.id);
      const otherWallet = await walletOf(other.id);
      await db.insert(creditHolds).values([
        { userId: user.id, walletId: userWallet, estCents: 2, expiresAt: future },
        { userId: user.id, walletId: userWallet, estCents: 2, expiresAt: future },
        { userId: other.id, walletId: otherWallet, estCents: 2, expiresAt: future },
      ]);

      expect(await getLiveInFlightHolds(user.id)).toBe(2);
      expect(await getLiveInFlightHolds(other.id)).toBe(1);
    } finally {
      await cleanup(user.id);
      await cleanup(other.id);
    }
  });

  it('given an expired hold, should exclude it from the count', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      const past = new Date(Date.now() - 1_000);
      const future = new Date(Date.now() + 60_000);
      const walletId = await walletOf(user.id);
      await db.insert(creditHolds).values([
        { userId: user.id, walletId, estCents: 2, expiresAt: past },
        { userId: user.id, walletId, estCents: 2, expiresAt: future },
      ]);

      expect(await getLiveInFlightHolds(user.id)).toBe(1);
    } finally {
      await cleanup(user.id);
    }
  });

  it('given holds with no distinguishing source, should count them all (credit_holds has no per-call-type column)', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      const future = new Date(Date.now() + 60_000);
      // aiUsageLogId is null on every hold here, same as a real chat hold and
      // a real machine hold both look before settle — there is no field to
      // filter on, which is exactly why this counts all in-flight AI activity
      // for the payer, not machine-specific sessions.
      const walletId = await walletOf(user.id);
      await db.insert(creditHolds).values([
        { userId: user.id, walletId, estCents: 2, expiresAt: future, aiUsageLogId: null },
        { userId: user.id, walletId, estCents: 25, expiresAt: future, aiUsageLogId: null },
      ]);

      expect(await getLiveInFlightHolds(user.id)).toBe(2);
    } finally {
      await cleanup(user.id);
    }
  });
});
