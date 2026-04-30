const TAB_ID_KEY = 'ps-tab-id';

export const getTabId = (): string => {
  if (typeof sessionStorage === 'undefined') return 'ssr';
  const stored = sessionStorage.getItem(TAB_ID_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem(TAB_ID_KEY, id);
  return id;
};
