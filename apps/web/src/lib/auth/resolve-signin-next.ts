import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from './url-utils';

const isAllowed = (path: string | null | undefined): boolean =>
  isSafeNextPath({ path, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES });

/**
 * Drops a `next` query param from a path, keeping everything else.
 *
 * The browser path is only consulted when the `next` on it was already rejected, so
 * carrying that rejected value along would just make the reconstructed path fail
 * validation in turn — costing the user the deep link *and* the rest of their query.
 * Mirrors what buildSigninUrl does server-side in middleware.ts.
 */
function stripNextParam(path: string): string {
  try {
    const url = new URL(path, 'https://pagespace.invalid');
    if (url.hostname !== 'pagespace.invalid') return path; // off-origin: let validation reject it
    url.searchParams.delete('next');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return path;
  }
}

/**
 * Resolves where signin should return the user after a successful sign-in.
 *
 * Two ways in, because there are two ways to reach the signin page:
 *
 * - A redirect to `/auth/signin?next=…` — the normal web flow. A valid `paramNext` wins.
 * - A middleware *rewrite* at `/dashboard/…` — how the iOS shell reaches signin without
 *   being punted to Safari (see middleware.ts). The browser URL stays on the dashboard
 *   deep link, and `useSearchParams` reads the browser URL, so the `next=` on the rewrite
 *   destination is invisible to the client. The path the page is sitting on IS the deep
 *   link, so `browserPath` carries it instead.
 *
 * An *invalid* `paramNext` must not shadow the fallback: under a rewrite the browser URL
 * can carry a junk `?next=` of its own (which middleware already rejected), and treating
 * its mere presence as authoritative would throw away a perfectly good deep link.
 *
 * Anything outside the signin surface's allowlist is dropped from either source, which is
 * also what makes the fallback inert on a real /auth/signin URL: '/auth/signin' is not an
 * allowed next target, so the normal web flow is unchanged.
 *
 * HYDRATION: resolves to `undefined` until `browserPath` is known — i.e. until mount —
 * INCLUDING when `paramNext` is present and valid. That is deliberate. `useSearchParams`
 * does not agree with itself across the hydration boundary under a rewrite: the server
 * renders this page at the rewrite *destination* (`/auth/signin?next=…`, so it sees the
 * param) while the browser is at `/dashboard/…` (so it does not). `nextPath` reaches the
 * DOM — it is rendered into the signup link's href — so a disagreement there is a real
 * hydration mismatch. Gating on a browser-only value forces SSR and the first client
 * render to agree on `undefined`; the true value arrives on the render after mount, from
 * whichever source applies.
 */
export function resolveSigninNext(input: {
  paramNext: string | null | undefined;
  browserPath: string | null | undefined;
}): string | undefined {
  const { paramNext, browserPath } = input;

  if (!browserPath) return undefined;
  if (paramNext && isAllowed(paramNext)) return paramNext;

  const fallback = stripNextParam(browserPath);

  return isAllowed(fallback) ? fallback : undefined;
}
