import { computeKeysToClear } from './clear-user-stores-core';

const LAST_USER_KEY = 'ps-last-user-id';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Clear user-specific persisted stores if the user identity changed, and always
 * purge keys left behind by deleted stores. Effects are injectable for tests.
 */
export function clearStoresIfUserChanged(
  newUserId: string,
  storage?: KeyValueStorage,
): void {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!target) return;

  for (const key of computeKeysToClear(target.getItem(LAST_USER_KEY), newUserId)) {
    target.removeItem(key);
  }

  target.setItem(LAST_USER_KEY, newUserId);
}
