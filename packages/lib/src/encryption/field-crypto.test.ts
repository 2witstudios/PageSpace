/**
 * Field-encryption helper tests (GDPR #965, Phase 1).
 *
 * encryptField/decryptField wrap the existing random AES-256-GCM
 * encrypt/decrypt with rollout-safe semantics: legacy plaintext passes
 * through unchanged so reads work mid-backfill, and empty/null values are
 * never encrypted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptField, decryptField, decryptFieldValuesOnce, looksEncrypted } from './field-crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-characters!!';
});

describe('looksEncrypted', () => {
  it('given a current-format ciphertext (iv:authTag:ciphertext, 3 parts), should return true', async () => {
    const ct = await encryptField('secret');
    expect((ct as string).split(':').length).toBe(3);
    expect(looksEncrypted(ct as string)).toBe(true);
  });

  it('given a legacy-shaped ciphertext (salt:iv:authTag:ciphertext, 4 parts), should return true', () => {
    const legacyShaped = `${'a'.repeat(64)}:${'b'.repeat(32)}:${'c'.repeat(32)}:${'d'.repeat(10)}`;
    expect(looksEncrypted(legacyShaped)).toBe(true);
  });

  it('given legacy plaintext email, should return false', () => {
    expect(looksEncrypted('foo@bar.com')).toBe(false);
  });

  it('given an IPv6 address with 4 colon groups, should NOT be mistaken for ciphertext', () => {
    expect(looksEncrypted('fe80:abcd:1234:5678')).toBe(false);
  });

  it('given a 3-colon string with wrong-length segments, should NOT be mistaken for ciphertext', () => {
    expect(looksEncrypted('ab:cd:ef')).toBe(false);
  });
});

describe('encryptField / decryptField round-trip', () => {
  it('given a value, should round-trip back to the exact original', async () => {
    const ct = await encryptField('alice@example.com');
    expect(ct).not.toBe('alice@example.com');
    expect(await decryptField(ct)).toBe('alice@example.com');
  });

  it('given a legacy plaintext value, decryptField should return it unchanged', async () => {
    expect(await decryptField('legacy@plaintext.com')).toBe('legacy@plaintext.com');
  });

  it('given an already-encrypted value, encryptField should NOT double-encrypt', async () => {
    const ct = await encryptField('once');
    const twice = await encryptField(ct);
    expect(twice).toBe(ct);
  });

  it('given empty string, should pass through unchanged (never encrypt empty)', async () => {
    expect(await encryptField('')).toBe('');
    expect(await decryptField('')).toBe('');
  });

  it('given null/undefined, should pass through unchanged', async () => {
    expect(await encryptField(null)).toBe(null);
    expect(await encryptField(undefined)).toBe(undefined);
    expect(await decryptField(null)).toBe(null);
  });
});

describe('decryptFieldValuesOnce', () => {
  it('given ciphertext values, should return a lookup that decrypts them', async () => {
    const ctName = await encryptField('Alice');
    const ctEmail = await encryptField('alice@example.com');
    const lookup = await decryptFieldValuesOnce([ctName, ctEmail]);
    expect(lookup(ctName)).toBe('Alice');
    expect(lookup(ctEmail)).toBe('alice@example.com');
  });

  it('given the same ciphertext repeated across many rows, should decrypt it once (dedup by value)', async () => {
    const ct = await encryptField('Repeated Sender');
    const lookup = await decryptFieldValuesOnce([ct, ct, ct, ct]);
    expect(lookup(ct)).toBe('Repeated Sender');
  });

  it('given legacy plaintext values, should pass them through unchanged', async () => {
    const lookup = await decryptFieldValuesOnce(['Legacy Name', 'legacy@plaintext.com']);
    expect(lookup('Legacy Name')).toBe('Legacy Name');
    expect(lookup('legacy@plaintext.com')).toBe('legacy@plaintext.com');
  });

  it('given null/undefined lookups, should return null', async () => {
    const lookup = await decryptFieldValuesOnce([null, undefined, 'x']);
    expect(lookup(null)).toBeNull();
    expect(lookup(undefined)).toBeNull();
  });

  it('given an empty string, should pass it through unchanged', async () => {
    const lookup = await decryptFieldValuesOnce(['']);
    expect(lookup('')).toBe('');
  });

  it('given a value that was never batched, should fail closed to null (never emit raw ciphertext)', async () => {
    const batched = await encryptField('In Batch');
    const unbatched = await encryptField('Not In Batch');
    const lookup = await decryptFieldValuesOnce([batched]);
    expect(lookup(batched)).toBe('In Batch');
    expect(lookup(unbatched)).toBeNull();
  });
});
