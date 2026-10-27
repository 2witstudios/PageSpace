export const BROWSER_SESSION_ID_KEY = 'ps-browser-session-id';

export const getBrowserSessionId = (): string => {
  if (typeof sessionStorage === 'undefined') return 'ssr';
  const stored = sessionStorage.getItem(BROWSER_SESSION_ID_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem(BROWSER_SESSION_ID_KEY, id);
  return id;
};
