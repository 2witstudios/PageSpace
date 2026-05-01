import { describe, it, expect } from 'vitest';
import { isOwnStream } from '../isOwnStream';

describe('isOwnStream', () => {
  it('given the triggering session matches the local session, should be true', () => {
    expect(isOwnStream({ browserSessionId: 'session-A' }, 'session-A')).toBe(true);
  });

  it('given the triggering session differs from the local session, should be false', () => {
    expect(isOwnStream({ browserSessionId: 'session-A' }, 'session-B')).toBe(false);
  });

  it('given an empty local session id and a non-empty triggering session, should be false', () => {
    expect(isOwnStream({ browserSessionId: 'session-A' }, '')).toBe(false);
  });

  it('given two empty session ids, should be true (matches identity even on the SSR placeholder)', () => {
    expect(isOwnStream({ browserSessionId: '' }, '')).toBe(true);
  });
});
