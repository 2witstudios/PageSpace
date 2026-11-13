/**
 * File-storage envelope-encryption codec (GDPR #966, Phase 3).
 *
 * Wraps stored object bytes with AES-256-GCM under a per-object derived data
 * key. Pure: master key passed in, no env, no I/O. Policy wrappers honor an
 * `enabled` flag so cloud (infra-disk-encrypted) is unaffected and onprem/tenant
 * opt in, while reads transparently decrypt legacy and enabled-then-disabled
 * objects via a magic-byte prefix.
 */
import { describe, it, expect } from 'vitest';
import {
  encryptBuffer,
  decryptBuffer,
  ENVELOPE_HEADER_LENGTH,
  createEnvelopeDecipher,
  hasEnvelopeMagic,
  isEnvelope,
  maybeEncryptBuffer,
  maybeDecryptBuffer,
} from '../envelope-crypto';

const KEY = 'file-master-key-at-least-32-characters-long!';
const PLAIN = Buffer.from('the quick brown fox \x00\x01\x02 binary bytes', 'utf8');

describe('encryptBuffer / decryptBuffer', () => {
  it('given a buffer, should round-trip byte-identical', () => {
    const ct = encryptBuffer(PLAIN, KEY);
    expect(ct.equals(PLAIN)).toBe(false);
    expect(decryptBuffer(ct, KEY).equals(PLAIN)).toBe(true);
  });

  it('given two encryptions of the same bytes, should differ (random per-object salt/iv)', () => {
    expect(encryptBuffer(PLAIN, KEY).equals(encryptBuffer(PLAIN, KEY))).toBe(false);
  });

  it('given a tampered auth tag/ciphertext, should throw (fail closed)', () => {
    const ct = encryptBuffer(PLAIN, KEY);
    ct[ct.length - 1] ^= 0xff;
    expect(() => decryptBuffer(ct, KEY)).toThrow();
  });

  it('given an empty buffer, should round-trip', () => {
    const ct = encryptBuffer(Buffer.alloc(0), KEY);
    expect(decryptBuffer(ct, KEY).length).toBe(0);
  });
});

describe('isEnvelope', () => {
  it('given envelope ciphertext, should be true', () => {
    expect(isEnvelope(encryptBuffer(PLAIN, KEY))).toBe(true);
  });
  it('given plaintext, should be false', () => {
    expect(isEnvelope(PLAIN)).toBe(false);
  });
  it('given a tiny buffer, should be false (no false positive)', () => {
    expect(isEnvelope(Buffer.from('hi'))).toBe(false);
  });
});

describe('maybeEncryptBuffer (policy)', () => {
  it('given encryption disabled, should pass bytes through unchanged', () => {
    expect(maybeEncryptBuffer(PLAIN, { enabled: false, masterKey: KEY }).equals(PLAIN)).toBe(true);
  });
  it('given encryption enabled, should produce an envelope', () => {
    expect(isEnvelope(maybeEncryptBuffer(PLAIN, { enabled: true, masterKey: KEY }))).toBe(true);
  });
  it('given enabled but no key, should throw rather than store plaintext silently', () => {
    expect(() => maybeEncryptBuffer(PLAIN, { enabled: true, masterKey: '' })).toThrow();
  });
});

describe('maybeDecryptBuffer (policy)', () => {
  it('given an envelope, should decrypt', () => {
    const ct = maybeEncryptBuffer(PLAIN, { enabled: true, masterKey: KEY });
    expect(maybeDecryptBuffer(ct, { masterKey: KEY }).equals(PLAIN)).toBe(true);
  });
  it('given legacy plaintext (no envelope), should pass through unchanged', () => {
    expect(maybeDecryptBuffer(PLAIN, { masterKey: KEY }).equals(PLAIN)).toBe(true);
  });
});

describe('hasEnvelopeMagic', () => {
  it('recognises an envelope from its first four bytes alone', () => {
    const env = encryptBuffer(PLAIN, KEY);
    expect(hasEnvelopeMagic(env.subarray(0, 4))).toBe(true);
    expect(hasEnvelopeMagic(PLAIN)).toBe(false);
    expect(hasEnvelopeMagic(Buffer.from('PS'))).toBe(false);
  });
});

describe('createEnvelopeDecipher', () => {
  const stream = (env: Buffer, key: string, chunk = 7) => {
    const decipher = createEnvelopeDecipher(env.subarray(0, ENVELOPE_HEADER_LENGTH), key);
    const out: Buffer[] = [];
    const body = env.subarray(ENVELOPE_HEADER_LENGTH);
    for (let i = 0; i < body.length; i += chunk) out.push(decipher.update(body.subarray(i, i + chunk)));
    out.push(decipher.final());
    return Buffer.concat(out);
  };

  it('decrypts an envelope chunk by chunk to the same plaintext as decryptBuffer', () => {
    expect(stream(encryptBuffer(PLAIN, KEY), KEY).equals(PLAIN)).toBe(true);
  });

  it('throws at the end when the ciphertext was tampered with or the key is wrong', () => {
    const env = encryptBuffer(PLAIN, KEY);
    const tampered = Buffer.from(env);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => stream(tampered, KEY)).toThrow();
    expect(() => stream(env, 'another-master-key-at-least-32-characters')).toThrow();
  });

  it('refuses a header that is not an envelope header', () => {
    expect(() => createEnvelopeDecipher(Buffer.alloc(ENVELOPE_HEADER_LENGTH), KEY)).toThrow();
  });
});
