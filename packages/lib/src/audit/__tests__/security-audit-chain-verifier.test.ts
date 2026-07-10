/**
 * Security Audit Chain Verifier Tests
 *
 * Tests for verifying the integrity of the security audit log hash chain.
 * Builds valid chains via shared helpers, then tampers with entries to verify detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createValidSecurityChain,
  createValidSecurityChainWithEventTypes,
  createValidChainerEraChain,
  type MockSecurityAuditEntry,
} from './audit-test-helpers';

let mockEntries: MockSecurityAuditEntry[] = [];

vi.mock('../../logging/logger-config', () => ({
  loggers: { security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('drizzle-orm', () => ({
  asc: vi.fn(),
  count: vi.fn(() => 'count'),
  and: vi.fn((...args: unknown[]) => args),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
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
}));
// Default binding (#890 Phase 2, leaf 5): dedicated mode resolves the Admin
// PG client — point it at the same mock so default-db expectations exercise
// the post-cutover default.
vi.mock('@pagespace/db/admin-db', async () => {
  const { db } = await import('@pagespace/db/db');
  return {
    getAdminDbMode: vi.fn(() => ({ mode: 'dedicated', reason: 'ADMIN_DATABASE_URL is set' })),
    getAdminDb: vi.fn(() => db),
  };
});
vi.mock('@pagespace/db/schema/security-audit', () => ({
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
  type VerifySecurityChainDeps,
} from '../security-audit-chain-verifier';
import { computeSecurityEventHash, type AuditEvent } from '../security-audit';
import { db as mockDefaultDb } from '@pagespace/db/db';

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

    // Migration 0105 converted security_audit_log.event_type from a pg enum to
    // text so legacy values removed from the TS SecurityEventType union (e.g.
    // the auth.password.* group dropped with passwordless-only auth) persist
    // verbatim without DELETE / UPDATE. The verifier reads event_type as an
    // opaque string and passes it through computeSecurityEventHash — chain
    // integrity must hold for rows carrying those legacy values.
    it('verifies a chain that includes legacy event_type values (migration 0105 invariant)', async () => {
      mockEntries = createValidSecurityChainWithEventTypes([
        'auth.login.success',
        'auth.password.changed',
        'auth.password.reset.requested',
        'auth.password.reset.completed',
        'auth.session.created',
      ]);

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(true);
      expect(result.entriesVerified).toBe(5);
      expect(result.validEntries).toBe(5);
      expect(result.invalidEntries).toBe(0);
      expect(result.breakPoint).toBeNull();
    });

    // Regression test for the canonical-serialization bug: when Postgres returns a
    // JSONB column with keys in a different order than they were written, the
    // verifier must still compute the same hash. stableStringify sorts keys at
    // every depth, so insertion order must not matter.
    it('verifies chain when Postgres JSONB round-trip reorders details keys', async () => {
      const timestamp0 = new Date('2026-01-25T10:00:00.000Z');
      const timestamp1 = new Date('2026-01-25T10:00:01.000Z');

      const event0 = {
        eventType: 'auth.login.success' as const,
        serviceId: 'web',
        details: { action: 'export', format: 'pdf', count: 3 },
      } satisfies AuditEvent;
      const event1 = {
        eventType: 'data.read' as const,
        serviceId: 'web',
        details: { resource: 'page', nested: { z: 1, a: 2 } },
      } satisfies AuditEvent;

      const hash0 = computeSecurityEventHash(event0, 'genesis', timestamp0);
      const hash1 = computeSecurityEventHash(event1, hash0, timestamp1);

      // Simulate Postgres JSONB returning keys in a different order than written
      mockEntries = [
        {
          id: 'audit-1',
          eventType: 'auth.login.success',
          userId: null, sessionId: null, serviceId: 'web',
          resourceType: null, resourceId: null,
          ipAddress: null, userAgent: null, geoLocation: null,
          details: { count: 3, format: 'pdf', action: 'export' }, // reversed
          riskScore: null, anomalyFlags: null,
          timestamp: timestamp0,
          previousHash: 'genesis',
          eventHash: hash0,
        },
        {
          id: 'audit-2',
          eventType: 'data.read',
          userId: null, sessionId: null, serviceId: 'web',
          resourceType: null, resourceId: null,
          ipAddress: null, userAgent: null, geoLocation: null,
          details: { nested: { a: 2, z: 1 }, resource: 'page' }, // reversed
          riskScore: null, anomalyFlags: null,
          timestamp: timestamp1,
          previousHash: hash0,
          eventHash: hash1,
        },
      ];

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(true);
      expect(result.entriesVerified).toBe(2);
      expect(result.validEntries).toBe(2);
      expect(result.invalidEntries).toBe(0);
      expect(result.breakPoint).toBeNull();
    });

    it('verifies the chain-link across a legacy event_type row (previousHash continuity)', async () => {
      // Tighter invariant: not just hash validity of the legacy row, but that
      // its eventHash chains correctly into the successor row.
      mockEntries = createValidSecurityChainWithEventTypes([
        'auth.login.success',
        'auth.password.changed',
        'auth.session.created',
      ]);

      // Precondition: successor points at predecessor's hash.
      expect(mockEntries[2]!.previousHash).toBe(mockEntries[1]!.eventHash);

      const result = await verifySecurityAuditChain();

      expect(result.isValid).toBe(true);
      expect(result.breakPoint).toBeNull();
    });

    describe('given an injected db client', () => {
      function createInjectedDb(entries: MockSecurityAuditEntry[]) {
        const select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: entries.length }]),
          }),
        });
        const findMany = vi.fn().mockImplementation(async (opts) => {
          let result = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          if (opts?.offset) result = result.slice(opts.offset);
          if (opts?.limit) result = result.slice(0, opts.limit);
          return result;
        });
        return { select, query: { securityAuditLog: { findMany } } };
      }

      it('should use the injected client exclusively, never the module-level singleton', async () => {
        mockEntries = [];
        const injectedEntries = createValidSecurityChain(3);
        const injectedDb = createInjectedDb(injectedEntries);
        const deps: VerifySecurityChainDeps = { db: injectedDb as unknown as VerifySecurityChainDeps['db'] };

        const result = await verifySecurityAuditChain({}, deps);

        expect(injectedDb.select).toHaveBeenCalled();
        expect(injectedDb.query.securityAuditLog.findMany).toHaveBeenCalled();
        expect(mockDefaultDb.select).not.toHaveBeenCalled();
        expect(mockDefaultDb.query.securityAuditLog.findMany).not.toHaveBeenCalled();
        expect(result.isValid).toBe(true);
        expect(result.totalEntries).toBe(3);
      });

      it('given no injected client, should fall back to the resolved audit binding (Admin PG in dedicated mode)', async () => {
        mockEntries = createValidSecurityChain(2);

        const result = await verifySecurityAuditChain();

        expect(mockDefaultDb.select).toHaveBeenCalled();
        expect(mockDefaultDb.query.securityAuditLog.findMany).toHaveBeenCalled();
        expect(result.isValid).toBe(true);
        expect(result.entriesVerified).toBe(2);
      });

      it('PARITY: the same chain verifies to the same verdict via the injected admin client and the default binding', async () => {
        const entries = createValidSecurityChain(4);
        mockEntries = entries;
        const injectedDb = createInjectedDb(entries);

        const viaDefault = await verifySecurityAuditChain();
        const viaInjected = await verifySecurityAuditChain(
          {},
          { db: injectedDb as unknown as VerifySecurityChainDeps['db'] },
        );

        expect(viaInjected.isValid).toBe(viaDefault.isValid);
        expect(viaInjected.entriesVerified).toBe(viaDefault.entriesVerified);
        expect(viaInjected.validEntries).toBe(viaDefault.validEntries);
        expect(viaInjected.breakPoint).toEqual(viaDefault.breakPoint);
      });
    });

    /**
     * Era-aware verification (#890 Phase 2, leaf 5). Chainer-written rows
     * carry emission_hash and event_hash = H(emission_hash, previous_hash)
     * (chain-step semantics) — NOT computeSecurityEventHash. The verifier
     * must recompute per row era or it false-alarms on every post-cutover
     * row the moment it binds to the Admin PG.
     */
    describe('era-aware verification (chainer-era rows)', () => {
      it('given a valid chainer-era chain, should verify clean', async () => {
        mockEntries = createValidChainerEraChain(5);

        const result = await verifySecurityAuditChain();

        expect(result.isValid).toBe(true);
        expect(result.validEntries).toBe(5);
        expect(result.invalidEntries).toBe(0);
        expect(result.breakPoint).toBeNull();
      });

      it('given tampered payload data in a chainer-era row, should detect the emission mismatch', async () => {
        const entries = createValidChainerEraChain(4);
        entries[2] = { ...entries[2]!, details: { seq: 999, injected: true } };
        mockEntries = entries;

        const result = await verifySecurityAuditChain();

        expect(result.isValid).toBe(false);
        expect(result.breakPoint?.entryId).toBe(entries[2]!.id);
        expect(result.breakPoint?.description).toMatch(/[Ee]mission/);
      });

      it('given a tampered stored emission_hash (payload intact), should still detect it', async () => {
        const entries = createValidChainerEraChain(3);
        entries[1] = { ...entries[1]!, emissionHash: 'f'.repeat(64) };
        mockEntries = entries;

        const result = await verifySecurityAuditChain();

        expect(result.isValid).toBe(false);
        expect(result.breakPoint?.entryId).toBe(entries[1]!.id);
      });

      it('given a tampered event_hash in a chainer-era row, should detect the chain-hash mismatch', async () => {
        const entries = createValidChainerEraChain(3);
        entries[1] = { ...entries[1]!, eventHash: 'a'.repeat(64) };
        mockEntries = entries;

        const result = await verifySecurityAuditChain();

        expect(result.isValid).toBe(false);
        expect(result.breakPoint?.entryId).toBeTruthy();
      });

      it('given a legacy chain continued by a chainer-era segment (the backfill era boundary), should verify clean across the boundary', async () => {
        const legacy = createValidSecurityChain(3);
        const legacyHead = legacy[legacy.length - 1]!.eventHash;
        const chained = createValidChainerEraChain(3, { previousHash: legacyHead, startIndex: 3 });
        mockEntries = [...legacy, ...chained];

        const result = await verifySecurityAuditChain();

        expect(result.isValid).toBe(true);
        expect(result.validEntries).toBe(6);
        expect(result.breakPoint).toBeNull();
      });

      it('given a linkage break AT the era boundary, should detect it', async () => {
        const legacy = createValidSecurityChain(2);
        const chained = createValidChainerEraChain(2, { previousHash: 'not-the-legacy-head', startIndex: 2 });
        mockEntries = [...legacy, ...chained];

        const result = await verifySecurityAuditChain();

        expect(result.isValid).toBe(false);
        expect(result.breakPoint?.entryId).toBe(chained[0]!.id);
      });
    });
  });
});
