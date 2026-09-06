/**
 * The preview-origin HANDSHAKE contract — pure: host naming, the single-use
 * grant, the host-only cookie, and the cookie rules for what a dev server
 * may set through the proxy.
 *
 * WHY A DEDICATED ORIGIN (ruling [A-preview-proxy], superseding the earlier
 * same-origin binding). Two facts made a same-origin path-prefixed proxy
 * unable to serve a real dev server: root-relative URLs (`/src/main.tsx`,
 * `/_next/static/…`, `/@vite/client`) escape any path prefix, and a document
 * served on PageSpace's own origin runs the sandbox's untrusted JS AS
 * PageSpace — the repo's own bar for author-supplied script on the app
 * origin (`canvas/preview-headers.ts`) is a CSP `sandbox` that would in turn
 * strip the cookies every authenticated subresource needs. So each holder
 * (a session or an env) gets its OWN origin, `<kind>-<holderId>.preview.<apex>`,
 * on a DEDICATED apex that shares no registrable domain with the app (see
 * `dev-preview-env.ts` for the cookie-tossing reason). Root-relative URLs
 * work because the app is at `/`; the sandbox's JS runs on a throwaway
 * origin that holds no PageSpace cookie and cannot reach PageSpace APIs with
 * credentials (cross-origin, no CORS).
 *
 * THE HANDSHAKE
 *  1. The dashboard frames `<app-origin>/api/…/preview/open`. That route is
 *     session-authenticated, runs the holder's drive gate, and — if the
 *     preview may be shown — mints a GRANT: a random 256-bit id stored with
 *     (holder, user, expiry, cookie expiry), then 302s to
 *     `https://<preview-host>/__pagespace/auth?grant=<id>`.
 *  2. The preview host's auth endpoint CONSUMES the grant exactly once (an
 *     atomic conditional update — see `dev-preview-grants-store.ts`), sets
 *     the preview cookie, and 302s to `/`.
 *  3. Every later request on the preview host presents the cookie. The
 *     cookie AUTHENTICATES (who, which holder); it never AUTHORIZES — the
 *     drive gate is re-run on EVERY request, so revoked access means the
 *     next request is refused, cookie or not (constraint 3 of the ruling).
 *
 * THE COOKIE
 *  - `__Host-` prefixed: the browser itself refuses it unless it is `Secure`,
 *    carries no `Domain` and has `Path=/` — host-only by construction, so
 *    holder A's cookie is never sendable on holder B's origin (constraint 2).
 *  - `HttpOnly`: the dev server's JS cannot read it. The proxy strips
 *    `Cookie` before forwarding, so the dev server never sees it either.
 *  - `SameSite=None; Secure; Partitioned` — NOT `Lax`/`Strict`, and this is a
 *    deliberate, documented deviation from the ruling's wording: the preview
 *    is an iframe on the app's site, and the preview host is a different
 *    site by design, so every request the frame makes is CROSS-SITE by the
 *    SameSite definition — a `Lax` or `Strict` cookie would be omitted from
 *    every subresource load and the frame would render nothing. `Partitioned`
 *    (CHIPS) is the stronger control for this shape: the cookie jar is keyed
 *    by the TOP-LEVEL site, so the cookie exists only while the preview is
 *    embedded under the app (or opened top-level on its own host), and is
 *    invisible to any other embedder. Ruled approved ([A-preview-proxy]).
 *  - DEGRADATION, stated plainly: a browser without CHIPS support ignores
 *    the `Partitioned` attribute and keeps a plain `SameSite=None` cookie —
 *    still `__Host-`, HttpOnly, Secure, short-lived, but sendable from any
 *    embedding of the preview host. That is acceptable ONLY because the
 *    cookie is never the authority: it AUTHENTICATES a (holder, user) claim,
 *    and the per-request drive/session gate (`preview-access.ts` →
 *    `decidePreviewForward`) AUTHORIZES every request from database rows.
 *    A cookie replayed from a foreign embedding still only reaches what its
 *    user may reach, and stops reaching it the moment that access is
 *    revoked. The preview response's own `frame-ancestors <app-origin>`
 *    keeps a foreign page from rendering the frame at all.
 *  - OPEN IN A NEW TAB: a partitioned jar does not travel to a top-level
 *    navigation, so the preview host sees no cookie. The host route sends a
 *    top-level document navigation back to the app origin's `/preview/open`
 *    route, which mints a FRESH grant (the previous one is spent) and runs
 *    the handshake again in that top-level context. The open routes admit a
 *    top-level navigation from any site for exactly this reason, and refuse
 *    a cross-site EMBED (`Sec-Fetch-Dest: iframe` from another site) so a
 *    foreign page cannot run the handshake inside its own frame.
 *  - Signed, stateless, short-lived: an HMAC over (holder, user, expiry) under
 *    a key DERIVED from the server-held sandbox secret with a fixed label, so
 *    the web tier (which mints) and the realtime tier (which verifies for
 *    WebSocket upgrades) agree without a new shared secret, and a cookie can
 *    never be mistaken for a sandbox session key or vice versa.
 *
 * WHAT A DEV SERVER MAY SET. The proxy passes a dev server's own `Set-Cookie`
 * through (an app under development has auth flows too) with two edits:
 * any `Domain` attribute is removed — a `Domain=preview.<apex>` cookie would
 * be sent to EVERY holder's origin, which is the cross-holder tossing the
 * host-only rule exists to prevent — and any cookie in PageSpace's own
 * `__Host-ps_` namespace is dropped, so untrusted code cannot overwrite the
 * preview cookie.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DevPreviewHolderRef } from './dev-preview-core';

// Host naming lives in the edge-safe leaf; re-exported so callers that already
// mint/verify cookies get the whole handshake contract from one module.
export { buildPreviewHost, parsePreviewHost, previewFrameSrcEntry } from './preview-host';

export const PREVIEW_COOKIE_NAME = '__Host-ps_preview';
/** Cookies in this namespace are PageSpace's; a dev server may not set them. */
const RESERVED_COOKIE_PREFIX = '__Host-ps_';
export const PREVIEW_AUTH_PATH = '/__pagespace/auth';
export const PREVIEW_GRANT_QUERY_PARAM = 'grant';
/** How long a minted grant may go unredeemed. One redirect hop; a minute is generous. */
export const PREVIEW_GRANT_TTL_MS = 60_000;
/**
 * How long a redeemed cookie authenticates before the frame must re-open.
 * MINUTES, not hours: the cookie is not yet bound to the PageSpace session
 * that minted it (see {@link PreviewCookieClaims}), so its lifetime is the
 * window in which a logged-out user's preview keeps answering. The re-mint
 * path (a cookie-less navigation is sent back to `/preview/open`) makes an
 * expiry an invisible re-handshake, so short is cheap.
 */
