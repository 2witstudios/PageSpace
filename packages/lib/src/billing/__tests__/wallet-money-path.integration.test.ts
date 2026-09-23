/**
 * The live money path after credit_balances became the wallets table (Spec WAL-5, X-5),
 * against a real Postgres: the REAL applyStripeFunding, canConsumeAI and consumeCredits,
 * no mocks.
 *
 * What must hold after migration 0305 made walletId NOT NULL on credit_ledger and
 * credit_holds: every row the money path writes names the payer's personal root wallet,
 * a user never ends up with a second root, and the money is exactly what it was before
 * wallets existed (top-up + starter grant − charge).
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children first, users last.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { applyStripeFunding } from '../credit-funding';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { tierAllowanceCents } from '../money-model';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

async function cleanup(userId: string): Promise<void> {
  await db.delete(aiUsageLogs).where(eq(aiUsageLogs.userId, userId));
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('the money path writes every row against the personal root wallet', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('wallet-money-path.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('WAL-5 (partial) X-5 (partial): fund → gate → settle names one personal root wallet on every ledger and hold row, and the money adds up', async () => {
    if (!dbAvailable) return;
    process.env.DEPLOYMENT_MODE = 'cloud';
    const user = await factories.createUser({ subscriptionTier: 'free' });
    try {
      // A top-up before the first AI call: creates the wallet bare, credits 500¢.
      await applyStripeFunding({
        id: `evt_${user.id}`,
        type: 'checkout.session.completed',
        data: { object: { id: `cs_${user.id}`, mode: 'payment', metadata: { kind: 'credit_pack', packCents: '500', userId: user.id } } },
      });

      // First AI call: the gate grants the one-time starter allowance into that bare
      // wallet and places a hold against it.
      const gate = await canConsumeAI(user.id, 'free');
      expect(gate.allowed).toBe(true);
      const holdsDuring = await db.select().from(creditHolds).where(eq(creditHolds.userId, user.id));
      expect(holdsDuring).toHaveLength(1);

      // Settle $0.10 → 15¢ at the 1.5× markup, drawn from the monthly bucket first.
      const status = await consumeCredits({ aiUsageLogId: `log_${user.id}`, userId: user.id, costDollars: 0.1, holdId: gate.holdId });
      expect(status).toBe('settled');

      const roots = await db.select().from(wallets).where(personalRootWalletOf(user.id));
      expect(roots).toHaveLength(1);
      const root = roots[0];
      const all = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.userId, user.id));
      expect(all).toHaveLength(1);

      expect(holdsDuring[0].walletId).toBe(root.id);
      const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, user.id));
      expect(ledger.map((r) => r.entryType).sort()).toEqual(['monthly_grant', 'topup_purchase', 'usage']);
      for (const row of ledger) expect(row.walletId, row.entryType).toBe(root.id);

      const starter = tierAllowanceCents('free');
      expect(root.topupRemainingCents).toBe(500);
      expect(root.monthlyRemainingCents).toBe(starter - 15);
      expect(root.debtCents).toBe(0);
      // The hold was released at settle.
      expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, user.id))).toHaveLength(0);
    } finally {
      await cleanup(user.id);
    }
  });

  it('WAL-5 (partial): every AI usage row that settles records the wallet charged — a paid call and a zero-charge call alike', async () => {
    if (!dbAvailable) return;
    process.env.DEPLOYMENT_MODE = 'cloud';
    const user = await factories.createUser({ subscriptionTier: 'free' });
    try {
      const usageRow = async (id: string) => {
        await db.insert(aiUsageLogs).values({ id, userId: user.id, provider: 'openrouter', model: 'test-model' });
      };
      await usageRow(`log_paid_${user.id}`);
      await usageRow(`log_free_${user.id}`);

      const gate = await canConsumeAI(user.id, 'free');
      expect(gate.allowed).toBe(true);
      expect(await consumeCredits({ aiUsageLogId: `log_paid_${user.id}`, userId: user.id, costDollars: 0.1, holdId: gate.holdId })).toBe('settled');
      expect(await consumeCredits({ aiUsageLogId: `log_free_${user.id}`, userId: user.id, costDollars: 0 })).toBe('settled');

      const [root] = await db.select({ id: wallets.id }).from(wallets).where(personalRootWalletOf(user.id));
      const logs = await db.select({ id: aiUsageLogs.id, walletId: aiUsageLogs.walletId }).from(aiUsageLogs).where(eq(aiUsageLogs.userId, user.id));
      expect(logs).toHaveLength(2);
      for (const log of logs) expect(log.walletId, log.id).toBe(root.id);

      // The ledger row for each call names the same wallet the usage row does.
      const usage = await db.select({ aiUsageLogId: creditLedger.aiUsageLogId, walletId: creditLedger.walletId }).from(creditLedger).where(eq(creditLedger.userId, user.id));
      for (const log of logs) expect(usage.find((r) => r.aiUsageLogId === log.id)?.walletId).toBe(log.walletId);
    } finally {
      await cleanup(user.id);
    }
  });

  it('WAL-5 (partial): a billing-off deployment\'s ceiling hold is placed against a bare personal wallet that holds no money', async () => {
    if (!dbAvailable) return;
    process.env.DEPLOYMENT_MODE = 'onprem';
    const user = await factories.createUser();
    try {
      const gate = await canConsumeAI(user.id, 'free', { dailyCapCeilingCents: 1_000 });
      expect(gate.allowed).toBe(true);

      const [root] = await db.select().from(wallets).where(personalRootWalletOf(user.id));
      const [hold] = await db.select().from(creditHolds).where(eq(creditHolds.userId, user.id));
      expect(hold.walletId).toBe(root.id);
      expect(root).toMatchObject({ monthlyRemainingCents: 0, topupRemainingCents: 0, debtCents: 0, pendingMillicents: 0 });
    } finally {
      await cleanup(user.id);
    }
  });
});
