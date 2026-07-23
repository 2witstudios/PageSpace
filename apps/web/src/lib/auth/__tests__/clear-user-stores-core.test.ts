import { describe, expect, test } from 'vitest';
import {
  computeKeysToClear,
  LEGACY_STORAGE_KEYS,
  USER_SPECIFIC_STORAGE_KEYS,
} from '../clear-user-stores-core';

describe('computeKeysToClear', () => {
  test('given no previous user, should clear only legacy keys', () => {
    expect(computeKeysToClear(null, 'user-a')).toEqual([...LEGACY_STORAGE_KEYS]);
  });

  test('given an empty previous user id, should clear only legacy keys', () => {
    expect(computeKeysToClear('', 'user-a')).toEqual([...LEGACY_STORAGE_KEYS]);
  });

  test('given the same user, should clear only legacy keys', () => {
    expect(computeKeysToClear('user-a', 'user-a')).toEqual([...LEGACY_STORAGE_KEYS]);
  });

  test('given a different user, should clear legacy and user-specific keys', () => {
    expect(computeKeysToClear('user-a', 'user-b')).toEqual([
      ...LEGACY_STORAGE_KEYS,
      ...USER_SPECIFIC_STORAGE_KEYS,
    ]);
  });

  test('given the deleted open-tabs store, should treat its key as legacy, not user-specific', () => {
    expect(LEGACY_STORAGE_KEYS).toContain('open-tabs-storage');
    expect(USER_SPECIFIC_STORAGE_KEYS).not.toContain('open-tabs-storage');
  });
});
