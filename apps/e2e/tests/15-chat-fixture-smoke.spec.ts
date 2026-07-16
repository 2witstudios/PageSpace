import { test, expect } from '@playwright/test';
import { seedUser, seedChatPage, seedChatConversation, createAgentPage } from '../support/db';
import { setStreamConfig, mockStreams, releaseStreams, resetMock } from '../support/http';
import { authedContext, gotoChatPage } from '../fixtures/chat.fixture';
import { E2E_SLOW_STREAM_MODEL, E2E_HELD_STREAM_MODEL } from '../support/mock-openrouter';

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

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.describe('chat e2e harness smoke', () => {
  test('a seeded conversation renders its messages in the browser', async ({ browser, baseURL }) => {
    const user = await seedUser();
    const { pageId, conversationB } = await seedChatPage(user.userId, user.driveId);

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
    expect(conversationB).toBeTruthy();

    await context.close();
  });

  test('a send on the slow-stream model grows an assistant bubble while streaming', async ({
    browser,
    baseURL,
    request,
  }) => {
    // ~4s of live window: long enough to observe growth, short enough not to drag the suite.
    await setStreamConfig(request, { chunks: 16, intervalMs: 250 });
    const user = await seedUser({ model: E2E_SLOW_STREAM_MODEL });
    const pageId = await createAgentPage(user.driveId, user.userId);
    await seedChatConversation(pageId, user.userId, { contents: ['seeded history'] });

    const context = await authedContext(browser, user.sessionToken, baseURL!);
    const page = await context.newPage();
    await gotoChatPage(page, user.driveId, pageId);

    await page.getByTestId('chat-textarea').fill('hello');
    await page.getByTestId('chat-send').click();

    // The request reached the model and is live — no sleep, no race.
    await expect.poll(() => mockStreams(request).then((s) => s.open)).toBeGreaterThan(0);

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

    await expect.poll(() => mockStreams(request).then((s) => s.open)).toBe(0);
    await context.close();
  });

  test('a held stream keeps the Stop affordance up until released', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser({ model: E2E_HELD_STREAM_MODEL });
    const pageId = await createAgentPage(user.driveId, user.userId);

    const context = await authedContext(browser, user.sessionToken, baseURL!);
    const page = await context.newPage();
    await gotoChatPage(page, user.driveId, pageId);

    await page.getByTestId('chat-textarea').fill('hold please');
    await page.getByTestId('chat-send').click();

    await expect.poll(() => mockStreams(request).then((s) => s.held)).toBe(1);
    // The deterministic live window 7.2-7.4 are built on: the UI is mid-stream for as long
    // as the spec wants, with no timing assumptions.
    await expect(page.getByTestId('chat-stop')).toBeVisible();

    await releaseStreams(request);
    await expect(page.getByTestId('chat-stop')).toBeHidden();
    expect((await mockStreams(request)).open).toBe(0);

    await context.close();
  });
});
