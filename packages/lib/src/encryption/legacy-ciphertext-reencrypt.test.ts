/** Tests for planLegacyCiphertextReencrypt and looksLegacyEncrypted. */
import { describe, it, expect, beforeAll } from 'vitest';
import { decrypt } from './encryption-utils';
import { looksEncrypted, looksLegacyEncrypted } from './field-crypto';
import { planLegacyCiphertextReencrypt } from './legacy-ciphertext-reencrypt';
import { legacyEncrypt as legacyEncryptWith } from './__tests__/legacy-envelope-fixture';

const MASTER = 'reencrypt-test-master-key-at-least-32-chars!';
const legacyEncrypt = (plaintext: string): string => legacyEncryptWith(MASTER, plaintext);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = MASTER;
});

describe('looksLegacyEncrypted', () => {
  it('is true for the 4-part legacy envelope and false for fast/plaintext', () => {
    expect(looksLegacyEncrypted(legacyEncrypt('a@b.com'))).toBe(true);
    expect(looksLegacyEncrypted('a@b.com')).toBe(false);
    expect(looksLegacyEncrypted(null)).toBe(false);
  });
});

describe('planLegacyCiphertextReencrypt', () => {
  it('given a legacy row, should re-encrypt to fast format with a byte-identical plaintext round-trip', async () => {
    const email = 'Legacy@Example.com';
    const name = 'Legacy User';
    const oldEmail = legacyEncrypt(email);
    const oldName = legacyEncrypt(name);

    const update = await planLegacyCiphertextReencrypt({ id: 'u1', email: oldEmail, name: oldName });

    expect(update).not.toBeNull();
    expect(update!.id).toBe('u1');
    // New envelopes are the fast 3-part format, not the legacy 4-part one.
    expect(update!.email.split(':')).toHaveLength(3);
    expect(update!.name.split(':')).toHaveLength(3);
    expect(looksEncrypted(update!.email)).toBe(true);
    expect(looksEncrypted(update!.name)).toBe(true);
    // decrypt(new) === decrypt(old) === original plaintext.
    expect(await decrypt(update!.email)).toBe(email);
    expect(await decrypt(update!.name)).toBe(name);
    expect(await decrypt(oldEmail)).toBe(email);
    expect(await decrypt(oldName)).toBe(name);
  });

  it('given a row already in fast format, should skip (idempotent)', async () => {
    const first = await planLegacyCiphertextReencrypt({
      id: 'u1',
      email: legacyEncrypt('a@b.com'),
      name: legacyEncrypt('A'),
    });
    const rerun = await planLegacyCiphertextReencrypt({
      id: 'u1',
      email: first!.email,
      name: first!.name,
    });
    expect(rerun).toBeNull();
  });

  it('given a plaintext row, should skip — encrypting plaintext is the original backfill\'s job', async () => {
    const update = await planLegacyCiphertextReencrypt({ id: 'u2', email: 'plain@b.com', name: 'Plain' });
    expect(update).toBeNull();
  });

  it('given a mixed row (legacy email, fast name), should convert only the legacy field', async () => {
    const converted = await planLegacyCiphertextReencrypt({
      id: 'u3',
      email: legacyEncrypt('mixed@b.com'),
      name: legacyEncrypt('Mixed'),
    });
    const fastName = converted!.name;

    const update = await planLegacyCiphertextReencrypt({
      id: 'u3',
      email: legacyEncrypt('mixed@b.com'),
      name: fastName,
    });
    expect(update).not.toBeNull();
    expect(update!.email.split(':')).toHaveLength(3);
    expect(await decrypt(update!.email)).toBe('mixed@b.com');
    // Untouched field is passed through unchanged, not re-encrypted.
    expect(update!.name).toBe(fastName);
  });

  it('given tampered legacy ciphertext, should throw (surfaced as an error count by the runner)', async () => {
    const good = legacyEncrypt('x@y.com');
    const parts = good.split(':');
    // Flip the auth tag so GCM authentication fails.
    parts[2] = parts[2].replace(/^./, parts[2].startsWith('0') ? '1' : '0');
    const tampered = parts.join(':');

    await expect(
      planLegacyCiphertextReencrypt({ id: 'u4', email: tampered, name: legacyEncrypt('X') }),
    ).rejects.toThrow();
  });
});
