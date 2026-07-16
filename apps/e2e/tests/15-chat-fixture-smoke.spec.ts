import { test, expect } from '@playwright/test';
import { seedUser, seedChatPage, seedChatConversation, createAgentPage } from '../support/db';
import { setStreamConfig, mockStreams, releaseStreams, resetMock } from '../support/http';
import { authedContext, gotoChatPage, sendChatMessage } from '../fixtures/chat.fixture';

/**
 * Smoke spec for the chat e2e prerequisites (7.0a + 7.0b + 7.0c). It is deliberately NOT a
 * behavioral spec of the epic — 7.1-7.5 do that. It proves only that the harness the spec
 * leaves stand on actually works end-to-end:
 *
 *   7.0c — a seeded user + AI_CHAT page renders its seeded conversation in a real browser
 *   7.0b — the testids resolve, scoped per surface
 *   7.0a — a send routed to the mock produces a visibly-growing assistant bubble
 *
 * If this spec is red, 7.1-7.5 are untrustworthy regardless of what they assert.
 */

// Seed our own openrouter-provider user: the shared storageState user is provider 'openai'
// and would never reach the mock.
test.use({ storageState: { cookies: [], origins: [] } });

// A real send does substantial work before the provider call (location context, DB writes, a
// page-version write to the content store), and the held-stream case deliberately keeps a
// stream open — Playwright's 30s default kills those mid-flight. The budget is set above the
// sum of the per-assertion ceilings below so that a genuine failure surfaces as the targeted
// assertion error rather than an opaque "Test timeout exceeded". Observed runtime is ~5s per
// test, so a passing run never approaches this.
test.setTimeout(150_000);

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.describe('chat e2e harness smoke', () => {
  test('a seeded conversation renders its messages in the browser', async ({ browser, baseURL }) => {
    const user = await seedUser();
    const { pageId } = await seedChatPage(user.userId, user.driveId);

    const context = await authedContext(browser, user.sessionToken, baseURL!);
    const page = await context.newPage();
    await gotoChatPage(page, user.driveId, pageId);

    const bubbles = page.getByTestId('ai-chat-view').getByTestId('chat-message');
    await expect(bubbles.filter({ hasText: 'conversation B: user asks' })).toBeVisible();
    await expect(bubbles.filter({ hasText: 'conversation B: assistant answers' })).toBeVisible();
    await expect(bubbles.filter({ hasText: 'conversation B: user asks' })).toHaveAttribute(
      'data-role',
      'user',
    );

    await context.close();
  });

  test('a send on the slow-stream model grows an assistant bubble while streaming', async ({
    browser,
    baseURL,
    request,
  }) => {
    // ~4s of live window: long enough to observe growth, short enough not to drag the suite.
    // The MODE is what paces this — not the seeded model id, which the app rewrites to its
    // DEFAULT_MODEL before the provider call and so never reaches the mock.
    await setStreamConfig(request, { mode: 'slow', chunks: 16, intervalMs: 250 });
    const user = await seedUser();
    const pageId = await createAgentPage(user.driveId, user.userId);
    // A COMPLETE exchange. A dangling trailing user message (odd `contents`) reads to the UI
    // as a turn still in flight, which disables the composer — seed pairs, not fragments.
    await seedChatConversation(pageId, user.userId, {
      contents: ['seeded history', 'seeded reply'],
    });

    const context = await authedContext(browser, user.sessionToken, baseURL!);
    const page = await context.newPage();
    await gotoChatPage(page, user.driveId, pageId);

    await sendChatMessage(page.getByTestId('ai-chat-view'), 'hello');

    // The request reached the model and is live — no sleep, no race. The ceiling exceeds
    // expect.poll's 5s default because a send does real work first (context resolution, DB
    // writes, a page-version write to the content store); measured at ~6s to reach the
    // provider. It still fails fast on a genuine break and never sleeps on success.
    await expect
      .poll(() => mockStreams(request).then((s) => s.open), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // data-role is ON the chat-message element, not a descendant — so this must be an
    // attribute selector on the element itself, never a `has:` descendant filter.
    const assistant = page
      .getByTestId('ai-chat-view')
      .locator('[data-testid="chat-message"][data-role="assistant"]')
      .last();
    await expect(assistant).toBeVisible();

    // Growing: the same bubble holds strictly more text a moment later.
    const first = (await assistant.innerText()).length;
    await expect.poll(async () => (await assistant.innerText()).length).toBeGreaterThan(first);

    await expect.poll(() => mockStreams(request).then((s) => s.open), { timeout: 30_000 }).toBe(0);
    await context.close();
  });

  test('a held stream keeps the Stop affordance up until released', async ({
    browser,
    baseURL,
    request,
  }) => {
    await setStreamConfig(request, { mode: 'held' });
    const user = await seedUser();
    const pageId = await createAgentPage(user.driveId, user.userId);

    const context = await authedContext(browser, user.sessionToken, baseURL!);
    const page = await context.newPage();
    await gotoChatPage(page, user.driveId, pageId);

    await sendChatMessage(page.getByTestId('ai-chat-view'), 'hold please');

    await expect
      .poll(() => mockStreams(request).then((s) => s.held), { timeout: 30_000 })
      .toBe(1);
    // The deterministic live window 7.2-7.4 are built on: the UI is mid-stream for as long
    // as the spec wants, with no timing assumptions.
    await expect(page.getByTestId('chat-stop')).toBeVisible();

    await releaseStreams(request);
    await expect(page.getByTestId('chat-stop')).toBeHidden();
    expect((await mockStreams(request)).open).toBe(0);

    await context.close();
  });
});
