import { test, expect } from '@playwright/test';
import { seedUser, createAgentPage, createMcpToken, getBalance, getLedger, getHolds } from '../support/db';
import { mcpPost, resetMock, mockCallCount } from '../support/http';
import { MOCK_COST_DOLLARS } from '../support/mock-openrouter';

/**
 * Billing happy-path: a funded user makes a real (stubbed) chat call, and the exact
 * cost the provider reported is metered against their balance. The mock returns
 * usage.cost = $0.02 (2¢ real); at the 1.5× markup the charged amount is 3¢.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const EXPECTED_REAL_CENTS = Math.round(MOCK_COST_DOLLARS * 100); // 2
const EXPECTED_CHARGE_CENTS = Math.round(EXPECTED_REAL_CENTS * 1.5); // 3

test('a funded chat call hits the model and debits exactly cost × markup', async ({ request }) => {
  const START = 10_000;
  const user = await seedUser({
    tier: 'pro',
    provider: 'openrouter',
    monthlyRemainingCents: START,
    monthlyAllowanceCents: START,
  });
  const chatId = await createAgentPage(user.driveId, user.userId);
  const mcp = await createMcpToken(user.userId);
  await resetMock(request);

  const res = await mcpPost(request, '/api/ai/chat', mcp, {
    messages: [{ role: 'user', content: 'ping' }],
    chatId,
  });
  expect(res.status()).toBe(200);
  await res.body(); // drain the stream so onFinish settlement runs

  // The model was actually invoked exactly once via the mock.
  expect(await mockCallCount(request)).toBe(1);

  // Settlement may land just after the stream closes — poll until the debit appears.
  await expect
    .poll(async () => (await getBalance(user.userId))?.monthlyRemainingCents, { timeout: 10_000 })
    .toBe(START - EXPECTED_CHARGE_CENTS);

  // A single usage ledger row recorded the charge, and the in-flight hold was released.
  const usage = await getLedger(user.userId, 'usage');
  expect(usage).toHaveLength(1);
  expect(Math.abs(usage[0].appliedCents ?? 0)).toBe(EXPECTED_CHARGE_CENTS);
  expect(await getHolds(user.userId), 'hold must settle, not linger').toHaveLength(0);
});
