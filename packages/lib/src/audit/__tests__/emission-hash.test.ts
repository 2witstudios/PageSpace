/**
 * Golden-vector suite for computeEmissionHash (#890 Phase 2, leaf 1).
 *
 * The emission hash is the lock-free write path's content fingerprint:
 * sha256 over stableStringify of the SAME PII-excluded field set as
 * computeSecurityEventHash, but WITHOUT previousHash — chaining
 * (chainHash = H(emissionHash, prevHash)) is the single-writer chainer's
 * job (leaf 2), never the emitter's.
 *
 * Pinned literal hex outputs: if this suite ever fails, emission-hash
 * semantics changed and every ingest row already emitted (plus its
 * co-streamed stdout record) no longer verifies against a recomputation.
 */
import { describe, it, expect } from 'vitest';

import { computeEmissionHash } from '../emission-hash';
import { computeSecurityEventHash, type AuditEvent } from '../security-audit';

const MINIMAL_HASH = '7b3bd93e3b22380b60bed2ea1dfff9aa72b0281a969a44ab2a8b77db9a8bc1c8';
const DETAILS_HASH = 'bb51071ec93aa6e42a169d0584c01ba3a210e8ad83546b14bc1215767fee7e55';
const ALL_FIELDS_HASH = '8b5ae1d30aa91211ac8df78efce42c3700101ee5714516709ec9bf9c2d1697d8';
const UNICODE_HASH = 'ffc6e82da4dacaf06f8ac4464ddf6e53a1b6e212f29b57fec7eb4d0ba4918d5b';

describe('computeEmissionHash golden vectors (pinned)', () => {
  it('given a minimal event, should match the pinned hash', () => {
    const event: AuditEvent = { eventType: 'auth.login.success' };

    const hash = computeEmissionHash(event, new Date('2026-01-25T10:00:00.000Z'));

    expect(hash).toBe(MINIMAL_HASH);
  });

  it('given an event with a details jsonb payload, should match the pinned hash', () => {
    const event: AuditEvent = {
      eventType: 'data.export',
      resourceType: 'drive',
      resourceId: 'drive-42',
      details: { format: 'pdf', pageCount: 12, tags: ['q1', 'report'] },
      riskScore: 0.2,
    };

    const hash = computeEmissionHash(event, new Date('2026-01-25T10:00:02.000Z'));

    expect(hash).toBe(DETAILS_HASH);
  });

  it('given every PII field present, should match the pinned hash AND equal the PII-stripped equivalent (proves PII exclusion)', () => {
    const timestamp = new Date('2026-01-25T10:00:03.000Z');
    const withPii: AuditEvent = {
      eventType: 'security.anomaly.detected',
      userId: 'user-pii-123',
      sessionId: 'sess-pii-456',
      serviceId: 'web',
      resourceType: 'account',
      resourceId: 'acct-1',
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (PII-Agent)',
      geoLocation: 'US-CA',
      details: { flag: 'impossible_travel' },
      riskScore: 0.9,
      anomalyFlags: ['impossible_travel', 'new_device'],
    };
    const withoutPii: AuditEvent = {
      eventType: 'security.anomaly.detected',
      serviceId: 'web',
      resourceType: 'account',
      resourceId: 'acct-1',
      details: { flag: 'impossible_travel' },
      riskScore: 0.9,
      anomalyFlags: ['impossible_travel', 'new_device'],
    };

    const hashWithPii = computeEmissionHash(withPii, timestamp);
    const hashWithoutPii = computeEmissionHash(withoutPii, timestamp);

    expect(hashWithPii).toBe(ALL_FIELDS_HASH);
    expect(hashWithPii).toBe(hashWithoutPii);
  });

  it('given unicode content and reversed key order, should produce the same pinned hash (stableStringify stress)', () => {
    const timestamp = new Date('2026-01-25T10:00:04.000Z');
    const a: AuditEvent = {
      eventType: 'data.write',
      resourceType: 'page',
      resourceId: 'page-ü',
      details: { title: '日本語テスト', emoji: '🔒', z_last: 1, a_first: 2 },
    };
    const b: AuditEvent = {
      eventType: 'data.write',
      resourceType: 'page',
      resourceId: 'page-ü',
      details: { a_first: 2, z_last: 1, emoji: '🔒', title: '日本語テスト' },
    };

    const hashA = computeEmissionHash(a, timestamp);
    const hashB = computeEmissionHash(b, timestamp);

    expect(hashA).toBe(UNICODE_HASH);
    expect(hashA).toBe(hashB);
  });

  it('given the same event and timestamp, should NOT equal computeSecurityEventHash under any previousHash (previousHash is excluded by construction)', () => {
    const event: AuditEvent = { eventType: 'auth.login.success' };
    const timestamp = new Date('2026-01-25T10:00:00.000Z');

    const emission = computeEmissionHash(event, timestamp);

    // The chain hash varies with previousHash; the emission hash is a pure
    // content fingerprint and must match neither variant.
    expect(emission).not.toBe(computeSecurityEventHash(event, 'genesis', timestamp));
    expect(emission).not.toBe(computeSecurityEventHash(event, MINIMAL_HASH, timestamp));
  });

  it('given two different timestamps for an otherwise identical event, should produce different hashes (timestamp is content)', () => {
    const event: AuditEvent = { eventType: 'auth.login.success' };

    const first = computeEmissionHash(event, new Date('2026-01-25T10:00:00.000Z'));
    const second = computeEmissionHash(event, new Date('2026-01-25T10:00:01.000Z'));

    expect(first).toBe(MINIMAL_HASH);
    expect(second).not.toBe(first);
  });
});
