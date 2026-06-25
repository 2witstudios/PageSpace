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

/** Build a `document.cookie` assignment string for the consent value. */
export function buildConsentCookieString(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}
