import { describe, expect, test, beforeEach } from 'vitest';
import { clearStoresIfUserChanged } from '../clear-user-stores';

const LAST_USER_KEY = 'ps-last-user-id';

const USER_SPECIFIC_KEYS = [
  'drive-storage',
  'favorites-storage',
  'tabs-storage',
  'open-tabs-storage',
  'ui-store',
  'mcp-settings',
  'pagespace:sidebar:selectedAgentData',
];

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

  test('given the same user logs in again, should not clear any stores', () => {
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
});
