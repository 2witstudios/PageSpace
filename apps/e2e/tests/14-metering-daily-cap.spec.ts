import { test, expect } from '@playwright/test';
import { seedUser, createAgentPage, createMcpToken, getLedger } from '../support/db';
import { mcpPost, resetMock, mockCallCount } from '../support/http';

/**
 * The per-user/day exposure cap, exercised against the real chat route. A runaway loop can
 * stay within the in-flight concurrency cap yet accrue real spend all day; the daily cap is
 * the backstop. With enforcement ON and a small DAILY_CAP_BUSINESS_CENTS, once a user's
 * holds + charged spend would cross the ceiling the route must return 429 `daily_cap_exceeded`
 * — without calling the model and without billing past the cap.
 *
 * GOTCHA: dailyExposureCapForTier reads DAILY_CAP_<TIER>_CENTS at CALL time, in the WEB
 * SERVER's process, so it must be in the app's launch env (like CREDITS_ENFORCEMENT_ENABLED),
 * NOT set from inside this spec. This spec uses the `business` tier so the cap it relies on
 * (DAILY_CAP_BUSINESS_CENTS) doesn't perturb the other metering specs (which use pro/free).
 * Launch the app for this run with (in addition to README.metering.md):
 *   CREDITS_ENFORCEMENT_ENABLED=true
 *   DAILY_CAP_BUSINESS_CENTS=25
 * With the 25¢ stub-model hold estimate, the first call fits the 25¢ cap and the next is denied.
 */

const CAP_CENTS = 25;

test.use({ storageState: { cookies: [], origins: [] } });

test('429 daily_cap_exceeded once the daily ceiling is reached; model not called, nothing billed past the cap', async ({ request }) => {
  const user = await seedUser({
    tier: 'business',
    provider: 'openrouter',
    monthlyRemainingCents: 100_000, // abundant credits → the daily cap, not the balance, is the limiter
    monthlyAllowanceCents: 100_000,
  });
  const chatId = await createAgentPage(user.driveId, user.userId);
  const mcp = await createMcpToken(user.userId);
  await resetMock(request);

  const statuses: number[] = [];
  let capDenialSeen = false;
  let modelCountBeforeDenial = -1;

  // Drive calls until the cap denies one (bounded so a misconfigured env fails fast rather
  // than looping forever).
  for (let i = 0; i < 5 && !capDenialSeen; i++) {
    const before = await mockCallCount(request);
    const res = await mcpPost(request, '/api/ai/chat', mcp, {
      messages: [{ role: 'user', content: 'ping' }],
      chatId,
    });
    statuses.push(res.status());

    if (res.status() === 429) {
      const body = (await res.json()) as { error?: string };
      expect(body.error, 'the daily cap denial is distinct from the in-flight cap').toBe('daily_cap_exceeded');
      capDenialSeen = true;
      modelCountBeforeDenial = before;
      // The denied (over-cap) call must NOT reach the model.
      expect(await mockCallCount(request)).toBe(before);
    } else {
      expect(res.status(), 'a within-cap call is served normally').toBe(200);
      await res.body(); // drain so settlement runs
    }
  }

  // The cap actually fired (requires DAILY_CAP_BUSINESS_CENTS in the app env — see header).
  expect(capDenialSeen, 'expected a daily_cap_exceeded denial within the burst').toBe(true);
  // At least one call got through before the cap — proves we were "driven past" a real ceiling,
  // not denied from the first request.
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
  // The model was invoked only for the allowed calls, never for the denied one.
  expect(await mockCallCount(request)).toBe(modelCountBeforeDenial);

  // Nothing was billed beyond the cap: total charged usage stays within the ceiling.
  // Summed in integer millicents (exact) and compared to the cap, avoiding float division.
  const usage = await getLedger(user.userId, 'usage');
  const chargedMillicents = usage.reduce((sum, r) => sum + Math.abs(r.chargeMillicents ?? 0), 0);
  expect(chargedMillicents).toBeLessThanOrEqual(CAP_CENTS * 1000);
});
