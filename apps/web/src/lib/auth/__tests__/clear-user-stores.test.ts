import { describe, expect, test, beforeEach } from 'vitest';
import { clearStoresIfUserChanged } from '../clear-user-stores';

const LAST_USER_KEY = 'ps-last-user-id';

const USER_SPECIFIC_KEYS = [
  'drive-storage',
  'favorites-storage',
  'tabs-storage',
  'ui-store',
  'mcp-settings',
  'pagespace:sidebar:selectedAgentData',
];

// Keys owned by deleted stores — purged unconditionally so stale blobs die out
// even for a user who never switches accounts (issue #2142).
const LEGACY_KEYS = ['open-tabs-storage'];

describe('clearStoresIfUserChanged', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('given a different user logs in, should clear all user-specific stores', () => {
    localStorage.setItem(LAST_USER_KEY, 'user-a');
    for (const key of USER_SPECIFIC_KEYS) {
      localStorage.setItem(key, `data-for-${key}`);
    }

    clearStoresIfUserChanged('user-b');

    for (const key of USER_SPECIFIC_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem(LAST_USER_KEY)).toBe('user-b');
  });

  test('given the same user logs in again, should not clear any user-specific stores', () => {
    localStorage.setItem(LAST_USER_KEY, 'user-a');
    for (const key of USER_SPECIFIC_KEYS) {
      localStorage.setItem(key, `data-for-${key}`);
    }

    clearStoresIfUserChanged('user-a');

    for (const key of USER_SPECIFIC_KEYS) {
      expect(localStorage.getItem(key)).toBe(`data-for-${key}`);
    }
    expect(localStorage.getItem(LAST_USER_KEY)).toBe('user-a');
  });

  test('given first login with no previous user, should not clear stores and set user key', () => {
    for (const key of USER_SPECIFIC_KEYS) {
      localStorage.setItem(key, `data-for-${key}`);
    }

    clearStoresIfUserChanged('user-a');

    for (const key of USER_SPECIFIC_KEYS) {
      expect(localStorage.getItem(key)).toBe(`data-for-${key}`);
    }
    expect(localStorage.getItem(LAST_USER_KEY)).toBe('user-a');
  });

  test('given sequential user changes, should clear on each identity switch', () => {
    clearStoresIfUserChanged('user-a');
    localStorage.setItem('drive-storage', 'a-drives');

    clearStoresIfUserChanged('user-b');
    expect(localStorage.getItem('drive-storage')).toBeNull();

    localStorage.setItem('drive-storage', 'b-drives');

    clearStoresIfUserChanged('user-a');
    expect(localStorage.getItem('drive-storage')).toBeNull();
  });

  test('given the same user logs in again, should still purge legacy store keys', () => {
    localStorage.setItem(LAST_USER_KEY, 'user-a');
    for (const key of LEGACY_KEYS) {
      localStorage.setItem(key, `stale-${key}`);
    }

    clearStoresIfUserChanged('user-a');

    for (const key of LEGACY_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  test('given first login with no previous user, should still purge legacy store keys', () => {
    for (const key of LEGACY_KEYS) {
      localStorage.setItem(key, `stale-${key}`);
    }

    clearStoresIfUserChanged('user-a');

    for (const key of LEGACY_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  test('given an injected storage, should operate on it instead of localStorage', () => {
    const store = new Map<string, string>([
      [LAST_USER_KEY, 'user-a'],
      ['drive-storage', 'a-drives'],
      ['open-tabs-storage', 'stale'],
    ]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };

    clearStoresIfUserChanged('user-b', storage);

    expect(store.get('drive-storage')).toBeUndefined();
    expect(store.get('open-tabs-storage')).toBeUndefined();
    expect(store.get(LAST_USER_KEY)).toBe('user-b');
    expect(localStorage.getItem(LAST_USER_KEY)).toBeNull();
  });
});
