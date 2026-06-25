/**
 * Blind-index helpers for equality-searchable encrypted PII columns.
 *
 * See `docs/security/pii-encryption-design.md`. A blind index is a keyed
 * HMAC-SHA256 over the *normalized* plaintext, stored in a sibling column
 * (e.g. `emailBidx`). Equality lookups and uniqueness run against the blind
 * index while the value itself is stored as random AES-256-GCM ciphertext.
 *
 * The HMAC key is DERIVED from the master `ENCRYPTION_KEY` with a fixed,
 * domain-separated label so that the index secret is cryptographically
 * distinct from the at-rest AES key — leaking one does not reveal the other.
 *
 * Pure module: no env reads, no I/O. The master key is passed in; the env-bound
 * edge lives in `field-crypto.ts` / repository edges.
 */
import { createHmac, scryptSync } from 'crypto';

/** Domain-separation label — also used as the scrypt salt for derivation. */
const INDEX_KEY_INFO = 'pii-blind-index-v1';
const INDEX_KEY_LENGTH = 32;
const MIN_MASTER_KEY_LENGTH = 32;
const MIN_INDEX_KEY_BYTES = 16;

/**
 * Derive the blind-index HMAC key from the master encryption key.
 * Deterministic and domain-separated from the at-rest AES key.
 */
export function deriveIndexKey(masterKey: string): Buffer {
  if (!masterKey || typeof masterKey !== 'string') {
    throw new Error('Blind-index key derivation requires a non-empty master key');
  }
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `Master key must be at least ${MIN_MASTER_KEY_LENGTH} characters for blind-index derivation`,
    );
  }
  return scryptSync(masterKey, INDEX_KEY_INFO, INDEX_KEY_LENGTH);
}

/**
 * Compute the deterministic blind index (lowercase hex) of a value.
 * Throws on a missing/weak index key rather than hashing insecurely.
 */
export function computeBlindIndex(value: string, indexKey: Buffer): string {
  if (typeof value !== 'string') {
    throw new Error('Blind-index input must be a string');
  }
  if (!Buffer.isBuffer(indexKey) || indexKey.length < MIN_INDEX_KEY_BYTES) {
    throw new Error(`Blind-index requires a derived key of at least ${MIN_INDEX_KEY_BYTES} bytes`);
  }
  return createHmac('sha256', indexKey).update(value, 'utf8').digest('hex');
}

/** Normalize an email so case/whitespace variants collide (matches login intent). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Blind index for an email address (normalized before hashing). */
export function emailBlindIndex(email: string, indexKey: Buffer): string {
  return computeBlindIndex(normalizeEmail(email), indexKey);
}
