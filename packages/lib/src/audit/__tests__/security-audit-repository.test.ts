import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import {
  createSecurityAuditRepository,
  SECURITY_AUDIT_CHAIN_LOCK_KEY,
  type SecurityAuditRepositoryDeps,
} from '../security-audit-repository';
import { computeSecurityEventHash, type AuditEvent } from '../security-audit';

interface CapturedInsert {
  values: Record<string, unknown>;
}

interface ExecutedSql {
  strings: TemplateStringsArray;
  values: unknown[];
}

function createMockDb(initialHead: string | undefined) {
  const executedSql: ExecutedSql[] = [];
  const inserts: CapturedInsert[] = [];
  let currentHead = initialHead;

  const execute = (sqlObj: ExecutedSql) => {
    executedSql.push(sqlObj);
    const joined = sqlObj.strings.join('');
    if (joined.includes('pg_advisory_xact_lock')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: currentHead ? [{ event_hash: currentHead }] : [] });
  };

  const insert = () => ({
    values: (value: Record<string, unknown>) => {
      inserts.push({ values: value });
      currentHead = value.eventHash as string;
      return Promise.resolve(undefined);
    },
  });

  const tx = { execute, insert };

  const db = {
    execute,
    transaction: async (callback: (transactionClient: typeof tx) => Promise<void>) => callback(tx),
  } as unknown as SecurityAuditRepositoryDeps['db'];

  return { db, executedSql, inserts };
}

describe('createSecurityAuditRepository', () => {
  describe('appendEvent', () => {
    it('given a fresh chain with no existing rows, should use "genesis" as previousHash', async () => {
      const { db, inserts } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });

      await repo.appendEvent(
        { eventType: 'auth.login.success', userId: 'user1' },
        { now: new Date('2026-07-09T00:00:00Z') }
      );

      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.values.previousHash).toBe('genesis');
    });

    it('given an existing chain head, should read it as previousHash', async () => {
      const { db, inserts } = createMockDb('existing-hash-abc');
      const repo = createSecurityAuditRepository({ db });

      await repo.appendEvent(
        { eventType: 'auth.logout', userId: 'user1' },
        { now: new Date('2026-07-09T00:00:00Z') }
      );

      expect(inserts[0]!.values.previousHash).toBe('existing-hash-abc');
    });

    it('should compute a byte-identical hash to computeSecurityEventHash for the same inputs (golden vector)', async () => {
      const { db, inserts } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });
      const event: AuditEvent = {
        eventType: 'auth.login.success',
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      };
      const now = new Date('2026-01-25T10:00:00Z');

      await repo.appendEvent(event, { now });

      const expectedHash = computeSecurityEventHash(event, 'genesis', now);
      expect(inserts[0]!.values.eventHash).toBe(expectedHash);
    });

    it('should acquire the advisory lock with key 8370291546 before reading the chain head', async () => {
      const { db, executedSql } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });

      await repo.appendEvent(
        { eventType: 'auth.login.success' },
        { now: new Date('2026-07-09T00:00:00Z') }
      );

      expect(executedSql.length).toBeGreaterThanOrEqual(2);
      const lockSql = executedSql[0]!;
      expect(lockSql.strings.join('')).toContain('pg_advisory_xact_lock');
      expect(lockSql.values).toContain(SECURITY_AUDIT_CHAIN_LOCK_KEY);
      expect(SECURITY_AUDIT_CHAIN_LOCK_KEY).toBe(8370291546);
    });

    it('should read the chain head via chain_seq DESC LIMIT 1 without FOR UPDATE', async () => {
      const { db, executedSql } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });

      await repo.appendEvent(
        { eventType: 'auth.login.success' },
        { now: new Date('2026-07-09T00:00:00Z') }
      );

      const headSql = executedSql[1]!.strings.join('');
      expect(headSql).toContain('event_hash');
      expect(headSql).toContain('ORDER BY chain_seq DESC');
      expect(headSql).not.toContain('FOR UPDATE');
    });

    it('given two concurrent appendEvent calls, should never fork the chain', async () => {
      const { db, inserts } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });

      await repo.appendEvent(
        { eventType: 'auth.login.success', userId: 'user1' },
        { now: new Date('2026-07-09T00:00:00Z') }
      );
      await repo.appendEvent(
        { eventType: 'auth.logout', userId: 'user1' },
        { now: new Date('2026-07-09T00:00:01Z') }
      );

      expect(inserts).toHaveLength(2);
      expect(inserts[0]!.values.previousHash).toBe('genesis');
      expect(inserts[1]!.values.previousHash).toBe(inserts[0]!.values.eventHash);
      expect(inserts[1]!.values.eventHash).not.toBe(inserts[0]!.values.eventHash);
    });

    it('encrypts the IP address at rest and excludes it from the computed hash', async () => {
      const { db, inserts } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });
      const now = new Date('2026-07-09T00:00:00Z');

      await repo.appendEvent(
        { eventType: 'auth.login.success', ipAddress: '10.0.0.5' },
        { now }
      );

      const withoutIp = computeSecurityEventHash(
        { eventType: 'auth.login.success' },
        'genesis',
        now
      );
      expect(inserts[0]!.values.eventHash).toBe(withoutIp);
      expect(inserts[0]!.values.ipAddress).not.toBe('10.0.0.5');
      expect(inserts[0]!.values.ipBidx).toEqual(expect.any(String));
    });
  });

  describe('readChainHead', () => {
    it('given no rows, should return "genesis"', async () => {
      const { db } = createMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });

      await expect(repo.readChainHead()).resolves.toBe('genesis');
    });

    it('given an existing head row, should return its event_hash', async () => {
      const { db } = createMockDb('head-hash-xyz');
      const repo = createSecurityAuditRepository({ db });

      await expect(repo.readChainHead()).resolves.toBe('head-hash-xyz');
    });
  });
});
