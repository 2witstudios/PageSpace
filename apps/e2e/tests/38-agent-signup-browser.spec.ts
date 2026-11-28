import { test, expect, type BrowserContext } from '@playwright/test';
import { getBalance, seedUser } from '../support/db';
import { mockCallCount, resetMock } from '../support/http';
import { authedContext } from '../fixtures/chat.fixture';
import {
  anonymousContext,
  chatTurnBody,
  inPageFetch,
  personalWalletLedger,
  starterGrantRows,
} from '../fixtures/agent-signup.fixture';

/**
 * Agent Signup, end to end in a real browser (ADR 0008; epic stories US2, US4, US5, US6, US7).
 *
 * One journey, because every step depends on the account the step before it made:
 *   1. a computer-use agent creates its own account at /auth/agent: a real proof of work in the
 *      page's web worker, then the secret is shown exactly once;
 *   2. it continues into the app signed in as itself and creates a page;
 *   3. its first AI call is refused 402 `requires_funding` with the claim URL the server metadata
 *      advertises, the model is never reached, and no `free-init-<agentId>` starter grant exists;
 *   4. it hands a human the claim link from the reveal card; the human signs in, sees whom they
 *      are agreeing to pay for, and claims it at /claim;
 *   5. the same agent session (pre-claim credentials survive a claim) makes the same AI call,
 *      which now reaches the model, and the charge lands on the OWNER's wallet, not the agent's.
 *
 * The AI provider is Playwright's OpenRouter mock (support/mock-openrouter.ts): every cloud model
 * is OpenRouter-backed, so the agent's default provider reaches it with no special seeding.
 */

test.use({ storageState: { cookies: [], origins: [] } });
// The proof of work runs at the shipped difficulty (AGENT_SIGNUP_POW_BITS default 20: about a
// million SHA3 hashes in a web worker), then two chat turns and a claim. Generous on purpose so
// a slow runner fails on a targeted assertion, not on an opaque test timeout.
test.setTimeout(240_000);

/** On the free plan, so the agent's own tier never stands between it and the model (US4 is about funding). */
const FREE_PLAN_MODEL = { provider: 'anthropic', model: 'anthropic/claude-haiku-5.5' };

const openContexts: BrowserContext[] = [];
test.beforeEach(async ({ request }) => {
  await resetMock(request);
});
test.afterEach(async () => {
  await Promise.all(openContexts.map((c) => c.close()));
  openContexts.length = 0;
});

