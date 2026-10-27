/**
 * Forward-only audit-IP encryption helpers (GDPR #965/#969).
 *
 * `security_audit_log.ipAddress` is EXCLUDED from the tamper-evident event hash
 * (see security-audit.ts), so encrypting it at write time is chain-safe. New
 * rows store AES-256-GCM ciphertext + a deterministic blind index (`ipBidx`);
 * forensic queries filter by the blind index and decrypt for display, while
 * legacy plaintext rows (written before a key was configured) still match and
 * read via the rollout-safe field helpers.
 *
 * Pure: the index key is passed in. Plaintext IPs are blind-indexed as-is (no
 * normalization) to preserve the exact-match semantics of the prior
 * `eq(ipAddress, …)` forensic filter.
 */
import { encryptField } from './field-crypto';
import { computeBlindIndex } from './blind-index';

export interface EncryptedAuditIp {
  ipAddress: string | undefined;
  ipBidx: string | null;
}

/**
 * Encrypt an audit IP for a NEW row. With no key (`indexKey === null`) the
 * plaintext passes through and the index is null — preserving current behavior
 * in environments without `ENCRYPTION_KEY`.
 */
export async function encryptAuditIp(
  ip: string | undefined,
  indexKey: Buffer | null,
): Promise<EncryptedAuditIp> {
  if (!ip || !indexKey) {
    return { ipAddress: ip, ipBidx: null };
  }
  return {
    ipAddress: await encryptField(ip),
    ipBidx: computeBlindIndex(ip, indexKey),
  };
}

/** Blind index for filtering audit rows by IP (matches {@link encryptAuditIp}). */
export function auditIpBlindIndex(ip: string, indexKey: Buffer): string {
  return computeBlindIndex(ip, indexKey);
}
