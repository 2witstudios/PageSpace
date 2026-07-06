/**
 * Ownership predicate for the connected-apps revoke-by-id mutation (Phase 8
 * task k58h61obmc91sn1ndngrsev5). Pure: takes an already-fetched row (or
 * null, for "not found") and the requesting user's id — never touches the
 * DB itself, so "not found" and "found but not yours" can be tested without
 * mocking anything.
 */
import { describe, it, expect } from 'vitest';
import { isGrantOwnedByUser } from '../grant-ownership';

describe('isGrantOwnedByUser', () => {
  it('returns true when the row belongs to the requesting user', () => {
    expect(isGrantOwnedByUser({ userId: 'user-a' }, 'user-a')).toBe(true);
  });

  it('returns false when the row belongs to a different user', () => {
    expect(isGrantOwnedByUser({ userId: 'user-b' }, 'user-a')).toBe(false);
  });

  it('returns false when the row does not exist (null)', () => {
    expect(isGrantOwnedByUser(null, 'user-a')).toBe(false);
  });
});
