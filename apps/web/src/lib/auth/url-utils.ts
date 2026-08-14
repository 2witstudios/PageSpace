function containsProtocol(s: string): boolean {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === ':') {
      const c = s.charCodeAt(i - 1);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validates that a return URL is a safe same-origin path.
 * Prevents open redirect attacks by ensuring the URL:
 * - Is a relative path starting with / (never `//` or `/\`, raw or once-decoded)
 * - Parses against a fixed base to that base's exact origin with no embedded
 *   credentials — this is the authoritative guard: it rejects absolute URLs,
 *   `javascript:`/`data:` schemes, protocol-relative forms, and WHATWG
 *   backslash tricks (`\` counts as `/` in special schemes, so `/\evil.com`
 *   parses off-origin)
 * - Carries no scheme-shaped `letter:` sequence in the *path* portion, raw or
 *   once-decoded
 *
 * Query and fragment values are deliberately NOT scanned for protocols: they
 * may legitimately carry percent-encoded absolute URLs (the OAuth consent
 * page's loopback `redirect_uri`, e.g. `?redirect_uri=http%3A%2F%2F127.0.0.1...`).
 * Every consumer navigates with the raw string, and browsers never
 * percent-decode before parsing scheme/host, so an encoded colon in a query
 * value can never become a scheme or authority.
 */
export function isSafeReturnUrl(url: string | undefined): boolean {
  if (!url) return true; // undefined/empty falls back to /dashboard
  if (!url.startsWith('/')) return false;
  if (url.startsWith('//') || url.startsWith('/\\')) return false;

  let parsed: URL;
  try {
    parsed = new URL(url, 'https://pagespace.invalid');
  } catch {
    return false;
  }
  if (parsed.origin !== 'https://pagespace.invalid') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;

  // The URL parser accepts a colon inside a path segment (`/javascript:x`),
  // which some downstream sinks could still mis-treat as a scheme — so the
  // path portion (everything before the first `?`/`#`) additionally gets the
  // protocol scan, both raw and once-decoded.
  const queryOrFragment = url.search(/[?#]/);
  const rawPath = queryOrFragment === -1 ? url : url.slice(0, queryOrFragment);
  if (containsProtocol(rawPath)) return false;
  try {
    const decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.startsWith('//') || decodedPath.startsWith('/\\')) return false;
    if (containsProtocol(decodedPath)) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Allowlist for `next=` redirect targets accepted on the signin surface
 * (passkey login, magic-link send/verify). Single source of truth so the
 * three boundaries that re-validate (form, send route, verify route) cannot
 * drift apart and accidentally widen — or narrow — the redirect surface.
 *
 * Invite acceptance does NOT use `next=` — it travels server-side as
 * `inviteToken` bound to the verification token / passed in the auth-route
 * body, mirroring the OAuth `state.inviteToken` pattern. Adding `/invite/`
 * here would re-introduce the URL-fragility this allowlist was designed to
 * mitigate.
 */
export const SIGNIN_NEXT_ALLOWED_PREFIXES = ['/dashboard', '/account', '/s/', '/oauth/consent', '/activate'] as const;

/**
 * Validates that a `next=` redirect target is both same-origin (composed via
 * `isSafeReturnUrl`) AND begins with one of the caller's allowed path
 * prefixes. URL-normalises the path first so `..` segments cannot escape the
 * allowlist (e.g. `/dashboard/../etc` resolves to `/etc` and is rejected).
 *
 * Unlike `isSafeReturnUrl`, undefined/empty input returns false: callers
 * should fall through to their own default rather than rely on an implicit
 * one.
 */
export function isSafeNextPath(input: {
  path: string | null | undefined;
  allowedPrefixes: readonly string[];
}): boolean {
  const { path, allowedPrefixes } = input;
  if (typeof path !== 'string' || path.length === 0) return false;
  if (!isSafeReturnUrl(path)) return false;

  let normalized: string;
  try {
    const u = new URL(path, 'https://pagespace.invalid');
    if (u.hostname !== 'pagespace.invalid') return false;
    normalized = `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return false;
  }

  return allowedPrefixes.some((prefix) => {
    const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    // A prefix of '/' (which strips to '') means "the root path exactly", not
    // "any path" — without this guard `normalized.startsWith('/')` matches
    // every same-origin path and silently degrades the allowlist to a no-op.
    if (p === '') return normalized === '/';
    return (
      normalized === p ||
      normalized.startsWith(`${p}/`) ||
      normalized.startsWith(`${p}?`) ||
      normalized.startsWith(`${p}#`)
    );
  });
}
