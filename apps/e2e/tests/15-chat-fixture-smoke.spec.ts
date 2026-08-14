import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
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

// Closed in teardown, not inline: a trailing `await context.close()` is skipped when an
// assertion above it throws, so every red run would leak a browser context. 7.1-7.5 will copy
// this file's shape — better that they copy the version that cleans up on failure.
const openContexts: BrowserContext[] = [];

async function authedPage(browser: Browser, sessionToken: string, baseURL: string) {
  const context = await authedContext(browser, sessionToken, baseURL);
  openContexts.push(context);
  return context.newPage();
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.afterEach(async () => {
  await Promise.all(openContexts.map((c) => c.close()));
  openContexts.length = 0;
});

test.describe('chat e2e harness smoke', () => {
  test('a seeded conversation renders its messages in the browser', async ({ browser, baseURL }) => {
    const user = await seedUser();
    const { pageId } = await seedChatPage(user.userId, user.driveId);

    const page = await authedPage(browser, user.sessionToken, baseURL!);
    await gotoChatPage(page, user.driveId, pageId);

    const bubbles = page.getByTestId('session-chat').getByTestId('chat-message');
    await expect(bubbles.filter({ hasText: 'conversation B: user asks' })).toBeVisible();
    await expect(bubbles.filter({ hasText: 'conversation B: assistant answers' })).toBeVisible();
    await expect(bubbles.filter({ hasText: 'conversation B: user asks' })).toHaveAttribute(
      'data-role',
      'user',
    );

  });

  test('a send in slow mode grows an assistant bubble while streaming', async ({
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

    const page = await authedPage(browser, user.sessionToken, baseURL!);
    await gotoChatPage(page, user.driveId, pageId);

    await sendChatMessage(page.getByTestId('session-chat'), 'hello');

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
      .getByTestId('session-chat')
      .locator('[data-testid="chat-message"][data-role="assistant"]')
      .last();
    await expect(assistant).toBeVisible();

    // Growing: the same bubble holds strictly more text a moment later.
    const first = (await assistant.innerText()).length;
    await expect.poll(async () => (await assistant.innerText()).length).toBeGreaterThan(first);

    await expect.poll(() => mockStreams(request).then((s) => s.open), { timeout: 30_000 }).toBe(0);
  });

  test('a held stream keeps the Stop affordance up until released', async ({
    browser,
    baseURL,
    request,
  }) => {
    await setStreamConfig(request, { mode: 'held' });
    const user = await seedUser();
    const pageId = await createAgentPage(user.driveId, user.userId);

    const page = await authedPage(browser, user.sessionToken, baseURL!);
    await gotoChatPage(page, user.driveId, pageId);

    await sendChatMessage(page.getByTestId('session-chat'), 'hold please');

    await expect
      .poll(() => mockStreams(request).then((s) => s.held), { timeout: 30_000 })
      .toBe(1);
    // The deterministic live window 7.2-7.4 are built on: the UI is mid-stream for as long
    // as the spec wants, with no timing assumptions.
    await expect(page.getByTestId('chat-stop')).toBeVisible();

    await releaseStreams(request);
    await expect(page.getByTestId('chat-stop')).toBeHidden();
    expect((await mockStreams(request)).open).toBe(0);

  });

  // THE HEADLINE CLAIM OF THE CLIENT-DETACH CHANGE, in a real browser.
  //
  // "A user cannot send a message, open another chat, send a second one, and trust the first
  // completes" was the bug. Every surface passed a constant `useChat` id, so ONE AI SDK `Chat`
  // served every conversation on it — and a `Chat` cannot consume two response bodies at once.
  // The old client therefore called `stop()` on the first read for every cross-conversation
  // send, and refused the second outright ("The previous response is still wrapping up") when
  // the status would not settle in 1.5s.
  //
  // `held` mode is what makes this deterministic: both generations stay open until released, so
  // "two at once" is an assertion about the mock's own count rather than about timing.
  test('a second send while the first is still generating: both stream, neither is stopped', async ({
    browser,
    baseURL,
    request,
  }) => {
    await setStreamConfig(request, { mode: 'held' });
    const user = await seedUser();
    const agentA = await createAgentPage(user.driveId, user.userId);
    const agentB = await createAgentPage(user.driveId, user.userId);

    const page = await authedPage(browser, user.sessionToken, baseURL!);

    await gotoChatPage(page, user.driveId, agentA);
    await sendChatMessage(page.getByTestId('session-chat'), 'first question');
    await expect
      .poll(() => mockStreams(request).then((s) => s.held), { timeout: 30_000 })
      .toBe(1);

    // Straight to the other conversation and send again — no settle wait, and the composer
    // must accept it rather than refusing.
    await gotoChatPage(page, user.driveId, agentB);
    await sendChatMessage(page.getByTestId('session-chat'), 'second question');

    // TWO generations live at the same time. Under the old design the first was stopped to
    // make room for this one, so this count could never reach 2.
    await expect
      .poll(() => mockStreams(request).then((s) => s.held), { timeout: 30_000 })
      .toBe(2);

    // And the first is still going after the surface that started it was unmounted by the
    // navigation — "send a message and leave", which is what moving the subscription out of
    // the component tree buys.
    await gotoChatPage(page, user.driveId, agentA);
    await expect(page.getByTestId('chat-stop')).toBeVisible();

    await releaseStreams(request);
    await expect
      .poll(() => mockStreams(request).then((s) => s.open), { timeout: 30_000 })
      .toBe(0);
  });
});
