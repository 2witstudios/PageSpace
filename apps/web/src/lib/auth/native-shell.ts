// Edge-safe leaf (no imports): consumed by middleware.ts, which must never
// pull in the Node-only '@/lib/auth' barrel.

/**
 * True when the request comes from the PageSpace Electron desktop shell,
 * detected by the `Electron/<version>` product token Chromium appends to the
 * shell's UA PLUS the app's own name token — `PageSpace/<version>` in packaged
 * builds (electron-builder `productName`) or `desktop/<version>` in dev
 * (package.json `name`); both are what `app.getName()` yields, and the desktop
 * app never overrides its UA. Requiring the app token keeps third-party
 * Electron browsers on the normal signin redirect; accepting either spelling
 * keeps every shipped AND dev shell covered — a false negative here would
 * reintroduce the desktop logout bounce, so the app-token check is
 * deliberately the OR of both known spellings.
 *
 * Used only to relax the middleware's page-navigation signin bounce — never an
 * auth boundary. The shell navigates with cookies while its real credential
 * (the Bearer token) lives in the main process and is attached per API call,
 * so a missing session cookie says nothing about whether the desktop user is
 * authenticated. A spoofed UA therefore gains nothing: the shell pages are
 * public, and every API route still validates its own credentials.
 */
export function isElectronShell(userAgent: string | null | undefined): boolean {
  if (!userAgent || !userAgent.includes('Electron/')) return false;
  return userAgent.includes('PageSpace/') || userAgent.includes('desktop/');
}
