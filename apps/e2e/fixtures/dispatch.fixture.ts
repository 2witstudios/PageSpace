import { type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createId } from '@paralleldrive/cuid2';
import type { SeededUser } from '../support/db';
import { sessionPost } from '../support/http';
import { authedContext, gotoChatPage } from './chat.fixture';

/**
 * # Dispatch + multiplayer harness (Phase 0 of the Agent-Session Single Source of Truth epic)
 *
 * The epic's canonical bug: a server-side agent dispatch (`send_session`/`spawn_session` in
 * `apps/web/src/lib/ai/tools/session-tools-runtime.ts` → `dispatchThroughChatPipeline`) POSTs
 * an internal turn through the standard chat routes. The turn persists — the DB gets the user
 * message and the assistant reply — but an OPEN pane showing that conversation stays blank:
 * nothing broadcasts on message persistence, `chat:user_message` is gated on `isShared`
 * (private by default, so your own dispatch is invisible to your own panes), and every client
 * cache handler early-returns unless it already loaded the conversation. Phase 2 (PR 3 of the
 * epic plan) fixes delivery; this harness is the executable spec Phase 2 must turn green.
 *
 * ## What lives here
 *
 * - {@link dispatchMessage} — the "second actor": a server-side message injection that mirrors
 *   `dispatchThroughChatPipeline`'s POST exactly (same routes, same body shape, same synthetic
 *   `X-Browser-Session-Id`), but authenticated through the FRONT DOOR: session cookie + the
 *   session-bound CSRF token from `seedUser()`, rather than the forwarded-header + internally
 *   minted CSRF hop the runtime does. The routes cannot tell the difference — which is the
 *   point: the persistence/broadcast path under test is identical.
 * - {@link openChatPane} / {@link renderedMessages} — open an AI_CHAT page's pane in its own
 *   browser context and read back what the pane actually rendered.
 * - {@link openTwoWindows} — two independent browser contexts (two "windows") for the same
 *   user on the same pane; each context mints its own `X-Browser-Session-Id`, so the app
 *   treats them as separate tabs.
 *
 * ## Which specs gate which phase (tests/16-dispatch-multiplayer.spec.ts)
 *
 * - PASSING today: the fixture smokes — dispatch → the turn is present after a manual reload
 *   (page-chat surface) / present via the messages API (global surface). These pin the harness
 *   itself; if they break, the fixme specs prove nothing.
 * - `test.fixme` until epic Phase 2 / PR 3 lands (delete the `.fixme` then):
 *   - blank-pane repro: a dispatch into an open pane renders live, NO reload;
 *   - two windows on one conversation both see both sides of a dispatched turn live.
 *   Phase 2's gate is exactly these two flipping green; PRs 7 and 12 re-verify them.
 */

const PAGE_CHAT_SURFACE = 'session-chat'; // page-chat surface root since phase-6 unified AgentView (see chat.fixture gotoChatPage)
const CHAT_MESSAGE = 'chat-message';

export interface DispatchOptions {
  /**
   * Target a page-anchored conversation on this AI_CHAT page — the request then carries
   * `chatId`, exactly as `dispatchThroughChatPipeline` does for a worker with an agent page.
   * Omit to target a global-assistant conversation, which carries no `chatId` and is resolved
   * from `conversationId`.
   */
  agentPageId?: string;
  /**
   * Which public URL to send through. `pipeline` (the default) is what the runtime now does
   * for EVERY worker since the chat route consolidation (epic "Agent-Session Single Source of
   * Truth", Phase 5): one internal path, and the pipeline picks the page-agent or
   * global-assistant strategy from the conversation.
   *
   * `legacy-global` is the pre-consolidation URL for a global worker. It is kept — and
   * exercised — because that URL is still public and still supported: deployed browsers, the
   * desktop app, mobile and the CLI all address it by name, so a spec proving both surfaces
   * land on the same transcript is the compat evidence.
   */
  surface?: 'pipeline' | 'legacy-global';
}

