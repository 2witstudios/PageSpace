import { test, expect } from '@playwright/test';
import {
  seedUser,
  seedPendingReconcileCall,
  getBalance,
  getLedger,
  getAiUsageLog,
} from '../support/db';
import { resetMock, setGenerationCost } from '../support/http';
import { cronHeaders } from '../support/sign';

/**
 * End-to-end cost reconcile: we bill an OpenRouter call inline on the cost the stream
 * returns, but OpenRouter's authoritative `/generation` cost can settle differently. The
 * reconcile cron fetches that final cost and writes a correcting adjustment + balance
 * delta. Here a billed-at-2¢ call's generation resolves to 10¢; the cron must debit the
 * 8¢ drift (×1.5 markup = 12¢) and the correction must be idempotent across runs.
 *
 * The reconcile cron uses its DEFAULT fetcher, which hits OPENROUTER_BASE_URL/generation
 * (pointed at the mock) with OPENROUTER_DEFAULT_API_KEY — both set when the app launches
 * for the metering run (see README.metering.md).
 */

const RECONCILE_PATH = '/api/cron/reconcile-ai-cost';

// Pure API tests — drop the seeded browser session.
test.use({ storageState: { cookies: [], origins: [] } });

function reconcileHeaders(): Record<string, string> {
  return cronHeaders({ method: 'GET', path: RECONCILE_PATH });
}

test('reconcile cron corrects a billed call against the authoritative /generation cost', async ({ request }) => {
  await resetMock(request);
  const START = 10_000;
  const user = await seedUser({
    tier: 'pro',
    provider: 'openrouter',
    monthlyRemainingCents: START,
    monthlyAllowanceCents: START,
  });

  // Billed inline at 2¢ real; the authoritative generation cost is 10¢ → +8¢ drift.
  const genId = `gen-recon-${user.userId}`;
  await seedPendingReconcileCall(user.userId, { generationId: genId, billedCostDollars: 0.02, chargedCents: 3 });
  await setGenerationCost(request, 0.1, genId);

  const res = await request.get(RECONCILE_PATH, { headers: reconcileHeaders() });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { corrected: number };
  expect(body.corrected).toBe(1);

  // An adjustment ledger row was written, keyed to the generation set.
  const adjustments = await getLedger(user.userId, 'adjustment');
  expect(adjustments).toHaveLength(1);
  expect(adjustments[0].reconcileGenerationKey).toBe(genId);

  // The balance moved by the drift charge: 8¢ real × 1.5 = 12¢ debited monthly-first.
  expect((await getBalance(user.userId))?.monthlyRemainingCents).toBe(START - 12);

  // The usage row is now reconciled.
  const log = await getAiUsageLog(
    (await getLedger(user.userId, 'usage'))[0].aiUsageLogId as string,
  );
  expect(log?.reconcileStatus).toBe('reconciled');
});

test('reconcile is idempotent: a duplicate generation set and a re-run never double-correct', async ({ request }) => {
  await resetMock(request);
  const START = 10_000;
  const user = await seedUser({
    tier: 'pro',
    provider: 'openrouter',
    monthlyRemainingCents: START,
    monthlyAllowanceCents: START,
  });

  // TWO pending calls share the SAME generation id — the second correction must hit the
  // reconcileGenerationKey unique conflict (onConflictDoNothing) and apply nothing.
  const genId = `gen-dup-${user.userId}`;
  await seedPendingReconcileCall(user.userId, { generationId: genId, billedCostDollars: 0.02, chargedCents: 3 });
  await seedPendingReconcileCall(user.userId, { generationId: genId, billedCostDollars: 0.02, chargedCents: 3 });
  await setGenerationCost(request, 0.1, genId);

  const first = await request.get(RECONCILE_PATH, { headers: reconcileHeaders() });
  expect(first.status()).toBe(200);

  // Exactly one adjustment despite two pending rows sharing the key; balance moved once.
  expect(await getLedger(user.userId, 'adjustment')).toHaveLength(1);
  expect((await getBalance(user.userId))?.monthlyRemainingCents).toBe(START - 12);

  // Re-running the cron inserts no second adjustment and moves nothing further.
  const second = await request.get(RECONCILE_PATH, { headers: reconcileHeaders() });
  expect(second.status()).toBe(200);
  expect(await getLedger(user.userId, 'adjustment')).toHaveLength(1);
  expect((await getBalance(user.userId))?.monthlyRemainingCents).toBe(START - 12);
});
