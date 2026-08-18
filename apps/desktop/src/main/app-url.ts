import { store } from './store';
import { APP_IDENTITY } from './app-identity';
import {
  DEVELOPMENT_ORIGIN,
  PRODUCTION_ORIGIN,
  upgradeInsecureUrl,
} from '../shared/url-policy';

const storeAny = store as any;

/**
 * The app URL has two distinct jobs, and conflating them is what previously
 * forced `getAppUrl().replace('/dashboard', '')` on the one caller that needed
 * an origin:
 *
 * - `getAppOrigin()` — the security identity of the app. Navigation guards, IPC
 *   sender trust, media permissions and the session cookie's domain all key off
 *   it, and none of them care which page the shell opens on.
 * - `getStartUrl()`  — the page the shell actually loads, which is the ONLY
 *   thing that differs between PageSpace and PageSpace Coder.
 *
 * Splitting them is what lets the coder build open on `/dashboard/agents`
 * without any of the guards above having to learn a second path.
 */

function envOrigin(): string {
  const base =
    process.env.NODE_ENV === 'development'
      ? process.env.PAGESPACE_URL || DEVELOPMENT_ORIGIN
      : process.env.PAGESPACE_URL || PRODUCTION_ORIGIN;
  return upgradeInsecureUrl(base);
}

/**
 * The origin the shell treats as the application.
 *
 * Precedence: the electron-store `appUrl` override, then `PAGESPACE_URL`, then
 * the built-in default. The stored override contributes only its ORIGIN — the
 * `set-app-url` IPC has only ever validated it by origin
 * (`isAllowedAppUrl`), so any path it carries was never checked and never
 * meaningful; the start path belongs to the app identity instead.
 *
 * Never throws and never returns an empty string: a malformed override is
 * ignored in favour of the configured environment, and unparseable environment
 * configuration falls back to production. Callers still guard on the result,
 * because a security decision should not rest on an invariant held in another
 * module.
 */
export function getAppOrigin(): string {
  const customUrl = storeAny.get('appUrl');
  if (typeof customUrl === 'string' && customUrl) {
    try {
      return new URL(upgradeInsecureUrl(customUrl)).origin;
    } catch {
      // Unusable override — fall through to the configured environment.
    }
  }

  try {
    return new URL(envOrigin()).origin;
  } catch {
    return PRODUCTION_ORIGIN;
  }
}

/** The URL the shell loads at launch: the app origin plus this app's start path. */
export function getStartUrl(): string {
  return getAppOrigin() + APP_IDENTITY.startPath;
}
