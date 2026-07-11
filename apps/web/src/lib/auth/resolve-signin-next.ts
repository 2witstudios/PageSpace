import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from './url-utils';

/**
 * Resolves where signin should return the user after a successful sign-in.
 *
 * Two ways in, because there are two ways to reach the signin page:
 *
 * - A redirect to `/auth/signin?next=…` — the normal web flow. `paramNext` wins.
 * - A middleware *rewrite* at `/dashboard/…` — how the iOS shell reaches signin
 *   without being punted to Safari (see middleware.ts). The browser URL stays on
 *   the dashboard deep link, and `useSearchParams` reads the browser URL, so the
 *   `next=` on the rewrite destination is invisible to the client. The path the
 *   page is sitting on IS the deep link, so `browserPath` carries it instead.
 *
 * Anything outside the signin surface's allowlist is dropped rather than trusted,
 * which is also what makes the browserPath fallback inert on a real /auth/signin
 * URL: '/auth/signin' is not an allowed next target.
 */
export function resolveSigninNext(input: {
  paramNext: string | null | undefined;
  browserPath: string | null | undefined;
}): string | undefined {
  const raw = input.paramNext ?? input.browserPath;

  return isSafeNextPath({ path: raw, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
    ? (raw as string)
    : undefined;
}
