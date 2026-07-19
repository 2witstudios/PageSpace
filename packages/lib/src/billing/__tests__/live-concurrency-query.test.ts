/**
 * getLiveInFlightHolds integration tests (real Postgres).
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable,
 * mirroring credit-gate-concurrency.integration.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { factories } from '@pagespace/db/test/factories';
import { getLiveInFlightHolds } from '../live-concurrency-query';

let dbAvailable = false;

async function cleanup(userId: string): Promise<void> {
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(creditBalances).where(eq(creditBalances.userId, userId));
}

describe('getLiveInFlightHolds', () => {
  beforeAll(async () => {
    try {
      await db.select().from(creditBalances).limit(1);
      dbAvailable = true;
    } catch {
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
      await db.insert(creditHolds).values([
        { userId: user.id, estCents: 2, expiresAt: future },
        { userId: user.id, estCents: 2, expiresAt: future },
        { userId: other.id, estCents: 2, expiresAt: future },
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
      await db.insert(creditHolds).values([
        { userId: user.id, estCents: 2, expiresAt: past },
        { userId: user.id, estCents: 2, expiresAt: future },
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
      await db.insert(creditHolds).values([
        { userId: user.id, estCents: 2, expiresAt: future, aiUsageLogId: null },
        { userId: user.id, estCents: 25, expiresAt: future, aiUsageLogId: null },
      ]);

      expect(await getLiveInFlightHolds(user.id)).toBe(2);
    } finally {
      await cleanup(user.id);
    }
  });
});
