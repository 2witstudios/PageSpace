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
 * Dispatch + multiplayer harness specs — Agent-Session Single Source of Truth epic.
 * Full rationale and the phase → spec mapping live in the header of
 * `fixtures/dispatch.fixture.ts`.
 *
 * Two tiers:
 *  - the smokes pin the harness (dispatch really writes through the pipeline);
 *  - the live-delivery specs below WERE `test.fixme` — the epic's canonical bug written as
 *    an executable spec. Phase 2 (plan PR 3) flipped them: the fixmes are deleted and these
 *    are now the gate. PRs 7 and 12 re-verify them.
 *
 * They assert LIVE delivery, so they need the realtime server running and wired to the web
 * process (`INTERNAL_REALTIME_URL` + a shared `REALTIME_BROADCAST_SECRET`) — unlike the
 * smokes, which are satisfiable without it.
 *
 * RUN REALTIME ON THE SAME ORIGIN AS THE APP. This is the one piece of local setup that
 * fails silently rather than loudly. The production CSP is `connect-src 'self' ws: wss:`
 * (`apps/web/src/middleware/security-headers.ts`), and Socket.IO opens with an XHR POLLING
 * handshake before it upgrades to a websocket — so pointing `NEXT_PUBLIC_REALTIME_URL` at a
 * different origin (the obvious `http://127.0.0.1:3001` while the app serves :3000) gets that
 * handshake blocked by CSP and NO socket connects at all. Production does not hit this because
 * Traefik path-routes `/socket.io` to the realtime service on the app's own host
 * (`infrastructure/docker-compose.tenant.yml`), which `'self'` covers. Mirror that locally:
 * put a reverse proxy on one port that forwards `/socket.io` (including the upgrade) to the
 * realtime server and everything else to the web server, and leave `NEXT_PUBLIC_REALTIME_URL`
 * UNSET so the socket store falls back to same-origin. Do not "fix" it by relaxing the CSP or
 * by setting `bypassCSP` on the context — both make the run stop testing the shipped policy.
 *
 * VERIFY THE SOCKET IS REALLY CARRYING THESE ASSERTIONS, because a dead socket can still let a
 * spec pass off the mount-time load. Two checks: realtime at `LOG_LEVEL=debug` must log
 * `User joined conversation room` for `conv:<id>`, and the specs must FAIL with the realtime
 * server stopped.
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

  // Both surfaces, same assertion, same expected transcript — the parity evidence for the
  // chat route consolidation (epic "Agent-Session Single Source of Truth", Phase 5).
  //
  //  - `legacy-global` is `POST /api/ai/global/<id>/messages`, the URL every deployed client
  //    still calls. It must keep working byte-for-byte; nothing about it may change.
  //  - `pipeline` is `POST /api/ai/chat` with no `chatId`, which is what
  //    `dispatchThroughChatPipeline` now sends for EVERY worker. It reaches the same
  //    global-assistant strategy because the pipeline keys on the conversation, not the URL.
  for (const surface of ['legacy-global', 'pipeline'] as const) {
    test(`a global-assistant dispatch persists through the ${surface} surface (messages API)`, async ({
      request,
    }) => {
      const user = await seedUser();
      const conversationId = await createGlobalConversation(user.userId);

      await dispatchMessage(request, user, conversationId, DISPATCH_TEXT, { surface });

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
  }
});

test.describe('blank-pane repro (the Phase 2 gate — was fixme, now green)', () => {
  // This was the epic's canonical bug: nothing broadcast on message persistence,
  // `chat:user_message` was gated on `isShared`, the client dropped
  // `startedBySomeoneElse && !isShared`, and every cache handler early-returned for a
  // conversation it had not already loaded. Phase 2 closed all four — every durable write
  // emits a rev-carrying `conversation:*` event to `conv:<id>`, the pane subscribes to that
  // room on open, and `useConversationSubscription` ensures a cache entry BEFORE joining, so
  // the `hasEntry` gate is unnecessary rather than merely removed.
  test('a server dispatch into an open pane renders live without reload', async ({
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

  test('two windows on one conversation both see both sides of a dispatched turn live', async ({
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
