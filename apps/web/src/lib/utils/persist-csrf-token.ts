import { getCookieValue } from '@/lib/utils/get-cookie-value';

/**
 * Read the csrf_token cookie (set by server after auth) and persist it to localStorage.
 */
export function persistCsrfToken(): void {
  const token = getCookieValue('csrf_token');
  if (token) {
    try {
      localStorage.setItem('csrfToken', token);
    } catch (e) {
      console.warn('Failed to persist CSRF token:', e);
    }
  }
}
