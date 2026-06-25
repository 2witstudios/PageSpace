/**
 * Rollout-safe field-encryption helpers over the random AES-256-GCM
 * `encrypt`/`decrypt` primitives (`encryption-utils.ts`).
 *
 * See `docs/security/pii-encryption-design.md`. These wrappers make column
 * encryption safe to roll out incrementally:
 *  - legacy plaintext is detected and passed through unchanged so reads work
 *    mid-backfill;
 *  - already-encrypted values are not double-encrypted;
 *  - empty/null values are never encrypted.
 *
 * Detection is length-precise to the `encrypt()` output shape
 * (salt=64 hex : iv=32 hex : authTag=32 hex : ciphertext) so values that merely
 * contain colons (e.g. IPv6 addresses) are NOT mistaken for ciphertext.
 */
import { encrypt, decrypt } from './encryption-utils';

const SALT_HEX_LEN = 64; // SALT_LENGTH (32 bytes) * 2
const IV_HEX_LEN = 32; //   IV_LENGTH (16 bytes) * 2
const TAG_HEX_LEN = 32; //  GCM auth tag (16 bytes) * 2

const isHex = (s: string): boolean => s.length > 0 && /^[0-9a-f]+$/i.test(s);

/** True iff `value` matches the exact `salt:iv:authTag:ciphertext` AES-GCM shape. */
export function looksEncrypted(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  const [salt, iv, tag, ct] = parts;
  return (
    salt.length === SALT_HEX_LEN &&
    iv.length === IV_HEX_LEN &&
    tag.length === TAG_HEX_LEN &&
    ct.length % 2 === 0 &&
    isHex(salt) &&
    isHex(iv) &&
    isHex(tag) &&
    isHex(ct)
  );
}

/** Encrypt a field value, skipping empty/null and already-encrypted values. */
export async function encryptField<T extends string | null | undefined>(value: T): Promise<T> {
  if (value === null || value === undefined || value === '') return value;
  if (looksEncrypted(value)) return value;
  return (await encrypt(value)) as T;
}

/** Decrypt a field value, passing through empty/null and legacy plaintext. */
export async function decryptField<T extends string | null | undefined>(value: T): Promise<T> {
  if (value === null || value === undefined || value === '') return value;
  if (!looksEncrypted(value)) return value;
  return (await decrypt(value)) as T;
}
