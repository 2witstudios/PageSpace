import { session } from 'electron';
import { getAppOrigin } from './app-url';
import { logger } from './logger';
import { getOrLoadSession } from './auth-session';

/** apps/web's session cookie name (apps/web/src/lib/auth/cookie-config.ts). */
export const SESSION_COOKIE_NAME = 'session';

/**
 * How long the cookie jar keeps the session cookie: the lifetime of a desktop
 * session (device refresh mints 90-day sessions). The server validates the
 * token on every request, so outliving a shorter session is harmless; expiring
 * BEFORE the session is not.
 *
 * It used to be 7 days. The classic app never noticed, because the shell
 * authenticates its API calls with the Bearer token and web's middleware
 * exempts Electron page loads from the cookie check. Imago cannot: it renders
 * on the server and reads only the cookie. So a week after sign-in, /imago
 * redirected to /auth/signin, whose silent recovery found the live Bearer
 * session and sent the user straight back to /imago — a redirect loop that
 * left the window blank.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** PURE. The cookie the shell writes for `sessionToken` on `appOrigin`. */
export function buildSessionCookie(
  appOrigin: string,
  sessionToken: string,
  nowMs: number,
): Electron.CookiesSetDetails {
  return {
    url: appOrigin,
    name: SESSION_COOKIE_NAME,
    value: sessionToken,
    path: '/',
    httpOnly: true,
    // Plain-http LAN and localhost origins cannot carry a Secure cookie.
    secure: appOrigin.startsWith('https:'),
    sameSite: 'strict',
    expirationDate: Math.floor(nowMs / 1000) + SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}

/**
 * Write the session cookie into the window's cookie jar so page loads carry
 * the same credential the API calls do. Never throws: the Bearer path still
 * works without the cookie, so a failure here must not fail a sign-in.
 */
export async function setSessionCookie(sessionToken: string): Promise<void> {
  try {
    await session.defaultSession.cookies.set(
      buildSessionCookie(getAppOrigin(), sessionToken, Date.now()),
    );
  } catch (error) {
    logger.warn('[Auth] Failed to set session cookie', { error });
  }
}

/**
 * Re-write the session cookie from the stored session, so the cookie jar holds
 * the credential the API calls use even when the jar's copy expired or was
 * lost while the app was closed. Run before the window loads: server-rendered
 * pages (imago) authenticate the document request by the cookie alone.
 */
export async function restoreSessionCookie(): Promise<void> {
  const session = await getOrLoadSession();
  if (session?.sessionToken) {
    await setSessionCookie(session.sessionToken);
  }
}