/**
 * Server-side message injection: POST one user turn into `conversationId` through the same
 * chat route an agent dispatch uses, as `user`. Resolves once the whole assistant stream has
 * been consumed (Playwright's request API buffers the full body), i.e. the model turn is over
 * — though the terminal DB write happens in the route's `onFinish` and can commit a beat
 * later, so specs asserting on persistence should poll.
 *
 * Auth surprises, documented so nobody re-derives them:
 * - Both routes REQUIRE `X-Browser-Session-Id` (400 without it). The runtime sends a
 *   synthetic `agent-dispatch-<id>`; we mirror that.
 * - CSRF: the runtime mints a token internally from the forwarded session; the front-door
 *   equivalent is `seedUser()`'s `csrf`, which `sessionPost` already sends. No Origin header
 *   is needed — `validateOrigin` allows a missing Origin.
 * - `x-agent-dispatch-depth` is deliberately NOT sent: depth only feeds the A→B→C chain cap,
 *   and the routes persist/broadcast identically either way.
 */
export async function dispatchMessage(
  request: APIRequestContext,
  user: SeededUser,
  conversationId: string,
  text: string,
  opts: DispatchOptions = {},
): Promise<void> {
  const url =
    opts.surface === 'legacy-global'
      ? `/api/ai/global/${encodeURIComponent(conversationId)}/messages`
      : '/api/ai/chat';
  const body = {
    ...(opts.agentPageId !== undefined ? { chatId: opts.agentPageId } : {}),
    conversationId,
    messages: [{ id: createId(), role: 'user', parts: [{ type: 'text', text }] }],
  };
  const res = await sessionPost(request, url, user, body, {
    'x-browser-session-id': `agent-dispatch-${createId()}`,
  });
  if (!res.ok()) {
    throw new Error(
      `dispatchMessage: ${url} answered ${res.status()}: ${(await res.text()).slice(0, 500)}`,
    );
  }
  // ok() implies the stream body was fully buffered — the assistant turn has completed.
}

/**
 * Open an AI_CHAT page's pane in a fresh logged-in context. The pane opens on the page's
 * NEWEST conversation, so seed exactly the conversation the spec wants open before calling.
 * Caller owns closing `context` (push it onto the spec's cleanup list).
 */
export async function openChatPane(
  browser: Browser,
  user: SeededUser,
  baseURL: string,
  driveId: string,
  pageId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await authedContext(browser, user.sessionToken, baseURL);
  const page = await context.newPage();
  await gotoChatPage(page, driveId, pageId);
  return { context, page };
}

export interface RenderedMessage {
  /** `data-role` of the bubble: 'user' | 'assistant' (null if the attribute is missing). */
  role: string | null;
  text: string;
}

/**
 * What the pane has actually RENDERED, in order — scoped to the page's own chat surface
 * (`session-chat`) so a sidebar chat can never leak into the reading. No auto-waiting: this
 * is a snapshot, so wrap it in `expect(...).toPass()` / `expect.poll` when asserting on
 * eventual state.
 */
export async function renderedMessages(page: Page): Promise<RenderedMessage[]> {
  const bubbles = await page.getByTestId(PAGE_CHAT_SURFACE).getByTestId(CHAT_MESSAGE).all();
  return Promise.all(
    bubbles.map(async (bubble) => ({
      role: await bubble.getAttribute('data-role'),
      text: await bubble.innerText(),
    })),
  );
}

/**
 * Two "windows": two independent logged-in contexts for the SAME user, both showing the same
 * AI_CHAT pane. Independent contexts mean independent `X-Browser-Session-Id`s — the app's
 * per-tab identity — so this is the real two-window topology, not two tabs sharing state.
 * Caller owns closing both contexts.
 */
export async function openTwoWindows(
  browser: Browser,
  user: SeededUser,
  baseURL: string,
  driveId: string,
  pageId: string,
): Promise<{ contexts: [BrowserContext, BrowserContext]; pages: [Page, Page] }> {
  const first = await openChatPane(browser, user, baseURL, driveId, pageId);
  const second = await openChatPane(browser, user, baseURL, driveId, pageId);
  return { contexts: [first.context, second.context], pages: [first.page, second.page] };
}
