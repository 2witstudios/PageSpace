import { SIGN_IN_PATH } from './sign-in-url';

/**
 * Web's logout route. Root-relative on purpose: fetch() does not add imago's
 * basePath, and imago is served same-origin with apps/web, so this is web's
 * route. It revokes the session and clears the session cookies itself.
 */
export const LOGOUT_ENDPOINT = '/api/auth/logout';

type SignOutIO = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** A full-page navigation: sign-in is classic's page, outside imago's router. */
  navigate: (url: string) => void;
};

/**
 * Revoke the session through web's logout endpoint, then land on sign-in.
 * Lands on sign-in even when the call fails, as classic's logout does: the
 * user asked to leave, and sign-in is where a still-valid session is noticed.
 */
export async function signOut({ fetch, navigate }: SignOutIO): Promise<void> {
  try {
    await fetch(LOGOUT_ENDPOINT, { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Nothing to recover: the landing below happens either way.
  } finally {
    navigate(SIGN_IN_PATH);
  }
}
