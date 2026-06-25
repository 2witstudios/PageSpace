/**
 * Envelope-encryption codec for file-storage objects at rest (GDPR #966).
 *
 * Wraps object bytes with AES-256-GCM under a per-object data key derived from
 * the master key with a random per-object salt. Output layout:
 *
 *   [ MAGIC(4) | salt(32) | iv(12) | authTag(16) | ciphertext(...) ]
 *
 * The MAGIC prefix lets reads detect envelopes and transparently decrypt them,
 * so legacy plaintext objects (and objects written while encryption was enabled
 * but later disabled) keep reading correctly.
 *
 * Pure module: the master key is passed in; no env reads, no I/O.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const MAGIC = Buffer.from('PSE1', 'ascii'); // PageSpace Envelope v1
const SALT_LEN = 32;
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
const MIN_MASTER_KEY_LEN = 32;

function deriveDataKey(masterKey: string, salt: Buffer): Buffer {
  if (!masterKey || masterKey.length < MIN_MASTER_KEY_LEN) {
    throw new Error(`File-encryption master key must be at least ${MIN_MASTER_KEY_LEN} characters`);
  }
  return scryptSync(masterKey, salt, KEY_LEN);
}

/** Encrypt `plain` into a self-describing envelope buffer. */
export function encryptBuffer(plain: Buffer, masterKey: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveDataKey(masterKey, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

/** Decrypt an envelope buffer produced by {@link encryptBuffer}. Throws on tamper. */
export function decryptBuffer(stored: Buffer, masterKey: string): Buffer {
  if (!isEnvelope(stored)) {
    throw new Error('Not a PageSpace envelope buffer');
  }
  let offset = MAGIC.length;
  const salt = stored.subarray(offset, (offset += SALT_LEN));
  const iv = stored.subarray(offset, (offset += IV_LEN));
  const tag = stored.subarray(offset, (offset += TAG_LEN));
  const ciphertext = stored.subarray(offset);
  const key = deriveDataKey(masterKey, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** True iff `buf` carries the envelope magic prefix and a full header. */
export function isEnvelope(buf: Buffer): boolean {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= HEADER_LEN &&
    buf.subarray(0, MAGIC.length).equals(MAGIC)
  );
}

/** Encrypt only when policy enables it; otherwise pass bytes through. */
export function maybeEncryptBuffer(
  plain: Buffer,
  { enabled, masterKey }: { enabled: boolean; masterKey: string },
): Buffer {
  if (!enabled) return plain;
  return encryptBuffer(plain, masterKey);
}

/** Decrypt only when the bytes are an envelope; otherwise pass through (legacy). */
export function maybeDecryptBuffer(
  stored: Buffer,
  { masterKey }: { masterKey: string },
): Buffer {
  if (!isEnvelope(stored)) return stored;
  return decryptBuffer(stored, masterKey);
}
