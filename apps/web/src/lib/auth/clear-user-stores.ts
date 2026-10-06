import { computeKeysToClear, computePrefixesToClear } from './clear-user-stores-core';

const LAST_USER_KEY = 'ps-last-user-id';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;

/** Remove every key starting with one of `prefixes`. Storage that cannot list its keys is left alone. */
export function removeKeysWithPrefixes(storage: KeyValueStorage, prefixes: readonly string[]): void {
  if (prefixes.length === 0 || typeof storage.key !== 'function' || typeof storage.length !== 'number') return;
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

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

  const lastUserId = target.getItem(LAST_USER_KEY);
  for (const key of computeKeysToClear(lastUserId, newUserId)) {
    target.removeItem(key);
  }
  removeKeysWithPrefixes(target, computePrefixesToClear(lastUserId, newUserId));

  target.setItem(LAST_USER_KEY, newUserId);
}
