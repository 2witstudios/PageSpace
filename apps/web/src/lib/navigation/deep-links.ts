/**
 * Resolving a universal link the shell handed us into an in-app route.
 *
 * The AASA at `apps/marketing/public/.well-known/apple-app-site-association`
 * decides which URLs ever reach this code. Keep the two in step: claiming a
 * path Apple sends us that this resolver returns `null` for means the link
 * stops working in Safari and does nothing in the app instead — strictly worse
 * than never claiming it.
 *
 * Deliberately an allowlist, not a general "navigate to whatever path arrived".
 * The URL is external input, and a universal link can name any path on the
 * host.
 */

/** The one host the entitlement claims (`applinks:pagespace.ai`). */
const CLAIMED_HOST = 'pagespace.ai';

/**
 * Invite tokens are a single opaque path segment — see
 * `apps/web/src/app/invite/[token]/page.tsx`, whose params are `{ token }`.
 * A token with a slash in it is not a token we issued.
 */
const INVITE_PATH = /^\/invite\/([^/]+)\/?$/;

export type DeepLinkTarget =
  /** An in-app route. Navigate with the router — never `window.location`. */
  | { kind: 'route'; path: string }
  /** Claimed but not routable here. Hand back to the browser so it completes. */
  | { kind: 'external'; url: string };

/**
 * `null` means "not ours" — the caller should ignore it rather than guess.
 *
 * Note what is *not* handled: the `pagespace://auth-exchange` custom scheme.
 * `/api/auth/desktop/exchange` redeems its code with no PKCE binding, so
 * whichever app receives the code can take a session; routing it from here
 * would extend that surface. That binding is a prerequisite, tracked
 * separately, and until it exists this resolver ignores the scheme entirely.
 */
export function resolveDeepLink(rawUrl: string): DeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== CLAIMED_HOST) return null;

  const invite = INVITE_PATH.exec(url.pathname);
  if (invite) {
    // Re-encode: the token came off the wire and goes back into a path.
    // `decodeURIComponent` throws URIError on a malformed escape (`/invite/%`),
    // and this runs during listener setup — an escaping throw would abort it and
    // leave the app with no warm-start listener for the rest of the session.
    try {
      return { kind: 'route', path: `/invite/${encodeURIComponent(decodeURIComponent(invite[1]))}` };
    } catch {
      // Not a token we could have issued. Let the browser render the error.
      return { kind: 'external', url: url.toString() };
    }
  }

  // On the claimed host but not a route we know. Never swallow it — a link the
  // app cannot complete must still complete somewhere.
  return { kind: 'external', url: url.toString() };
}
