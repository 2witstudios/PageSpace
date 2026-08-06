import { test, expect, type BrowserContext } from '@playwright/test';
import { seedUser, createAgentPage, seedChatConversation, createGlobalConversation } from '../support/db';
import { resetMock, sessionGet } from '../support/http';
import {
  dispatchMessage,
  openChatPane,
  openTwoWindows,
  renderedMessages,
} from '../fixtures/dispatch.fixture';

/**
 * Dispatch + multiplayer harness specs — Phase 0 of the Agent-Session Single Source of Truth
 * epic. Full rationale and the phase → spec mapping live in the header of
 * `fixtures/dispatch.fixture.ts`.
 *
 * Two tiers:
 *  - the smokes PASS today and pin the harness (dispatch really writes through the pipeline);
 *  - the `test.fixme` specs are the epic's canonical bug, written as the executable spec
 *    Phase 2 (plan PR 3) must flip green: delete the `.fixme`s in that PR. PRs 7 and 12
 *    re-verify them.
 */

// Seed our own openrouter-provider users (the shared storageState user is provider 'openai'
// and would never reach the mock) — same opt-out the chat smoke uses.
test.use({ storageState: { cookies: [], origins: [] } });

// A dispatched turn does real work (context resolution, DB writes, a page-version write)
// before and after the provider call; keep per-assertion ceilings the failure surface, not
// the overall budget. Passing runs never approach this.
test.setTimeout(150_000);

const DISPATCH_TEXT = 'dispatched through the pipeline';

// Closed in teardown, not inline, so a failing assertion never leaks a context.
const openContexts: BrowserContext[] = [];

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.afterEach(async () => {
  await Promise.all(openContexts.map((c) => c.close()));
  openContexts.length = 0;
});

test.describe('dispatch harness smoke (passing — pins the fixtures)', () => {
  test('a page-chat dispatch persists both sides of the turn (visible after reload)', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const pageId = await createAgentPage(user.driveId, user.userId);
    const conversationId = await seedChatConversation(pageId, user.userId, {
      contents: ['seeded question', 'seeded answer'],
    });

    const { context, page } = await openChatPane(browser, user, baseURL!, user.driveId, pageId);
    openContexts.push(context);

    // The pane really opened on the seeded conversation — otherwise the reload assertion
    // below could pass against the wrong transcript.
    await expect(
      page.getByTestId('session-chat').getByTestId('chat-message').filter({ hasText: 'seeded question' }),
    ).toBeVisible();

    await dispatchMessage(request, user, conversationId, DISPATCH_TEXT, { agentPageId: pageId });

    // TODAY the open pane stays blank (the Phase 2 gap — asserted as fixme below). What DOES
    // hold today, and what this smoke pins: after a manual reload the dispatched user turn
    // and the mock's assistant reply ('pong') are both there. The retry loop absorbs the gap
    // between the buffered stream ending and the route's onFinish committing the terminal row.
    await expect(async () => {
      await page.reload();
      await page.getByTestId('session-chat').waitFor({ state: 'visible' });
      const rendered = await renderedMessages(page);
      expect(rendered.some((m) => m.role === 'user' && m.text.includes(DISPATCH_TEXT))).toBe(true);
      expect(rendered.some((m) => m.role === 'assistant' && m.text.includes('pong'))).toBe(true);
    }).toPass({ timeout: 60_000 });
  });

  test('a global-assistant dispatch persists through the front door (messages API)', async ({
    request,
  }) => {
    const user = await seedUser();
    const conversationId = await createGlobalConversation(user.userId);

    await dispatchMessage(request, user, conversationId, DISPATCH_TEXT);

    // API-level readback (the global-assistant pane has no seeded-page helper yet): both
    // sides of the turn are on the transcript. Poll: the terminal write lands in onFinish.
    await expect
      .poll(
        async () => {
          const res = await sessionGet(request, `/api/ai/global/${conversationId}/messages`, user);
          if (!res.ok()) return `HTTP ${res.status()}`;
          const { messages } = (await res.json()) as {
            messages: Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>;
          };
          const textOf = (m: { parts?: Array<{ text?: string }> }) =>
            (m.parts ?? []).map((p) => p.text ?? '').join(' ');
          const hasUser = messages.some((m) => m.role === 'user' && textOf(m).includes(DISPATCH_TEXT));
          const hasAssistant = messages.some((m) => m.role === 'assistant' && textOf(m).trim().length > 0);
          return hasUser && hasAssistant ? 'both sides present' : `only: ${messages.map((m) => m.role).join(',')}`;
        },
        { timeout: 60_000 },
      )
      .toBe('both sides present');
  });
});

test.describe('blank-pane repro (fixme until epic Phase 2 / plan PR 3)', () => {
  // KNOWN RED TODAY — this is the epic's canonical bug, kept as an executable spec: nothing
  // broadcasts on message persistence, `chat:user_message` is gated on `isShared`, and cache
  // handlers early-return for unloaded conversations. PR 3 deletes the `.fixme` and this
  // becomes the gate.
  test.fixme('a server dispatch into an open pane renders live without reload', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const pageId = await createAgentPage(user.driveId, user.userId);
    const conversationId = await seedChatConversation(pageId, user.userId, {
      contents: ['seeded question', 'seeded answer'],
    });

    const { context, page } = await openChatPane(browser, user, baseURL!, user.driveId, pageId);
    openContexts.push(context);
    const bubbles = page.getByTestId('session-chat').getByTestId('chat-message');
    await expect(bubbles.filter({ hasText: 'seeded question' })).toBeVisible();

    await dispatchMessage(request, user, conversationId, DISPATCH_TEXT, { agentPageId: pageId });

    // NO reload between dispatch and these assertions — that is the entire point.
    await expect(bubbles.filter({ hasText: DISPATCH_TEXT })).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: 'pong' }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test.fixme('two windows on one conversation both see both sides of a dispatched turn live', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const pageId = await createAgentPage(user.driveId, user.userId);
    const conversationId = await seedChatConversation(pageId, user.userId, {
      contents: ['seeded question', 'seeded answer'],
    });

    const { contexts, pages } = await openTwoWindows(browser, user, baseURL!, user.driveId, pageId);
    openContexts.push(...contexts);
    for (const p of pages) {
      await expect(
        p.getByTestId('session-chat').getByTestId('chat-message').filter({ hasText: 'seeded question' }),
      ).toBeVisible();
    }

    await dispatchMessage(request, user, conversationId, DISPATCH_TEXT, { agentPageId: pageId });

    // Both windows, both sides, live — no reload in either window.
    for (const p of pages) {
      const bubbles = p.getByTestId('session-chat').getByTestId('chat-message');
      await expect(bubbles.filter({ hasText: DISPATCH_TEXT })).toBeVisible({ timeout: 15_000 });
      await expect(
        p.getByTestId('session-chat').locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: 'pong' }),
      ).toBeVisible({ timeout: 15_000 });
    }
  });
});
