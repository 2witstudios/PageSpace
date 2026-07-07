/**
 * Pure planner for the legacy-ciphertext re-encryption backfill.
 *
 * The 2026-07-06 user-PII backfill ran before #1930 introduced the fast 3-part
 * `iv:authTag:ciphertext` envelope, so every existing row is stuck on the
 * legacy 4-part `salt:iv:authTag:ciphertext` format whose decrypt pays a full
 * per-record scrypt (`deriveLegacyKey` in encryption-utils.ts). This planner
 * decrypts a legacy value and re-encrypts it under the memoized master key in
 * a single pass, leaving the plaintext byte-identical.
 *
 * The imperative runner (scripts/backfill-legacy-ciphertext-reencrypt.ts)
 * streams rows in batches and applies the update this planner returns. Keeping
 * the decision pure — no DB access, no I/O — makes idempotency and the
 * round-trip invariant testable without a database.
 *
 * Skips are what make re-runs converge: fast-format values are already done,
 * and plaintext values are the ORIGINAL backfill's job, never this one's. The
 * email blind index is untouched — it is derived from the plaintext, which
 * does not change.
 */
import { encrypt, decrypt } from './encryption-utils';
import { looksLegacyEncrypted } from './field-crypto';

export interface LegacyCiphertextRow {
  id: string;
  email: string;
  name: string;
}

export interface LegacyReencryptUpdate {
  id: string;
  email: string;
  name: string;
}

/**
 * Plan the re-encryption update for one row, or `null` to skip.
 *
 * Only fields in the legacy 4-part format are converted; a field already in
 * the fast format (or plaintext) passes through unchanged. Throws if a legacy
 * value fails to decrypt (wrong key / tampered ciphertext) — the runner counts
 * that as a per-row error and continues.
 */
export async function planLegacyCiphertextReencrypt(
  row: LegacyCiphertextRow,
): Promise<LegacyReencryptUpdate | null> {
  const emailLegacy = looksLegacyEncrypted(row.email);
  const nameLegacy = looksLegacyEncrypted(row.name);
  if (!emailLegacy && !nameLegacy) return null;

  const [email, name] = await Promise.all([
    emailLegacy ? reencryptLegacyValue(row.email) : row.email,
    nameLegacy ? reencryptLegacyValue(row.name) : row.name,
  ]);
  return { id: row.id, email, name };
}

/**
 * Decrypt a legacy envelope and re-encrypt to the fast 3-part format.
 *
 * Exported as the column-agnostic core for follow-up backfills — other tables
 * also hold pre-#1930 legacy ciphertext (integration connection credentials,
 * OAuth refresh tokens, audit-log IPs) and should convert through this same
 * tested value-level path rather than reimplementing it.
 */
export async function reencryptLegacyValue(legacyCiphertext: string): Promise<string> {
  return encrypt(await decrypt(legacyCiphertext));
}
