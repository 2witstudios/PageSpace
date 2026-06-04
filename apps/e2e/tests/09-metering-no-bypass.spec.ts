import { test, expect } from '@playwright/test';
import {
  seedUser,
  createAgentPage,
  createGlobalConversation,
  createMcpToken,
  getLedger,
  type SeededUser,
} from '../support/db';
import { sessionPost, mcpPost, resetMock, mockCallCount } from '../support/http';
import { cronHeaders } from '../support/sign';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';

/**
 * The core claim: with enforcement ON, EVERY AI entry point refuses an out-of-credits
 * user BEFORE invoking the model. For each surface we assert (a) the request is blocked
 * (402 out_of_credits) and (b) no `usage` ledger row was written — i.e. nothing was
 * billed and, by extension, no model call settled. This is the "no bypass" proof.
 */

// These are pure API tests — drop the seeded browser session so only our explicit
// per-user auth headers are in play.
test.use({ storageState: { cookies: [], origins: [] } });

async function expectNoUsage(user: SeededUser) {
  const usage = await getLedger(user.userId, 'usage');
  expect(usage, 'an out-of-credits request must not produce a usage/billing row').toHaveLength(0);
}

const brokeOpts = { monthlyRemainingCents: 0, monthlyAllowanceCents: 0, topupRemainingCents: 0 } as const;

test.describe('metering cannot be bypassed (enforcement ON, 0 credits)', () => {
  test('POST /api/pulse/generate → 402, nothing billed', async ({ request }) => {
    const user = await seedUser({ tier: 'pro', ...brokeOpts });
    const res = await sessionPost(request, '/api/pulse/generate', user, {});
    expect(res.status()).toBe(402);
    await expectNoUsage(user);
  });

  test('POST /api/voice/synthesize → 402, nothing billed', async ({ request }) => {
    // Voice is paid-only; use a paid tier so we hit the credit gate, not the tier gate.
    const user = await seedUser({ tier: 'pro', ...brokeOpts });
    const res = await sessionPost(request, '/api/voice/synthesize', user, {
      text: 'hello world',
      voice: 'nova',
      model: 'tts-1',
      speed: 1.0,
    });
    expect(res.status()).toBe(402);
    await expectNoUsage(user);
  });

  test('POST /api/ai/chat → 402, model never called, nothing billed', async ({ request }) => {
    const user = await seedUser({ tier: 'pro', ...brokeOpts });
    const chatId = await createAgentPage(user.driveId, user.userId);
    const mcp = await createMcpToken(user.userId);
    await resetMock(request);

    const res = await mcpPost(request, '/api/ai/chat', mcp, {
      messages: [{ role: 'user', content: 'hello' }],
      chatId,
    });

    expect(res.status()).toBe(402);
    expect(await mockCallCount(request), 'blocked chat must not reach the model').toBe(0);
    await expectNoUsage(user);
  });

  test('POST /api/ai/page-agents/consult → 402, nothing billed', async ({ request }) => {
    const user = await seedUser({ tier: 'pro', ...brokeOpts });
    const agentId = await createAgentPage(user.driveId, user.userId);
    const mcp = await createMcpToken(user.userId);
    await resetMock(request);

    const res = await mcpPost(request, '/api/ai/page-agents/consult', mcp, {
      agentId,
      question: 'What is the status?',
    });

    expect(res.status()).toBe(402);
    expect(await mockCallCount(request)).toBe(0);
    await expectNoUsage(user);
  });

  test('POST /api/v1/chat/completions (MCP passthrough) → 402, nothing billed', async ({ request }) => {
    const user = await seedUser({ tier: 'pro', ...brokeOpts });
    const pageId = await createAgentPage(user.driveId, user.userId);
    const mcp = await createMcpToken(user.userId);
    await resetMock(request);

    const res = await mcpPost(request, '/api/v1/chat/completions', mcp, {
      messages: [{ role: 'user', content: 'hello' }],
      pageId,
      model: 'e2e/stub-model',
    });

    expect(res.status()).toBe(402);
    expect(await mockCallCount(request)).toBe(0);
    await expectNoUsage(user);
  });

  test('POST /api/ai/global/[id]/messages → 402, nothing billed', async ({ request }) => {
    const user = await seedUser({ tier: 'pro', ...brokeOpts });
    const conversationId = await createGlobalConversation(user.userId);

    const res = await sessionPost(request, `/api/ai/global/${conversationId}/messages`, user, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(res.status()).toBe(402);
    await expectNoUsage(user);
  });

  test('POST /api/pulse/cron skips an out-of-credits user (the closed bypass)', async ({ request }) => {
    // A 0-credit user who is "active" (fresh session) and has no recent summary is a
    // cron candidate. Pre-fix, cron generated + billed for them with no gate. Now the
    // gate must skip them: no summary, no usage row.
    const user = await seedUser({ tier: 'pro', ...brokeOpts });

    const res = await request.post('/api/pulse/cron', {
      headers: cronHeaders({ path: '/api/pulse/cron' }),
    });
    expect(res.status()).toBe(200);

    const summaries = await db
      .select()
      .from(pulseSummaries)
      .where(eq(pulseSummaries.userId, user.userId));
    expect(summaries, 'cron must not generate a summary for an out-of-credits user').toHaveLength(0);
    await expectNoUsage(user);
  });
});
