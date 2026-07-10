/**
 * Unit suite for createAuditIngestWriter (#890 Phase 2, leaf 1).
 *
 * The ingest writer is the lock-free replacement for the advisory-lock
 * append path: encrypt IP + pure emission hash + ONE INSERT into
 * security_audit_ingest. These tests prove the O(1) shape mechanically —
 * the injected db receives exactly one insert() and NEVER a transaction,
 * raw execute (lock/head read), or select.
 *
 * NOT yet bound to production flow: audit-log.ts / the securityAudit
 * singleton still use the advisory-lock repository until leaf 5 cuts over.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { securityAuditIngest } from '@pagespace/db/admin-schema';
import { loggers } from '../../logging/logger-config';
import { createAuditIngestWriter, type AuditIngestWriterDeps } from '../audit-ingest-writer';
import { CO_STREAM_LOG_MESSAGE } from '../co-stream';
import { computeEmissionHash } from '../emission-hash';
import type { AuditEvent } from '../security-audit';

interface CapturedInsert {
  table: unknown;
  values: Record<string, unknown>;
}

function createMockDb() {
  const inserts: CapturedInsert[] = [];

  const insert = vi.fn((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return Promise.resolve(undefined);
    },
  }));
  // Forbidden surfaces — present on the mock so a regression that starts
  // calling them fails these assertions rather than throwing opaquely.
  const transaction = vi.fn();
  const execute = vi.fn();
  const select = vi.fn();

  const db = { insert, transaction, execute, select } as unknown as AuditIngestWriterDeps['db'];

  return { db, inserts, insert, transaction, execute, select };
}

describe('createAuditIngestWriter', () => {
  describe('writeToIngest', () => {
    it('should perform exactly ONE insert into security_audit_ingest — no transaction, no advisory lock, no head read', async () => {
      const { db, inserts, insert, transaction, execute, select } = createMockDb();
      const writer = createAuditIngestWriter({ db });

      await writer.writeToIngest(
        { eventType: 'auth.login.success', userId: 'user1' },
        { now: new Date('2026-01-25T10:00:00.000Z') }
      );

      expect(insert).toHaveBeenCalledTimes(1);
      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.table).toBe(securityAuditIngest);
      expect(transaction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    });

    it('should store the emission hash computed by the pure fn (byte-identical to computeEmissionHash)', async () => {
      const { db, inserts } = createMockDb();
      const writer = createAuditIngestWriter({ db });
      const event: AuditEvent = {
        eventType: 'data.export',
        userId: 'user123',
        resourceType: 'drive',
        resourceId: 'drive-42',
        details: { format: 'pdf' },
        riskScore: 0.2,
      };
      const now = new Date('2026-01-25T10:00:02.000Z');

      await writer.writeToIngest(event, { now });

      expect(inserts[0]!.values.emissionHash).toBe(computeEmissionHash(event, now));
      expect(inserts[0]!.values.timestamp).toEqual(now);
    });

    it('should write no chain fields — chain_seq/previousHash/eventHash belong to the chainer (leaf 2)', async () => {
      const { db, inserts } = createMockDb();
      const writer = createAuditIngestWriter({ db });

      await writer.writeToIngest(
        { eventType: 'auth.logout', userId: 'user1' },
        { now: new Date('2026-01-25T10:00:00.000Z') }
      );

      const values = inserts[0]!.values;
      expect(values).not.toHaveProperty('previousHash');
      expect(values).not.toHaveProperty('eventHash');
      expect(values).not.toHaveProperty('chainSeq');
    });

    it('should carry every event column through to the row', async () => {
      const { db, inserts } = createMockDb();
      const writer = createAuditIngestWriter({ db });
      const now = new Date('2026-01-25T10:00:03.000Z');
      const event: AuditEvent = {
        eventType: 'security.anomaly.detected',
        userId: 'user-1',
        sessionId: 'sess-1',
        serviceId: 'web',
        resourceType: 'account',
        resourceId: 'acct-1',
        userAgent: 'UA/1.0',
        geoLocation: 'US-CA',
        details: { flag: 'impossible_travel' },
        riskScore: 0.9,
        anomalyFlags: ['impossible_travel'],
      };

      await writer.writeToIngest(event, { now });

      expect(inserts[0]!.values).toMatchObject({
        eventType: 'security.anomaly.detected',
        userId: 'user-1',
        sessionId: 'sess-1',
        serviceId: 'web',
        resourceType: 'account',
        resourceId: 'acct-1',
        userAgent: 'UA/1.0',
        geoLocation: 'US-CA',
        details: { flag: 'impossible_travel' },
        riskScore: 0.9,
        anomalyFlags: ['impossible_travel'],
        timestamp: now,
      });
    });

    it('encrypts the IP address at rest (ciphertext + blind index) while the emission hash excludes it', async () => {
      const { db, inserts } = createMockDb();
      const writer = createAuditIngestWriter({ db });
      const now = new Date('2026-01-25T10:00:04.000Z');

      await writer.writeToIngest({ eventType: 'auth.login.success', ipAddress: '10.0.0.5' }, { now });

      const values = inserts[0]!.values;
      expect(values.ipAddress).not.toBe('10.0.0.5');
      expect(values.ipBidx).toEqual(expect.any(String));
      // Emission hash is identical with or without the IP — PII-excluded.
      expect(values.emissionHash).toBe(computeEmissionHash({ eventType: 'auth.login.success' }, now));
    });

    it('given no override, should stamp the event timestamp itself (new Date())', async () => {
      const { db, inserts } = createMockDb();
      const writer = createAuditIngestWriter({ db });
      const before = Date.now();

      await writer.writeToIngest({ eventType: 'auth.login.success' });

      const timestamp = inserts[0]!.values.timestamp as Date;
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(before);
      expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
      expect(inserts[0]!.values.emissionHash).toBe(
        computeEmissionHash({ eventType: 'auth.login.success' }, timestamp)
      );
    });

    it('given the insert rejects, should propagate the error to the caller (audit() wrapper owns the catch)', async () => {
      const failure = new Error('admin pg unreachable');
      const db = {
        insert: vi.fn(() => ({ values: () => Promise.reject(failure) })),
        transaction: vi.fn(),
        execute: vi.fn(),
        select: vi.fn(),
      } as unknown as AuditIngestWriterDeps['db'];
      const writer = createAuditIngestWriter({ db });

      await expect(writer.writeToIngest({ eventType: 'auth.login.success' })).rejects.toBe(failure);
    });

    it('DI: two writers built from two distinct db clients never cross-touch', async () => {
      const a = createMockDb();
      const b = createMockDb();
      const writerA = createAuditIngestWriter({ db: a.db });
      createAuditIngestWriter({ db: b.db });

      await writerA.writeToIngest({ eventType: 'auth.login.success' });

      expect(a.inserts).toHaveLength(1);
      expect(b.inserts).toHaveLength(0);
    });
  });

  describe('witness co-stream (leaf 4)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function createCoStreamLogger() {
      const lines: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      return {
        lines,
        coStreamLogger: {
          info: vi.fn((message: string, metadata?: Record<string, unknown>) => {
            lines.push({ message, metadata: metadata ?? {} });
          }),
        },
      };
    }

    it('given a successful insert, should emit exactly ONE co-stream line with the exact allowlisted shape', async () => {
      const { db, inserts } = createMockDb();
      const { lines, coStreamLogger } = createCoStreamLogger();
      const writer = createAuditIngestWriter({ db, coStreamLogger });
      const now = new Date('2026-02-01T00:10:00.000Z');
      const event: AuditEvent = {
        eventType: 'security.anomaly.detected',
        userId: 'user-1',
        sessionId: 'sess-1',
        ipAddress: '10.0.0.5',
        userAgent: 'UA/1.0',
        geoLocation: 'US-CA',
        details: { flag: 'impossible_travel' },
        riskScore: 0.9,
      };

      await writer.writeToIngest(event, { now });

      expect(lines).toHaveLength(1);
      expect(lines[0]!.message).toBe(CO_STREAM_LOG_MESSAGE);
      // Exact allowlist — nothing beyond the four witness fields, PII-free
      // by construction (no details, no IPs even encrypted).
      expect(Object.keys(lines[0]!.metadata).sort()).toEqual([
        'emissionHash', 'emittedAt', 'eventId', 'eventType',
      ]);
      expect(lines[0]!.metadata).toEqual({
        eventId: inserts[0]!.values.id,
        emissionHash: inserts[0]!.values.emissionHash,
        eventType: 'security.anomaly.detected',
        emittedAt: now.toISOString(),
      });
    });

    it('the co-stream eventId IS the ingest row id (writer-generated), so reconciliation can match by id', async () => {
      const { db, inserts } = createMockDb();
      const { lines, coStreamLogger } = createCoStreamLogger();
      const writer = createAuditIngestWriter({ db, coStreamLogger });

      await writer.writeToIngest({ eventType: 'auth.login.success' });
      await writer.writeToIngest({ eventType: 'auth.login.success' });

      expect(inserts[0]!.values.id).toEqual(expect.any(String));
      expect(lines[0]!.metadata.eventId).toBe(inserts[0]!.values.id);
      expect(lines[1]!.metadata.eventId).toBe(inserts[1]!.values.id);
      expect(lines[0]!.metadata.eventId).not.toBe(lines[1]!.metadata.eventId);
    });

    it('given the co-stream logger throws, the write still succeeds — best-effort witness, log-internal errors swallowed', async () => {
      const { db, inserts } = createMockDb();
      const coStreamLogger = {
        info: vi.fn(() => {
          throw new Error('collector down');
        }),
      };
      const writer = createAuditIngestWriter({ db, coStreamLogger });

      await expect(writer.writeToIngest({ eventType: 'auth.login.success' })).resolves.toBeUndefined();
      expect(inserts).toHaveLength(1);
      expect(coStreamLogger.info).toHaveBeenCalledTimes(1);
    });

    it('given the insert rejects, should emit NO co-stream line — the witness never records an event the store refused', async () => {
      const { coStreamLogger } = createCoStreamLogger();
      const db = {
        insert: vi.fn(() => ({ values: () => Promise.reject(new Error('admin pg unreachable')) })),
        transaction: vi.fn(),
        execute: vi.fn(),
        select: vi.fn(),
      } as unknown as AuditIngestWriterDeps['db'];
      const writer = createAuditIngestWriter({ db, coStreamLogger });

      await expect(writer.writeToIngest({ eventType: 'auth.login.success' })).rejects.toThrow('admin pg unreachable');
      expect(coStreamLogger.info).not.toHaveBeenCalled();
    });

    it('given no coStreamLogger dep, defaults to the security-category structured logger (stdout under LOG_DESTINATION stdout/both)', async () => {
      const securityInfo = vi.spyOn(loggers.security, 'info').mockImplementation(() => undefined);
      const { db } = createMockDb();
      const writer = createAuditIngestWriter({ db });

      await writer.writeToIngest(
        { eventType: 'auth.login.success' },
        { now: new Date('2026-02-01T00:10:00.000Z') }
      );

      expect(securityInfo).toHaveBeenCalledTimes(1);
      expect(securityInfo).toHaveBeenCalledWith(
        CO_STREAM_LOG_MESSAGE,
        expect.objectContaining({
          eventId: expect.any(String),
          emissionHash: expect.any(String),
          eventType: 'auth.login.success',
          emittedAt: '2026-02-01T00:10:00.000Z',
        })
      );
    });
  });
});
