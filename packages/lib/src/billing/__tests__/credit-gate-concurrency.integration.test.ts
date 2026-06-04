/**
 * Credit-gate concurrency integration tests (real Postgres).
 *
 * Drives the REAL canConsumeAI (credit-gate.ts) against a real database — no fake DB,
 * no vi.mock. The property under test is the one the in-memory fake CANNOT prove: the
 * `.for('update')` row lock that serializes a single user's concurrent gate checks so
 * they observe each other's holds. Every existing credit-gate test calls serially; here
 * we fire N gate checks at once (`Promise.all`) against the shared pool and assert that
 * exactly one slips through when the balance covers only one call.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied (scripts/test-with-db.sh,
 * port 5433). Skipped when no DB is reachable.
 *
 * NOTE (manual lock proof): temporarily delete `.for('update')` from canConsumeAI's
 * balance read and the first test below should FAIL (multiple calls allowed / multiple
 * holds inserted) — that confirms the test actually exercises the lock. Restore after.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { creditBalances, creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { factories } from '@pagespace/db/test/factories';
import { canConsumeAI, addOneMonth } from '../credit-gate';
import { RESERVE_FLOOR_CENTS, CREDIT_HOLD_ESTIMATE_CENTS } from '../credit-pricing';

let dbAvailable = false;

const originalProCap = process.env.DAILY_CAP_PRO_CENTS;

/** Insert a balance row directly (bypassing the gate's lazy-init) with a live monthly window. */
async function seedBalance(userId: string, monthlyRemainingCents: number): Promise<void> {
  const now = new Date();
  await db.insert(creditBalances).values({
    userId,
    monthlyRemainingCents,
    monthlyAllowanceCents: monthlyRemainingCents,
    topupRemainingCents: 0,
    debtCents: 0,
    pendingMillicents: 0,
    monthlyPeriodStart: now,
    monthlyPeriodEnd: addOneMonth(now),
  });
}

async function cleanup(userId: string): Promise<void> {
  // FK-safe order: holds + ledger reference the user; delete them before the balance/user.
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  await db.delete(creditBalances).where(eq(creditBalances.userId, userId));
}

describe('canConsumeAI concurrency (Postgres row lock)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(creditBalances).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    delete process.env.DAILY_CAP_PRO_CENTS;
  });

  afterAll(() => {
    if (originalProCap === undefined) delete process.env.DAILY_CAP_PRO_CENTS;
    else process.env.DAILY_CAP_PRO_CENTS = originalProCap;
  });

  it('serializes a concurrent burst: balance covering one call → exactly one allowed, N-1 denied, one hold', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser({ subscriptionTier: 'pro' });
    try {
      // Sized so exactly ONE call's reservation fits above the reserve floor:
      //   first call:  60 − 0(reserved) − 25(est)  = 35 > 25 floor → allowed, inserts a 25¢ hold
      //   any other:   60 − 25(that hold) − 25(est) = 10 ≯ 25 floor → out_of_credits
      // (est defaults to CREDIT_HOLD_ESTIMATE_CENTS = 25; pro tier ⇒ no in-flight cap, so
      // the denial is purely the credit decision the lock must serialize.)
      expect(CREDIT_HOLD_ESTIMATE_CENTS).toBe(25);
      expect(RESERVE_FLOOR_CENTS).toBe(25);
      await seedBalance(user.id, 60);

      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => canConsumeAI(user.id, 'pro')),
      );

      const allowed = results.filter((r) => r.allowed);
      const denied = results.filter((r) => !r.allowed);
      expect(allowed).toHaveLength(1);
      expect(denied).toHaveLength(N - 1);
      expect(denied.every((r) => r.reason === 'out_of_credits')).toBe(true);

      // The lock's observable proof: exactly one reservation row exists. Without
      // serialization, multiple concurrent checks would each read the pre-hold balance
      // and all insert a hold.
      const holds = await db.select().from(creditHolds).where(eq(creditHolds.userId, user.id));
      expect(holds).toHaveLength(1);
      expect(allowed[0].holdId).toBe(holds[0].id);
    } finally {
      await cleanup(user.id);
    }
  });

  it('a concurrent burst never lets holds + charged spend exceed the daily exposure cap', async () => {
    if (!dbAvailable) return;
    process.env.DAILY_CAP_PRO_CENTS = '50';
    const user = await factories.createUser({ subscriptionTier: 'pro' });
    try {
      // Credits are abundant (so the balance gate never trips); the daily cap is the only
      // limiter. Each allowed call reserves a 25¢ hold counted toward the cap, so:
      //   call 1: 0(charged) + 0(reserved) + 25(est) = 25 ≤ 50 → allowed
      //   call 2: 0          + 25          + 25       = 50 ≤ 50 → allowed
      //   call 3: 0          + 50          + 25       = 75 >  50 → daily_cap_exceeded
      await seedBalance(user.id, 100_000);

      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => canConsumeAI(user.id, 'pro')),
      );

      const allowed = results.filter((r) => r.allowed);
      const denied = results.filter((r) => !r.allowed);
      expect(allowed).toHaveLength(2);
      expect(denied.every((r) => r.reason === 'daily_cap_exceeded')).toBe(true);

      // The invariant the cap protects: total reserved (held) spend never exceeds the cap.
      const holds = await db.select().from(creditHolds).where(eq(creditHolds.userId, user.id));
      const heldCents = holds.reduce((sum, h) => sum + h.estCents, 0);
      expect(holds).toHaveLength(2);
      expect(heldCents).toBeLessThanOrEqual(50);
    } finally {
      await cleanup(user.id);
    }
  });
});
