import { createHash } from 'crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { consentCookie } from './chat.fixture';

/**
 * Agent Signup E2E fixtures (ADR 0008, Phase 5): a browser context with no account in it, calls
 * made FROM the page as the signed-in agent, an independent proof-of-work solver, and the ledger
 * reads the "no starter grant" and "owner pays" assertions need.
 */

/**
 * A browser context with no session, only the recorded cookie-consent decision: the banner is
 * fixed over the bottom of the viewport and would sit on top of the signup and claim buttons.
 */
export async function anonymousContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  await context.addCookies([consentCookie(new URL(baseURL))]);
  return context;
}

export interface InPageResponse {
  status: number;
  /** Parsed JSON body, or null when the body is not JSON (a stream, HTML, empty). */
  json: Record<string, unknown> | null;
  text: string;
}

/**
 * A same-origin call made by the page itself, as the signed-in agent: the browser sends its own
 * session cookie and Origin, exactly as the app's client does, and a mutating call carries the
 * CSRF token the app's `/api/auth/csrf` mints for that session.
 *
 * In the page and not through Playwright's request context because the production server marks
 * the session cookie Secure: Chromium sends Secure cookies to 127.0.0.1, Playwright's HTTP
 * context does not (see `browser-api.fixture.ts`).
 *
 * The body is read to the end, so a streamed chat response has finished (and settled) when this
 * returns.
 */
export async function inPageFetch(
  page: Page,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<InPageResponse> {
  return page.evaluate(
    async ({ target, method, body }) => {
      const headers: Record<string, string> = {};
      if (method !== 'GET') {
        const csrfRes = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
        const { csrfToken } = (await csrfRes.json()) as { csrfToken?: string };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(target, {
        method,
        credentials: 'same-origin',
        headers,
        ...(body !== undefined && { body }),
      });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
    { target: path, method: init.method ?? 'GET', body: init.json === undefined ? undefined : JSON.stringify(init.json) },
  );
}

/** The parts-shaped user message the app's own chat client sends. */
export function chatTurnBody(chatId: string, text: string, model: { provider: string; model: string }) {
  return {
    chatId,
    selectedProvider: model.provider,
    selectedModel: model.model,
    messages: [{ id: `e2e-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }],
  };
}

function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * Solve a proof-of-work challenge exactly as `/auth.md` describes it — a nonce such that
 * SHA3-256(`<challenge>:<nonce>`) has at least `difficultyBits` leading zero bits — written from
 * the recipe rather than imported from the server, so a recipe that drifts from what the server
 * verifies fails here.
 */
export function solvePowFromRecipe(challenge: string, difficultyBits: number): string {
  for (let i = 0; i < 100_000_000; i += 1) {
    const nonce = String(i);
    const digest = createHash('sha3-256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= difficultyBits) return nonce;
  }
  throw new Error(`no nonce found at ${difficultyBits} bits`);
}

/** The lazy starter-grant row the credit gate would write (`free-init-<userId>`), if any. */
export async function starterGrantRows(userId: string) {
  return db.select().from(creditLedger).where(eq(creditLedger.stripeRef, `free-init-${userId}`));
}

/** Ledger rows of one entry type on a user's personal root wallet — whoever the row names as user. */
export async function personalWalletLedger(userId: string, entryType: string) {
  const [wallet] = await db.select({ id: wallets.id }).from(wallets).where(personalRootWalletOf(userId));
  if (!wallet) return [];
  return db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.walletId, wallet.id), eq(creditLedger.entryType, entryType)));
}
