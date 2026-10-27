/**
 * Forward-only audit-IP encryption helpers (GDPR #965/#969).
 *
 * Security-audit rows are an append-only, tamper-evident hash chain, but
 * `ipAddress` is EXCLUDED from the event hash (see security-audit.ts), so
 * encrypting it at write time does not affect chain verification. New rows store
 * AES-GCM ciphertext + a deterministic blind index; reads filter by the blind
 * index and decrypt for display, tolerating legacy plaintext rows.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { deriveIndexKey, computeBlindIndex } from './blind-index';
import { looksEncrypted, decryptField } from './field-crypto';
import { encryptAuditIp, auditIpBlindIndex } from './audit-ip-crypto';

const MASTER = 'audit-ip-test-master-key-at-least-32-chars!!';
const indexKey = deriveIndexKey(MASTER);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = MASTER;
});

describe('encryptAuditIp', () => {
  it('given an IP and key, should encrypt the value and emit a matching blind index', async () => {
    const { ipAddress, ipBidx } = await encryptAuditIp('203.0.113.7', indexKey);
    expect(looksEncrypted(ipAddress!)).toBe(true);
    expect(ipBidx).toBe(computeBlindIndex('203.0.113.7', indexKey));
    expect(await decryptField(ipAddress)).toBe('203.0.113.7');
  });

  it('given no key (null), should pass the plaintext through with a null index (legacy/dev)', async () => {
    const { ipAddress, ipBidx } = await encryptAuditIp('203.0.113.7', null);
    expect(ipAddress).toBe('203.0.113.7');
    expect(ipBidx).toBeNull();
  });

  it('given an undefined IP, should return undefined value and null index', async () => {
    expect(await encryptAuditIp(undefined, indexKey)).toEqual({ ipAddress: undefined, ipBidx: null });
  });
});

describe('auditIpBlindIndex', () => {
  it('given the same IP, should match the index produced at write time (forensic lookup path)', async () => {
    const { ipBidx } = await encryptAuditIp('198.51.100.4', indexKey);
    expect(auditIpBlindIndex('198.51.100.4', indexKey)).toBe(ipBidx);
  });

  it('given a different IP, should not collide', () => {
    expect(auditIpBlindIndex('198.51.100.4', indexKey)).not.toBe(auditIpBlindIndex('198.51.100.5', indexKey));
  });
});
