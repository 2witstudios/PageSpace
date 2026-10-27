/**
 * User PII encrypt/lookup/decrypt edge (GDPR #965).
 *
 * Centralizes the per-column decisions from docs/security/pii-encryption-design.md
 * for the `users` table: `email` and `name` are stored as random AES-256-GCM
 * ciphertext, while equality lookups + uniqueness for email run against the
 * deterministic `emailBidx` blind index.
 *
 * The crypto functions are pure (the index key is passed in). `getPiiIndexKey`
 * is the thin env-bound edge that derives the index key from `ENCRYPTION_KEY`.
 */
import { encryptField, decryptField } from './field-crypto';
import { deriveIndexKey, emailBlindIndex } from './blind-index';

export interface UserPiiPlain {
  email: string;
  name: string;
}

export interface UserPiiEncrypted {
  email: string;
  name: string;
  emailBidx: string;
}

/** Encrypt user PII columns and compute the email blind index. */
export async function encryptUserPii(plain: UserPiiPlain, indexKey: Buffer): Promise<UserPiiEncrypted> {
  const [email, name] = await Promise.all([encryptField(plain.email), encryptField(plain.name)]);
  return {
    email,
    name,
    emailBidx: emailBlindIndex(plain.email, indexKey),
  };
}

/** Decrypt a user row's PII columns (legacy plaintext passes through). */
export async function decryptUserPii(row: { email: string; name: string }): Promise<UserPiiPlain> {
  const [email, name] = await Promise.all([decryptField(row.email), decryptField(row.name)]);
  return { email, name };
}

/** Blind index to look up a user by email (normalized, deterministic). */
export function emailLookupBidx(email: string, indexKey: Buffer): string {
  return emailBlindIndex(email, indexKey);
}

/** Env-bound edge: derive the PII blind-index key from ENCRYPTION_KEY. */
export function getPiiIndexKey(): Buffer {
  const master = process.env.ENCRYPTION_KEY;
  if (!master) {
    throw new Error('ENCRYPTION_KEY is required for PII blind-index derivation');
  }
  return deriveIndexKey(master);
}
