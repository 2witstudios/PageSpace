// Edge-safe leaf (no imports): consumed by middleware.ts, which must never
// pull in the Node-only '@/lib/auth' barrel.

/**
 * True when the request comes from the Electron desktop shell, detected by the
 * `Electron/<version>` product token Chromium appends to the shell's UA.
 *
 * Used only to relax the middleware's page-navigation signin bounce — never an
 * auth boundary. The shell navigates with cookies while its real credential
 * (the Bearer token) lives in the main process and is attached per API call,
 * so a missing session cookie says nothing about whether the desktop user is
 * authenticated. A spoofed UA therefore gains nothing: the shell pages are
 * public, and every API route still validates its own credentials.
 */
export function isElectronShell(userAgent: string | null | undefined): boolean {
  return !!userAgent && userAgent.includes('Electron/');
}
