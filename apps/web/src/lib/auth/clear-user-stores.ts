const LAST_USER_KEY = 'ps-last-user-id';

const USER_SPECIFIC_STORAGE_KEYS = [
  'drive-storage',
  'favorites-storage',
  'tabs-storage',
  'open-tabs-storage',
  'ui-store',
  'mcp-settings',
  'pagespace:sidebar:selectedAgentData',
] as const;

/** Clear all user-specific persisted stores if the user identity changed. */
export function clearStoresIfUserChanged(newUserId: string): void {
  if (typeof window === 'undefined') return;

  const lastUserId = localStorage.getItem(LAST_USER_KEY);

  if (lastUserId && lastUserId !== newUserId) {
    for (const key of USER_SPECIFIC_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  }

  localStorage.setItem(LAST_USER_KEY, newUserId);
}
