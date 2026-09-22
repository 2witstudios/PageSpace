/**
 * ensurePersonalRootWalletId against a real Postgres (Spec WAL-1, WAL-5, X-5).
 *
 * Every ledger and hold writer now needs the payer's wallet id before it can write, and
 * resolves it through this one function. What must hold:
 *   - an existing personal root wallet (a migrated credit_balances row) is returned as
 *     is, never duplicated and never modified;
 *   - a user with none gets ONE bare wallet (zero in every bucket), and a caller that
 *     loses the race to a concurrent creator returns that creator's wallet;
 *   - a drive wallet the same person owns is never mistaken for their personal root.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children first, users last.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { ensurePersonalRootWalletId } from '../personal-wallet';

let dbAvailable = false;

/** How many sessions are waiting on a lock while inserting a wallet. */
async function walletInsertsWaitingOnLock(): Promise<number> {
  const res = await db.execute(sql`
    select count(*)::int as n from pg_stat_activity
    where wait_event_type = 'Lock' and query ilike 'insert into "wallets"%'
  `);
  return Number((res.rows[0] as { n: number }).n);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function cleanup(userId: string): Promise<void> {
  // Child wallets reference the root through parentWalletId (no cascade): children first.
  await db.delete(wallets).where(and(eq(wallets.userId, userId), eq(wallets.subjectType, 'drive')));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('ensurePersonalRootWalletId', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('personal-wallet.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('WAL-1 (partial) X-5 (partial): returns the existing personal root wallet and leaves its money untouched', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      const [existing] = await db
        .insert(wallets)
        .values({ ownerType: 'user', userId: user.id, monthlyRemainingCents: 4250, topupRemainingCents: 1999, debtCents: 7 })
        .returning();

      expect(await ensurePersonalRootWalletId(db, user.id)).toBe(existing.id);

      const rows = await db.select().from(wallets).where(eq(wallets.userId, user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ monthlyRemainingCents: 4250, topupRemainingCents: 1999, debtCents: 7 });
    } finally {
      await cleanup(user.id);
    }
  });

  it('WAL-1 (partial): a user with no wallet gets exactly one bare wallet, zero in every bucket', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      const ids = await Promise.all(Array.from({ length: 6 }, () => ensurePersonalRootWalletId(db, user.id)));
      expect(new Set(ids).size).toBe(1);

      const rows = await db.select().from(wallets).where(eq(wallets.userId, user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: ids[0],
        ownerType: 'user',
        subjectType: null,
        parentWalletId: null,
        monthlyRemainingCents: 0,
        monthlyAllowanceCents: 0,
        topupRemainingCents: 0,
        debtCents: 0,
        pendingMillicents: 0,
        monthlyPeriodStart: null,
        monthlyPeriodEnd: null,
      });
    } finally {
      await cleanup(user.id);
    }
  });

  it('WAL-1 (partial): losing the race to a concurrent creator returns THEIR wallet instead of failing', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      // Another writer has inserted this user's first wallet but not committed. Our read
      // sees nothing, our insert waits on the unique index, and when theirs commits ours
      // must stand down (ON CONFLICT DO NOTHING) and return their row — not raise 23505.
      let racing: Promise<string> | undefined;
      let theirs = '';
      try {
        await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(wallets)
            .values({ ownerType: 'user', userId: user.id, topupRemainingCents: 7 })
            .returning({ id: wallets.id });
          theirs = row.id;
          racing = ensurePersonalRootWalletId(db, user.id);
          await waitFor(async () => (await walletInsertsWaitingOnLock()) >= 1, 10_000);
        });
      } finally {
        await racing?.catch(() => undefined);
      }
      expect(await racing).toBe(theirs);
      const rows = await db.select().from(wallets).where(eq(wallets.userId, user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].topupRemainingCents).toBe(7);
    } finally {
      await cleanup(user.id);
    }
  }, 30_000);

  it('WAL-2 (partial): a drive wallet the person owns is not their personal root', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    try {
      const rootId = await ensurePersonalRootWalletId(db, user.id);
      await db.insert(wallets).values({
        ownerType: 'user',
        userId: user.id,
        subjectType: 'drive',
        subjectId: `drive-${user.id}`,
        parentWalletId: rootId,
        topupRemainingCents: 900,
      });

      expect(await ensurePersonalRootWalletId(db, user.id)).toBe(rootId);
    } finally {
      await cleanup(user.id);
    }
  });
});
