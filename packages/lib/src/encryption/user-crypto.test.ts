/**
 * User PII encrypt/lookup/decrypt edge (GDPR #965, Phase 2).
 *
 * Proves the lookup path required by the hard gate: a user written with
 * encrypted email is still findable by email via the deterministic blind index,
 * returning the same identity the old `eq(users.email, …)` would have.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { deriveIndexKey } from './blind-index';
import { looksEncrypted } from './field-crypto';
import { encryptUserPii, decryptUserPii, emailLookupBidx, getPiiIndexKey } from './user-crypto';

const MASTER = 'user-crypto-test-master-key-32-chars-min!!';
const indexKey = deriveIndexKey(MASTER);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = MASTER;
});

describe('encryptUserPii', () => {
  it('given plaintext PII, should encrypt email and name and emit a blind index', async () => {
    const enc = await encryptUserPii({ email: 'Alice@Example.com', name: 'Alice' }, indexKey);
    expect(looksEncrypted(enc.email)).toBe(true);
    expect(looksEncrypted(enc.name)).toBe(true);
    expect(enc.emailBidx).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should never store the plaintext email or name as the column value', async () => {
    const enc = await encryptUserPii({ email: 'bob@x.com', name: 'Bob Jones' }, indexKey);
    expect(enc.email).not.toContain('bob@x.com');
    expect(enc.name).not.toContain('Bob Jones');
  });
});

describe('lookup path (the hard-gate proof)', () => {
  it('given a user written with encrypted email, should be found by email via the blind index', async () => {
    const enc = await encryptUserPii({ email: 'Carol@Example.com', name: 'Carol' }, indexKey);
    // A later login normalizes case/whitespace and looks up by blind index.
    const lookup = emailLookupBidx('  carol@example.com ', indexKey);
    expect(lookup).toBe(enc.emailBidx);
  });

  it('given a different email, should NOT collide', async () => {
    const enc = await encryptUserPii({ email: 'd1@x.com', name: 'D' }, indexKey);
    expect(emailLookupBidx('d2@x.com', indexKey)).not.toBe(enc.emailBidx);
  });
});

describe('getPiiIndexKey (env edge)', () => {
  it('given ENCRYPTION_KEY set, should derive a deterministic key', () => {
    process.env.ENCRYPTION_KEY = MASTER;
    expect(getPiiIndexKey().equals(getPiiIndexKey())).toBe(true);
  });

  it('given no ENCRYPTION_KEY, should throw', () => {
    const prev = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => getPiiIndexKey()).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = prev;
    }
  });
});

describe('decryptUserPii', () => {
  it('given an encrypted row, should round-trip back to plaintext', async () => {
    const enc = await encryptUserPii({ email: 'eve@x.com', name: 'Eve' }, indexKey);
    const dec = await decryptUserPii({ email: enc.email, name: enc.name });
    expect(dec).toEqual({ email: 'eve@x.com', name: 'Eve' });
  });

  it('given a legacy plaintext row (pre-backfill), should pass values through unchanged', async () => {
    const dec = await decryptUserPii({ email: 'legacy@x.com', name: 'Legacy User' });
    expect(dec).toEqual({ email: 'legacy@x.com', name: 'Legacy User' });
  });
});
