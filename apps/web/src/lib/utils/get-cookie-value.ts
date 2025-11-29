/**
 * Safe cookie value extraction utilities
 * Properly handles values containing '=' and URL-encoded characters
 */

/**
 * Client-side cookie extraction from document.cookie
 *
 * @param name - The name of the cookie to retrieve
 * @returns The cookie value, or null if not found or on server-side
 *
 * @example
 * const token = getCookieValue('accessToken');
 */
export function getCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null;

  try {
    const cookies = document.cookie.split(';');
    const cookie = cookies.find(c => c.trim().startsWith(`${name}=`));
    if (!cookie) return null;

    // Use substring to handle values containing '=' characters
    // e.g., "token=abc=123" → "abc=123" (split would only give "abc")
    const value = cookie.substring(cookie.indexOf('=') + 1);
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Server-side cookie extraction from a cookie header string
 *
 * @param cookieHeader - The raw Cookie header string (from request.headers.get('cookie'))
 * @param name - The name of the cookie to retrieve
 * @returns The cookie value, or null if not found
 *
 * @example
 * const cookieHeader = request.headers.get('cookie');
 * const token = getCookieValueFromHeader(cookieHeader, 'accessToken');
 */
export function getCookieValueFromHeader(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;

  try {
    const cookies = cookieHeader.split(';');
    const cookie = cookies.find(c => c.trim().startsWith(`${name}=`));
    if (!cookie) return null;

    // Use substring to handle values containing '=' characters
    const value = cookie.substring(cookie.indexOf('=') + 1);
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
