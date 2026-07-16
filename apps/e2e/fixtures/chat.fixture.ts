import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Chat UI fixtures (7.0c).
 *
 * The shared `storageState.json` user from global-setup is NOT usable for chat specs: it is
 * created with the factory default `currentAiProvider: 'openai'`, so its AI calls never
 * reach the mock OpenRouter. Chat specs seed their OWN user via `seedUser()` (which defaults
 * to openrouter) and turn that user's session token into a logged-in browser context with
 * `authedContext` below — the same opt-out-of-storageState pattern the metering specs use,
 * which also keeps specs order-independent under `workers: 1`.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A logged-in browser context for a `seedUser()` session token.
 *
 * The cookie mirrors the exact shape global-setup writes into storageState (name `session`,
 * httpOnly, sameSite Strict, domain from baseURL, secure only on https) — that shape IS the
 * contract; drift here shows up as an unexplained redirect to /signin.
 *
 * Opening TWO contexts on the same token is expected and safe (7.4 does exactly that): the
 * per-tab identity the app dedups on is the client-generated `X-Browser-Session-Id`, which
 * each context generates independently.
 */
export async function authedContext(
  browser: Browser,
  sessionToken: string,
  baseURL: string,
): Promise<BrowserContext> {
  const url = new URL(baseURL);
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'session',
      value: sessionToken,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Strict',
      expires: Math.floor((Date.now() + SESSION_TTL_MS) / 1000),
    },
  ]);
  return context;
}

/** Route for an AI_CHAT page. */
export function chatPageUrl(driveId: string, pageId: string): string {
  return `/dashboard/${driveId}/${pageId}`;
}

/** Navigate to a seeded AI_CHAT page and wait for the chat surface to mount. */
export async function gotoChatPage(page: Page, driveId: string, pageId: string): Promise<void> {
  await page.goto(chatPageUrl(driveId, pageId));
  await page.getByTestId('ai-chat-view').waitFor({ state: 'visible' });
}