test.describe('agent signup: browser door to owner pays', () => {
  test('an agent signs up at /auth/agent, is refused AI until a human claims it at /claim, then its AI usage bills the owner', async ({
    browser,
    baseURL,
    request,
  }) => {
    const origin = new URL(baseURL!).origin;
    const agentName = `E2E browser agent ${Date.now()}`;

    // ── 1. Sign up as an agent; the secret is revealed once ───────────────────────────────
    const agentContext = await anonymousContext(browser, baseURL!);
    openContexts.push(agentContext);
    const agent = await agentContext.newPage();

    await agent.goto('/auth/signup');
    await agent.getByTestId('agent-auth-link-signup').click();
    await expect(agent).toHaveURL(/\/auth\/agent\?mode=signup/);
    // The DOM-reader instructions are present for agents that parse the page rather than see it.
    await expect(agent.getByTestId('agent-instructions')).toContainText('/auth.md');

    await agent.getByLabel('Agent name').fill(agentName);
    await agent.getByLabel(/which agent are you/i).fill('playwright-e2e');
    await agent.getByRole('checkbox', { name: /accept the terms/i }).check();

    const signupResponse = agent.waitForResponse(
      (res) => res.url().endsWith('/api/auth/agent/signup') && res.request().method() === 'POST',
      { timeout: 180_000 },
    );
    await agent.getByRole('button', { name: 'Create agent account' }).click();
    const signup = await signupResponse;
    expect(signup.status(), 'browser signup must succeed after the proof of work').toBe(200);

    const reveal = agent.getByTestId('agent-secret-reveal');
    await expect(reveal).toBeVisible();
    const secret = (await agent.getByTestId('agent-secret').innerText()).trim();
    const agentId = (await agent.getByTestId('agent-id').innerText()).trim();
    expect(secret).toMatch(/^ps_agent_/);
    expect(agentId.length).toBeGreaterThan(0);
    await expect(reveal).toContainText('This is the only time your secret is shown');

    // The claim link the agent will hand a human: minted from its new session, on its own origin.
    await reveal.getByRole('button', { name: 'Get claim link' }).click();
    const claimUrl = (await agent.getByTestId('agent-claim-url').innerText()).trim();
    expect(claimUrl.startsWith(`${origin}/claim?user_code=`)).toBe(true);

    // Continue stays shut until the agent says it saved the secret.
    const continueButton = reveal.getByRole('button', { name: 'Continue' });
    await expect(continueButton).toBeDisabled();
    await reveal.getByRole('checkbox', { name: 'I have saved my secret' }).check();
    await continueButton.click();

    // ── 2. Into the app, signed in as the agent ───────────────────────────────────────────
    await agent.waitForURL(/\/dashboard/);
    // Unclaimed: the header says it has no AI credits where a person would see "Verify email".
    await expect(agent.getByTestId('agent-unfunded-notice')).toBeVisible();
    // Shown once means once: nothing the app serves the agent afterwards carries the secret.
    expect(await agent.content()).not.toContain(secret);
    const me = await inPageFetch(agent, '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json?.accountType).toBe('agent');
    expect(me.text).not.toContain(secret);

    // Create a page in its own drive — free work an agent can do with no funding (US3).
    const drives = await inPageFetch(agent, '/api/drives');
    expect(drives.status).toBe(200);
    const driveList = JSON.parse(drives.text) as Array<{ id: string; ownerId?: string }>;
    let driveId = driveList.find((d) => d.ownerId === agentId)?.id ?? driveList[0]?.id;
    if (!driveId) {
      const created = await inPageFetch(agent, '/api/drives', { method: 'POST', json: { name: 'Agent drive' } });
      expect(created.status, created.text).toBeLessThan(300);
      driveId = String(created.json?.id);
    }
    const createdPage = await inPageFetch(agent, '/api/pages', {
      method: 'POST',
      json: { title: 'Agent research notes', type: 'AI_CHAT', driveId },
    });
    expect(createdPage.status, createdPage.text).toBe(201);
    const chatId = String(createdPage.json?.id);

    // ── 3. The first AI call is refused: requires_funding, nothing reached, no free credits ─
    const metadata = (await (await request.get('/.well-known/oauth-authorization-server')).json()) as {
      agent_auth: { claim_endpoint: string };
    };
    const refused = await inPageFetch(agent, '/api/ai/chat', {
      method: 'POST',
      json: chatTurnBody(chatId, 'Summarise my notes', FREE_PLAN_MODEL),
    });
    expect(refused.status, refused.text).toBe(402);
    expect(refused.json?.error).toBe('requires_funding');
    expect(refused.json?.claim_url).toBe(metadata.agent_auth.claim_endpoint);
    expect(await mockCallCount(request), 'an unfunded agent must never reach the model').toBe(0);
    expect(await starterGrantRows(agentId), 'no free-init starter grant may ever exist for an agent').toHaveLength(0);

    // ── 4. A human signs in and claims the agent at /claim ────────────────────────────────
    const OWNER_START_CENTS = 10_000;
    const owner = await seedUser({
      name: 'E2E Agent Owner',
      tier: 'pro',
      monthlyRemainingCents: OWNER_START_CENTS,
      monthlyAllowanceCents: OWNER_START_CENTS,
    });
    const claimPath = new URL(claimUrl).pathname + new URL(claimUrl).search;

    // Signed out, the claim link sends the person to sign in first and brings them back.
    const signedOut = await anonymousContext(browser, baseURL!);
    openContexts.push(signedOut);
    const signedOutPage = await signedOut.newPage();
    await signedOutPage.goto(claimPath);
    await expect(signedOutPage).toHaveURL(/\/auth\/signin\?next=/);
    expect(decodeURIComponent(signedOutPage.url())).toContain(claimPath);

    const ownerContext = await authedContext(browser, owner.sessionToken, baseURL!);
    openContexts.push(ownerContext);
    const human = await ownerContext.newPage();
    await human.goto(claimPath);
    await human.getByRole('button', { name: 'Continue' }).click();
    await expect(human.getByText(agentName, { exact: true })).toBeVisible();
    await expect(human.getByText('You will pay for its AI usage.', { exact: true })).toBeVisible();
    await human.getByRole('button', { name: 'Claim and pay' }).click();
    await expect(human.getByText('Agent claimed', { exact: true })).toBeVisible();

    // Settings → Agents lists the agent the person now owns (US6).
    await human.goto('/settings/agents');
    await expect(human.getByText(agentName, { exact: true }).first()).toBeVisible();

    // ── 5. The agent's AI call now succeeds and bills the owner ───────────────────────────
    await resetMock(request);
    const funded = await inPageFetch(agent, '/api/ai/chat', {
      method: 'POST',
      json: chatTurnBody(chatId, 'Summarise my notes', FREE_PLAN_MODEL),
    });
    expect(funded.status, funded.text.slice(0, 500)).toBe(200);
    expect(await mockCallCount(request), 'the claimed agent reaches the model').toBeGreaterThanOrEqual(1);

    // Settlement can land just after the stream closes.
    await expect
      .poll(async () => (await getBalance(owner.userId))?.monthlyRemainingCents, { timeout: 15_000 })
      .toBeLessThan(OWNER_START_CENTS);
    const ownerUsage = await personalWalletLedger(owner.userId, 'usage');
    expect(ownerUsage.length, "the agent's AI usage is charged to its owner's wallet").toBeGreaterThanOrEqual(1);
    for (const row of ownerUsage) expect(row.amountCents).toBeLessThan(0);
    expect(await personalWalletLedger(agentId, 'usage'), 'nothing is charged to the agent itself').toHaveLength(0);
    expect(await starterGrantRows(agentId)).toHaveLength(0);

    // Claimed, the agent's header no longer asks for funding.
    await agent.reload();
    await expect(agent.getByTestId('agent-unfunded-notice')).toBeHidden();
  });
});
