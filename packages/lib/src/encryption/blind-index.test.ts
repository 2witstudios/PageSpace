/**
 * Blind-index pure-function tests (GDPR #965, Phase 1).
 *
 * A blind index is a keyed HMAC over normalized plaintext that preserves
 * equality lookups and uniqueness for columns we still need to query
 * (email, security-audit IP) while the stored value itself is random AES-GCM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const scryptSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  scryptSyncSpy.mockImplementation(actual.scryptSync);
  return { ...actual, scryptSync: scryptSyncSpy };
});

import {
  deriveIndexKey,
  computeBlindIndex,
  normalizeEmail,
  emailBlindIndex,
  __resetIndexKeyCacheForTests,
} from './blind-index';

const MASTER = 'test-master-key-at-least-32-characters-long!!';

describe('deriveIndexKey', () => {
  it('given the same master key, should derive a deterministic key', () => {
    const a = deriveIndexKey(MASTER);
    const b = deriveIndexKey(MASTER);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('given the master key, should derive a key DISTINCT from the raw master bytes (domain separation)', () => {
    const derived = deriveIndexKey(MASTER);
    expect(derived.equals(Buffer.from(MASTER, 'utf8'))).toBe(false);
  });

  it('given a short master key, should throw rather than derive a weak key', () => {
    expect(() => deriveIndexKey('too-short')).toThrow();
  });

  it('given an empty master key, should throw', () => {
    expect(() => deriveIndexKey('')).toThrow();
  });

  describe('memoization', () => {
    beforeEach(() => {
      scryptSyncSpy.mockClear();
      __resetIndexKeyCacheForTests();
    });

    it('given repeated calls with the same master key, should only run scrypt once', () => {
      const key = 'memo-test-master-key-at-least-32-chars!!';

      const a = deriveIndexKey(key);
      const b = deriveIndexKey(key);
      const c = deriveIndexKey(key);

      expect(scryptSyncSpy).toHaveBeenCalledTimes(1);
      expect(a.equals(b)).toBe(true);
      expect(b.equals(c)).toBe(true);
    });

    it('given calls with different master keys, should compute a distinct, correct key for each (not serve the wrong cache entry)', () => {
      const keyA = 'memo-test-master-key-a-at-least-32-chars!!';
      const keyB = 'memo-test-master-key-b-at-least-32-chars!!';

      const derivedA = deriveIndexKey(keyA);
      const derivedB = deriveIndexKey(keyB);
      const derivedAAgain = deriveIndexKey(keyA);

      expect(scryptSyncSpy).toHaveBeenCalledTimes(2);
      expect(derivedA.equals(derivedB)).toBe(false);
      expect(derivedA.equals(derivedAAgain)).toBe(true);
      expect(derivedA.equals(scryptSyncSpy(keyA, 'pii-blind-index-v1', 32))).toBe(true);
      expect(derivedB.equals(scryptSyncSpy(keyB, 'pii-blind-index-v1', 32))).toBe(true);
    });
  });
});

describe('computeBlindIndex', () => {
  const key = deriveIndexKey(MASTER);

  it('given the same input twice, should produce identical digests (deterministic)', () => {
    expect(computeBlindIndex('hello', key)).toBe(computeBlindIndex('hello', key));
  });

  it('given different inputs, should produce different digests', () => {
    expect(computeBlindIndex('a', key)).not.toBe(computeBlindIndex('b', key));
  });

  it('given a missing/short index key, should throw rather than hash with a weak key', () => {
    expect(() => computeBlindIndex('hello', Buffer.alloc(0))).toThrow();
    expect(() => computeBlindIndex('hello', Buffer.alloc(4))).toThrow();
  });

  it('should return lowercase hex', () => {
    expect(computeBlindIndex('hello', key)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeEmail', () => {
  it('given mixed case and surrounding whitespace, should lowercase and trim', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('emailBlindIndex', () => {
  const key = deriveIndexKey(MASTER);

  it('given emails differing only in case/whitespace, should collide', () => {
    expect(emailBlindIndex('Foo@Bar.com ', key)).toBe(emailBlindIndex('foo@bar.com', key));
  });

  it('given distinct emails, should not collide', () => {
    expect(emailBlindIndex('a@x.com', key)).not.toBe(emailBlindIndex('b@x.com', key));
  });
});
