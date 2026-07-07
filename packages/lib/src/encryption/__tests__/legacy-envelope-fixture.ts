/**
 * Test fixture reproducing the FROZEN pre-#1930 legacy ciphertext envelope
 * (`salt:iv:authTag:ciphertext`, per-record scrypt-derived key, AES-256-GCM).
 * Do not "fix" these parameters — they must reproduce exactly what production
 * wrote before the fast 3-part format existed, or the suites silently start
 * validating a format that never existed.
 *
 * The salt + derived key are computed once per master key and reused:
 * envelope uniqueness comes from the random IV, and reusing the salt spares
 * every call the ~50-100ms blocking scrypt.
 */
import { scryptSync, randomBytes, createCipheriv } from 'crypto';

const keyByMaster = new Map<string, { salt: Buffer; key: Buffer }>();

export function legacyEncrypt(masterKey: string, plaintext: string): string {
  let entry = keyByMaster.get(masterKey);
  if (!entry) {
    const salt = randomBytes(32);
    entry = { salt, key: scryptSync(masterKey, salt, 32) };
    keyByMaster.set(masterKey, entry);
  }
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', entry.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [entry.salt, iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('hex')).join(':');
}
