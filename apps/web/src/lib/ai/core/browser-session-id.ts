export const BROWSER_SESSION_ID_KEY = 'ps-browser-session-id';
const LEGACY_KEY = 'ps-tab-id';

export const getBrowserSessionId = (): string => {
  if (typeof sessionStorage === 'undefined') return 'ssr';
  const stored = sessionStorage.getItem(BROWSER_SESSION_ID_KEY);
  if (stored) return stored;
  const legacy = sessionStorage.getItem(LEGACY_KEY);
  if (legacy) {
    sessionStorage.setItem(BROWSER_SESSION_ID_KEY, legacy);
    sessionStorage.removeItem(LEGACY_KEY);
    return legacy;
  }
  const id = crypto.randomUUID();
  sessionStorage.setItem(BROWSER_SESSION_ID_KEY, id);
  return id;
};
