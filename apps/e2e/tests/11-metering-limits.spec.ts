import { test, expect } from '@playwright/test';
import { seedUser, createAgentPage, createMcpToken, seedHolds, getLedger } from '../support/db';
import { mcpPost, resetMock, mockCallCount } from '../support/http';

/**
 * The two enforcement limits, exercised against real routes:
 *   - out_of_credits → 402 once spendable would drop to/below the reserve floor (25¢)
 *   - too_many_in_flight → 429 once a free user hits MAX_FREE_INFLIGHT (2) live holds
 * In both cases the model must not be reached and nothing may be billed.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test('402 out_of_credits when spendable is at the reserve floor', async ({ request }) => {
  // 20¢ spendable, 25¢ floor + a per-call hold estimate → denied before any call.
  const user = await seedUser({
    tier: 'pro',
    monthlyRemainingCents: 20,
    monthlyAllowanceCents: 1_500,
    topupRemainingCents: 0,
  });
  const chatId = await createAgentPage(user.driveId, user.userId);
  const mcp = await createMcpToken(user.userId);
  await resetMock(request);

  const res = await mcpPost(request, '/api/ai/chat', mcp, {
    messages: [{ role: 'user', content: 'ping' }],
    chatId,
  });

  expect(res.status()).toBe(402);
  expect(await mockCallCount(request)).toBe(0);
  expect(await getLedger(user.userId, 'usage')).toHaveLength(0);
});

test('429 too_many_in_flight when a free user is at the concurrency cap', async ({ request }) => {
  // Plenty of credits, but already at MAX_FREE_INFLIGHT (2) live holds → the in-flight
  // cap (checked before the balance) denies with 429.
  const user = await seedUser({
    tier: 'free',
    monthlyRemainingCents: 5_000,
    monthlyAllowanceCents: 5_000,
  });
  await seedHolds(user.userId, 2);
  const chatId = await createAgentPage(user.driveId, user.userId);
  const mcp = await createMcpToken(user.userId);
  await resetMock(request);

  const res = await mcpPost(request, '/api/ai/chat', mcp, {
    messages: [{ role: 'user', content: 'ping' }],
    chatId,
  });

  expect(res.status()).toBe(429);
  expect(await mockCallCount(request)).toBe(0);
  expect(await getLedger(user.userId, 'usage')).toHaveLength(0);
});
