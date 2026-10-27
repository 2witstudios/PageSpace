// apps/web wants a per-tab id on every turn (X-Browser-Session-Id), to tell a
// viewer's own tabs apart. Imago is same-origin with classic, so it keeps the
// id under classic's sessionStorage key: one tab, one id, whichever app sent.

/** classic's key (apps/web/src/lib/ai/core/browser-session-id.ts). */
export const BROWSER_SESSION_KEY = 'ps-browser-session-id';

/** This tab's id, minted on first use; sessionStorage scopes it to the tab. */
export const browserSessionId = (): string => {
  const stored = sessionStorage.getItem(BROWSER_SESSION_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem(BROWSER_SESSION_KEY, id);
  return id;
};
