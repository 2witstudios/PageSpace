/**
 * Field-encryption helper tests (GDPR #965, Phase 1).
 *
 * encryptField/decryptField wrap the existing random AES-256-GCM
 * encrypt/decrypt with rollout-safe semantics: legacy plaintext passes
 * through unchanged so reads work mid-backfill, and empty/null values are
 * never encrypted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptField, decryptField, looksEncrypted } from './field-crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-characters!!';
});

describe('looksEncrypted', () => {
  it('given an AES-GCM ciphertext (salt:iv:tag:ct), should return true', async () => {
    const ct = await encryptField('secret');
    expect(looksEncrypted(ct as string)).toBe(true);
  });

  it('given legacy plaintext email, should return false', () => {
    expect(looksEncrypted('foo@bar.com')).toBe(false);
  });

  it('given an IPv6 address with 4 colon groups, should NOT be mistaken for ciphertext', () => {
    expect(looksEncrypted('fe80:abcd:1234:5678')).toBe(false);
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
