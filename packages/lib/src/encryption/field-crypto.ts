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
 * Detection is length-precise to the `encrypt()` output shape — the current
 * `iv:authTag:ciphertext` (3 parts) and the legacy `salt:iv:authTag:ciphertext`
 * (4 parts) — so values that merely contain colons (e.g. IPv6 addresses) are
 * NOT mistaken for ciphertext.
 */
import { encrypt, decrypt } from './encryption-utils';

const SALT_HEX_LEN = 64; // legacy per-record salt (32 bytes) * 2
const IV_HEX_LEN = 32; //   IV_LENGTH (16 bytes) * 2
const TAG_HEX_LEN = 32; //  GCM auth tag (16 bytes) * 2

const isHex = (s: string): boolean => s.length > 0 && /^[0-9a-f]+$/i.test(s);

const isValidCiphertextHex = (iv: string, tag: string, ct: string): boolean =>
  iv.length === IV_HEX_LEN && tag.length === TAG_HEX_LEN && ct.length % 2 === 0 && isHex(iv) && isHex(tag) && isHex(ct);

/**
 * True iff `value` matches either AES-GCM envelope shape: the current
 * `iv:authTag:ciphertext` (3 parts, shared master key) or the legacy
 * `salt:iv:authTag:ciphertext` (4 parts, per-record scrypt).
 */
export function looksEncrypted(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');

  if (parts.length === 3) {
    const [iv, tag, ct] = parts;
    return isValidCiphertextHex(iv, tag, ct);
  }

  if (parts.length === 4) {
    const [salt, iv, tag, ct] = parts;
    return salt.length === SALT_HEX_LEN && isHex(salt) && isValidCiphertextHex(iv, tag, ct);
  }

  return false;
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

/**
 * Batch-decrypt a request's field values exactly once per distinct value.
 *
 * For rows that carry no user id (raw-SQL projections, COALESCEd columns), the
 * stored value itself is the dedup key: the same user repeated across rows
 * repeats the same stored ciphertext, so each unique value decrypts once
 * instead of once per row. Plaintext values pass through via `decryptField`.
 *
 * Returns a lookup with fail-closed semantics: `null`/`undefined` map to
 * `null`, and a value that was never batched returns `null` rather than the
 * raw (potentially ciphertext) input — a drift between batch construction and
 * lookup sites must never leak ciphertext to a client.
 */
export async function decryptFieldValuesOnce(
  values: ReadonlyArray<string | null | undefined>,
): Promise<(value: string | null | undefined) => string | null> {
  const unique = [...new Set(values.filter((value): value is string => typeof value === 'string'))];
  const decrypted = await Promise.all(unique.map(async (value) => [value, await decryptField(value)] as const));
  const byValue = new Map<string, string>(decrypted);
  return (value) => (typeof value === 'string' ? byValue.get(value) ?? null : null);
}
