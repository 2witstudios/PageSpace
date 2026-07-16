import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  CONSENT_COOKIE_NAME,
  CONSENT_VERSION,
} from '../../../packages/lib/src/consent/consent-core';

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
 * `baseURL` must be passed through to `newContext`: a manually-created context does NOT
 * inherit the project's `use.baseURL`, so without it every relative `page.goto('/dashboard/…')`
 * in `gotoChatPage` fails on an invalid URL before the chat UI is ever reached. Same reason
 * `07-file-uploads.spec.ts:99` passes it.
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
  const context = await browser.newContext({ baseURL });
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
    consentCookie(url),
  ]);
  return context;
}

/**
 * Pre-record a cookie-consent decision so the banner never renders.
 *
 * This is REQUIRED for any spec that clicks the composer, not a cosmetic nicety: the banner
 * is `fixed inset-x-0 bottom-0 z-[100]` (CookieBanner.tsx) and therefore sits directly on top
 * of the chat input. Playwright refuses to click an element another node will receive the
 * pointer event for, so `chat-send` never becomes actionable and the click waits out the
 * entire test timeout — surfacing as an inscrutable hung click rather than "a banner is in
 * the way".
 *
 * Shape must match what the app writes (`cookie-utils.ts:39` / `serializeConsentState`):
 * URI-encoded JSON (single-encoded — `readCookieValue` decodes exactly once), path=/,
 * samesite=lax. Only `necessary` is granted, byte-identical to what `rejectNonEssential()`
 * produces, so these specs enable no analytics or third-party script a real rejecting user
 * would not have.
 *
 * `CONSENT_VERSION` is imported rather than pinned so a version bump keeps the cookie valid
 * and the specs keep running. Note what that does NOT buy: if a bump changes what the
 * categories MEAN, the bump flows silently into this cookie and the banner stays suppressed —
 * nothing here fails to warn you. Re-check this decision against the new semantics by hand.
 */
function consentCookie(url: URL): Parameters<BrowserContext['addCookies']>[0][number] {
  const state = {
    version: CONSENT_VERSION,
    decidedAt: new Date(0).toISOString(),
    categories: { necessary: true, analytics: false, preferences: false },
  };
  return {
    name: CONSENT_COOKIE_NAME,
    value: encodeURIComponent(JSON.stringify(state)),
    domain: url.hostname,
    path: '/',
    httpOnly: false,
    secure: url.protocol === 'https:',
    sameSite: 'Lax',
  };
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

/**
 * Type into a surface's composer and send.
 *
 * `scope` SHOULD be a surface root (`getByTestId('ai-chat-view')`, `'sidebar-chat-tab'`,
 * `'global-assistant-view'`), not the bare page. The chat surfaces mount simultaneously and
 * each renders its own composer, so with the right sidebar open an unscoped
 * `getByTestId('chat-send')` matches TWO elements and fails Playwright's strict mode.
 * (Verified live: sidebar open → unscoped `chat-textarea`/`chat-send` resolve 2 each, while
 * `sidebar-chat-tab`-scoped resolve 1.) Passing the whole `page` works only while every other
 * surface stays closed — which is true by default today, and is exactly the kind of
 * accidental precondition that breaks a later spec.
 *
 * The retry is load-bearing, not defensive padding. `ai-chat-view` becomes visible from the
 * server-rendered markup, BEFORE React has hydrated the composer — and a `fill()` that lands
 * in that window is silently discarded when React mounts its controlled input. The value
 * vanishes, Send never leaves its disabled state, and `click()` then waits out the whole test
 * timeout on an element that will never become actionable. That failure looks like a hung
 * click, which is a genuinely confusing thing to debug from a timeout alone.
 *
 * Retrying `fill` until Send actually enables makes hydration a settled precondition rather
 * than a race, with no arbitrary sleep: it proceeds the instant the composer is live. NOTE it
 * also masks the underlying product bug — a real user typing pre-hydration loses their text.
 * See the epic-level D task; if that is fixed, this retry should tighten to a single fill.
 */
export async function sendChatMessage(scope: Page | Locator, text: string): Promise<void> {
  const textarea = scope.getByTestId('chat-textarea');
  const send = scope.getByTestId('chat-send');

  await expect(async () => {
    await textarea.fill(text);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  await send.click();
}