export const PREVIEW_COOKIE_TTL_MS = 10 * 60 * 1000;

const COOKIE_KEY_LABEL = 'pagespace:dev-preview-cookie:v1';
const TOKEN_VERSION = 'v1';
const HOLDER_ID_SHAPE = /^[a-z0-9]{1,64}$/;

// -----------------------------------------------------------------------------
// Cookie token
// -----------------------------------------------------------------------------

/**
 * What the cookie asserts. KNOWN GAP, stated here: the claims name the user
 * but NOT the PageSpace session that minted the grant, so logging out (or
 * revoking that session) does not invalidate a live preview cookie — only
 * its expiry ({@link PREVIEW_COOKIE_TTL_MS}, minutes) or a change in the
 * user's drive access (re-checked on every request) does. The follow-up is
 * to carry the minting session id here and have the per-request gather
 * check it is still valid. Key rotation: rotating `SANDBOX_SESSION_SECRET`
 * invalidates every live cookie at once (the derived key changes), which
 * self-heals through the same re-mint path — there is no rotation window.
 */
export interface PreviewCookieClaims {
  holder: DevPreviewHolderRef;
  userId: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Pure: the cookie-signing key derived from the server secret. Empty secret ⇒ empty key ⇒ every verify fails (fail closed). */
export function derivePreviewCookieKey(secret: string): Buffer {
  if (secret.length === 0) return Buffer.alloc(0);
  return createHmac('sha256', secret).update(COOKIE_KEY_LABEL).digest();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(`${TOKEN_VERSION}.${payload}`).digest();
}

/** Pure: mint the cookie value for `claims`. Throws on an empty key — minting must never produce an unverifiable token. */
export function signPreviewCookie(claims: PreviewCookieClaims, key: Buffer): string {
  if (key.length === 0) throw new Error('preview cookie key is not configured');
  const payload = b64url(JSON.stringify({ k: claims.holder.kind, h: claims.holder.id, u: claims.userId, e: claims.expiresAt }));
  return `${TOKEN_VERSION}.${payload}.${b64url(mac(key, payload))}`;
}

export type VerifyPreviewCookieResult =
  | { ok: true; claims: PreviewCookieClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'no-key' };

/** Pure: verify a cookie value. Signature is checked BEFORE the payload is trusted for anything, including expiry. */
export function verifyPreviewCookie(token: string, key: Buffer, now: Date): VerifyPreviewCookieResult {
  if (key.length === 0) return { ok: false, reason: 'no-key' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };
  const [, payload, signature] = parts;
  const expected = mac(key, payload);
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad-signature' };

  let parsed: { k?: unknown; h?: unknown; u?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    (parsed.k !== 'workspace' && parsed.k !== 'env')
    || typeof parsed.h !== 'string' || !HOLDER_ID_SHAPE.test(parsed.h)
    || typeof parsed.u !== 'string' || parsed.u.length === 0
    || typeof parsed.e !== 'number' || !Number.isFinite(parsed.e)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.e <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { holder: { kind: parsed.k, id: parsed.h }, userId: parsed.u, expiresAt: parsed.e } };
}

/** Pure: the `Set-Cookie` header that installs `token` until `expiresAt`. */
export function buildPreviewCookieHeader(token: string, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${PREVIEW_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None; Partitioned`;
}

/** Pure: the `Set-Cookie` header that removes the preview cookie. */
export function buildClearPreviewCookieHeader(): string {
  return `${PREVIEW_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`;
}

/** Pure: a minimal `Cookie` header parser (first occurrence wins; values may contain `=`). */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0 || name in out) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Pure: the preview cookie's value from a `Cookie` header, or null. */
export function readPreviewCookie(cookieHeader: string | null | undefined): string | null {
  return parseCookieHeader(cookieHeader)[PREVIEW_COOKIE_NAME] ?? null;
}

/**
 * Pure: a dev server's `Set-Cookie`, made safe to relay — or `null` when it
 * must be dropped (a cookie in PageSpace's reserved namespace). Any `Domain`
 * attribute is removed so the cookie stays host-only (see the file header).
 */
export function sanitizeUpstreamSetCookie(value: string): string | null {
  const [pair, ...attributes] = value.split(';');
  const name = pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('=')).trim();
  if (name.startsWith(RESERVED_COOKIE_PREFIX)) return null;
  const kept = attributes.map((a) => a.trim()).filter((a) => a.length > 0 && !/^domain\s*=/i.test(a));
  return [pair.trim(), ...kept].join('; ');
}

// -----------------------------------------------------------------------------
// Redirect targets
// -----------------------------------------------------------------------------

/** Pure: where the app-origin open route sends the browser once a grant is minted. */
export function buildPreviewAuthRedirect(previewHost: string, grantId: string): string {
  const url = new URL(`https://${previewHost}${PREVIEW_AUTH_PATH}`);
  url.searchParams.set(PREVIEW_GRANT_QUERY_PARAM, grantId);
  return url.toString();
}

/** Pure: the app-origin route that re-opens a holder's preview (where an unauthenticated navigation on the preview host is sent). */
export function buildPreviewOpenPath(holder: DevPreviewHolderRef, driveId: string | null): string | null {
  if (holder.kind === 'workspace') return `/api/agent-workspaces/${holder.id}/preview/open`;
  if (driveId === null) return null;
  return `/api/drives/${driveId}/envs/${holder.id}/preview/open`;
}
