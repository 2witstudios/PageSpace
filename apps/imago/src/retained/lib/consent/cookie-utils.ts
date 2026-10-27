/**
 * Pure cookie helpers for the consent store (no DOM access).
 * The store edge passes `document.cookie` in and applies the returned strings out.
 */

/** Read a single cookie value (URL-decoded) from a raw `document.cookie` string. */
export function readCookieValue(cookieString: string, name: string): string | undefined {
  if (!cookieString) return undefined;
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * Build a `document.cookie` assignment string for the consent value.
 *
 * Pass `domain` (the registrable domain, e.g. `.pagespace.ai`) so the consent cookie is
 * shared across subdomains instead of being host-only — otherwise the banner re-prompts on
 * every host change. Mirrors the theme cookie (`theme-cookie.ts`). The caller reads the
 * domain from env; this stays a pure, env-free function.
 */
export function buildConsentCookieString(
  name: string,
  value: string,
  maxAgeSeconds: number,
  domain?: string,
): string {
  const domainAttr = domain ? `; domain=${domain}` : '';
  return `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax${domainAttr}`;
}

/**
 * Build a `document.cookie` assignment that expires the LEGACY host-only consent cookie.
 *
 * When we migrate to a domain-scoped cookie (`domain=.pagespace.ai`), writing the new
 * cookie does NOT replace a pre-existing host-only cookie of the same name — the browser
 * keeps both, and `readCookieValue` may return the stale host-only one. This delete must
 * OMIT the `domain` attribute: a host-only cookie can only be cleared by a host-only
 * `Set-Cookie`, so adding `domain=` here would target the wrong (domain-scoped) cookie and
 * leave the stale value in place. The caller writes this before the new domain-scoped value.
 */
export function buildExpireHostOnlyConsentCookieString(name: string): string {
  return `${name}=; path=/; max-age=0; samesite=lax`;
}
