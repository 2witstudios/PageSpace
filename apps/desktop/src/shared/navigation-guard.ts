/**
 * Navigation / origin hardening (security finding H5).
 *
 * Pure, dependency-free decision helpers for the Electron main process. They
 * decide whether the renderer may navigate to a URL, whether a caller-supplied
 * `set-app-url` value is acceptable, and whether an IPC sender frame is the
 * trusted app origin. Keeping these pure makes the security decisions
 * exhaustively unit-testable; the main-process wiring stays thin.
 */

/**
 * Origins the desktop shell is allowed to load as the application. Used as the
 * allowlist for `set-app-url`. The currently-configured origin (from
 * PAGESPACE_URL) is added by the caller so env-configured deployments keep
 * working without widening the static list.
 */
export const ALLOWED_APP_ORIGINS: readonly string[] = [
  'https://pagespace.ai',
  'https://www.pagespace.ai',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function safeOrigin(value: string): string | null {
  const parsed = parseUrl(value);
  return parsed ? parsed.origin : null;
}

/**
 * True only when `targetUrl` is an http(s) URL whose origin is exactly the
 * application origin. Everything else (other origins, file://, custom schemes,
 * unparseable input) is blocked. Drives the `will-navigate` / `will-redirect`
 * guards so an XSS in the web app cannot navigate the privileged renderer to an
 * attacker-controlled origin.
 */
export function isAllowedNavigation(targetUrl: string, appOrigin: string): boolean {
  const target = parseUrl(targetUrl);
  if (!target) return false;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;

  const origin = safeOrigin(appOrigin);
  if (!origin) return false;

  return target.origin === origin;
}

/**
 * True when `url` is an http(s) URL whose origin is present in `allowlist`.
 * Allowlist entries are compared by origin so a path/query on an allowed origin
 * is accepted while lookalike hosts, downgraded protocols and custom schemes
 * are rejected.
 */
export function isAllowedAppUrl(url: string, allowlist: readonly string[]): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  return allowlist.some((allowed) => safeOrigin(allowed) === parsed.origin);
}

/**
 * True when the IPC sender frame URL is the trusted app origin. Fails closed
 * when the sender URL is missing/unparseable. Used to keep capability-bearing
 * bridge calls (raw session token, MCP exec, set-app-url) answerable only to
 * the trusted origin.
 */
export function isTrustedSenderUrl(senderUrl: string | undefined | null, appOrigin: string): boolean {
  if (!senderUrl) return false;
  return isAllowedNavigation(senderUrl, appOrigin);
}
