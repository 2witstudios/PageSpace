/**
 * Security Audit Chain Verifier Tests
 *
 * Tests for verifying the integrity of the security audit log hash chain.
 * Uses actual computeSecurityEventHash to build valid chains, then
 * tampers with entries to verify detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeSecurityEventHash, type AuditEvent } from '../security-audit';

// Mock data storage
let mockEntries: Array<{
  id: string;
  eventType: string;
  userId: string | null;
  sessionId: string | null;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  geoLocation: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  timestamp: Date;
  previousHash: string;
  eventHash: string;
}> = [];

vi.mock('drizzle-orm', () => ({
  asc: vi.fn(),
  count: vi.fn(() => 'count'),
  and: vi.fn((...args: unknown[]) => args),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          return Promise.resolve([{ count: mockEntries.length }]);
        }),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockImplementation((off: number) => {
              return Promise.resolve(mockEntries.slice(off));
            }),
          }),
        }),
      }),
    }),
    query: {
      securityAuditLog: {
        findMany: vi.fn().mockImplementation(async (opts) => {
          let entries = [...mockEntries];

          entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          if (opts?.offset) {
            entries = entries.slice(opts.offset);
          }

          if (opts?.limit) {
            entries = entries.slice(0, opts.limit);
          }

          return entries;
        }),
      },
    },
  },
  securityAuditLog: {
    id: 'id',
    eventType: 'eventType',
    userId: 'userId',
    sessionId: 'sessionId',
    serviceId: 'serviceId',
    resourceType: 'resourceType',
    resourceId: 'resourceId',
    ipAddress: 'ipAddress',
    userAgent: 'userAgent',
    geoLocation: 'geoLocation',
    details: 'details',
    riskScore: 'riskScore',
    anomalyFlags: 'anomalyFlags',
    timestamp: 'timestamp',
    previousHash: 'previousHash',
    eventHash: 'eventHash',
  },
}));

import {
  verifySecurityAuditChain,
  type SecurityChainVerificationResult,
} from '../security-audit-chain-verifier';

/**
 * Helper to create a valid security audit chain of entries
 * using actual computeSecurityEventHash for real hashes.
 */
function createValidSecurityChain(count: number): typeof mockEntries {
  const entries: typeof mockEntries = [];
  let previousHash = 'genesis';

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.now() + i * 1000);
    const id = `audit-${i + 1}`;

    const event: AuditEvent = {
      eventType: 'auth.login.success',
      userId: 'user-123',
      sessionId: `session-${i}`,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    };

    const eventHash = computeSecurityEventHash(event, previousHash, timestamp);

    entries.push({
      id,
      eventType: event.eventType,
      userId: event.userId ?? null,
      sessionId: event.sessionId ?? null,
      serviceId: null,
      resourceType: null,
      resourceId: null,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
      geoLocation: null,
      details: null,
      riskScore: null,
      anomalyFlags: null,
      timestamp,
      previousHash,
      eventHash,
    });

    previousHash = eventHash;
  }

  return entries;
}

describe('security-audit-chain-verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntries = [];
  });

  describe('verifySecurityAuditChain', () => {
    it('should return valid for an empty chain', async () => {
      mockEntries = [];

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(0);
      expect(result.entriesVerified).toBe(0);
      expect(result.breakPoint).toBeNull();
    });

    it('should verify a valid chain of entries', async () => {
      mockEntries = createValidSecurityChain(5);

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(true);
      expect(result.entriesVerified).toBe(5);
      expect(result.validEntries).toBe(5);
      expect(result.invalidEntries).toBe(0);
      expect(result.breakPoint).toBeNull();
    });

    it('should detect tampered eventHash', async () => {
      mockEntries = createValidSecurityChain(5);
      mockEntries[2]!.eventHash = 'tampered-hash-value';

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(false);
      expect(result.invalidEntries).toBeGreaterThan(0);
      expect(result.breakPoint).not.toBeNull();
      expect(result.breakPoint?.entryId).toBe('audit-3');
      expect(result.breakPoint?.position).toBe(2);
    });

    it('should detect tampered entry data (non-PII field)', async () => {
      mockEntries = createValidSecurityChain(3);
      // Modify eventType (non-PII) — this changes the computed hash
      mockEntries[1]!.eventType = 'auth.login.failure';

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(false);
      expect(result.breakPoint).not.toBeNull();
      expect(result.breakPoint?.entryId).toBe('audit-2');
    });

    it('should remain valid after PII anonymization (#541)', async () => {
      mockEntries = createValidSecurityChain(5);
      // Simulate GDPR anonymization: null out all PII fields
      for (const entry of mockEntries) {
        entry.userId = null;
        entry.sessionId = null;
        entry.ipAddress = null;
        entry.userAgent = null;
        entry.geoLocation = null;
      }

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(true);
      expect(result.entriesVerified).toBe(5);
      expect(result.validEntries).toBe(5);
      expect(result.invalidEntries).toBe(0);
    });

    it('should detect broken chain link (previousHash mismatch)', async () => {
      mockEntries = createValidSecurityChain(4);
      // Break the chain link: entry 3's previousHash doesn't match entry 2's eventHash
      mockEntries[2]!.previousHash = 'wrong-previous-hash';

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(false);
      expect(result.breakPoint).not.toBeNull();
    });

    it('should stop at first break when stopOnFirstBreak is true', async () => {
      mockEntries = createValidSecurityChain(5);
      mockEntries[1]!.eventHash = 'tampered-1';
      mockEntries[3]!.eventHash = 'tampered-2';

      const result = await verifySecurityAuditChain({ stopOnFirstBreak: true });

      expect(result.isValid).toBe(false);
      expect(result.breakPoint?.entryId).toBe('audit-2');
      expect(result.entriesVerified).toBeLessThan(5);
    });

    it('should respect the limit option', async () => {
      mockEntries = createValidSecurityChain(10);

      const result = await verifySecurityAuditChain({ limit: 3 });

      expect(result.entriesVerified).toBe(3);
      expect(result.totalEntries).toBe(10);
    });

    it('should include timing information', async () => {
      mockEntries = createValidSecurityChain(2);

      const result = await verifySecurityAuditChain();

      expect(result.verificationStartedAt).toBeInstanceOf(Date);
      expect(result.verificationCompletedAt).toBeInstanceOf(Date);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
