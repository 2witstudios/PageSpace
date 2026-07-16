import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
// Public package export, not a reach into packages/lib/src: `@pagespace/lib` exposes
// `./consent`, and it resolves to the same built module the app under test consumes.
import {
  CONSENT_COOKIE_NAME,
  defaultConsentState,
  rejectNonEssential,
  serializeConsentState,
} from '@pagespace/lib/consent';

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
 * The decision is BUILT by the app's own `rejectNonEssential` and serialized by its own
 * `serializeConsentState`, rather than hand-rolling the state literal. That is deliberate: it
 * makes "only necessary is granted, exactly as a rejecting user gets" and "the shape matches
 * what the app writes" properties the code enforces, instead of claims a comment asserts and
 * a schema change silently breaks. `serializeConsentState` also stamps `CONSENT_VERSION` and
 * normalizes the categories, so this cookie cannot drift from the parser's gate.
 *
 * The single `encodeURIComponent` mirrors `buildConsentCookieString` (`cookie-utils.ts:39`);
 * `readCookieValue` decodes exactly once, so double-encoding here would fail the parse.
 *
 * What this does NOT buy: if a version bump changes what the categories MEAN, it flows
 * silently through and the banner stays suppressed. Re-check by hand when the semantics move.
 */
function consentCookie(url: URL): Parameters<BrowserContext['addCookies']>[0][number] {
  const decided = rejectNonEssential(defaultConsentState(), new Date(0).toISOString());
  return {
    name: CONSENT_COOKIE_NAME,
    value: encodeURIComponent(serializeConsentState(decided)),
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
 * `scope` is a surface root (`getByTestId('ai-chat-view')`, `'sidebar-chat-tab'`,
 * `'global-assistant-view'`) — a Locator, never the bare Page, so the requirement is a compile
 * error rather than a comment nobody reads. The chat surfaces mount simultaneously and each
 * renders its own composer: with the right sidebar open, an unscoped `getByTestId('chat-send')`
 * matches TWO elements and fails Playwright's strict mode. (Verified live: sidebar open →
 * unscoped `chat-textarea`/`chat-send` resolve 2 each, `sidebar-chat-tab`-scoped resolve 1.)
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
export async function sendChatMessage(scope: Locator, text: string): Promise<void> {
  const textarea = scope.getByTestId('chat-textarea');
  const send = scope.getByTestId('chat-send');

  await expect(async () => {
    await textarea.fill(text);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  await send.click();
}
