/**
 * Phase 2 gate (#890): the Phase 0 seams must TYPE-accept the AdminDatabase
 * client (@pagespace/db/admin-db) so the later bind leaves can wire
 * `createSecurityAuditRepository({ db: getAdminDb() })` without casts.
 *
 * Filed from PR #1982's convergence findings: `SecurityAuditRepositoryDeps.db`
 * was `typeof defaultDb`, and AdminDatabase (NodePgDatabase over the 3-table
 * admin schema) is NOT assignable to it. This suite is the compile-level pin —
 * the `satisfies`/annotation lines below fail `tsc` if the seam ever narrows
 * back — plus a behavioral smoke test that an AdminDatabase-typed client is
 * actually used. Runtime behavior is pinned by the Phase 0 suites; nothing
 * here may change it.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  desc: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  eq: vi.fn(),
}));

import type { AdminDatabase } from '@pagespace/db/admin-db';
import { db as defaultDb } from '@pagespace/db/db';
import {
  createSecurityAuditRepository,
  type SecurityAuditRepositoryDeps,
} from '../security-audit-repository';
import { queryAuditEvents, type AuditQueryDeps } from '../audit-query';
import {
  verifySecurityAuditChain,
  type VerifySecurityChainDeps,
} from '../security-audit-chain-verifier';
import { computeSecurityEventHash } from '../security-audit';

/**
 * Behavioral mock shaped like the drizzle surface the repository uses, typed
 * AS AdminDatabase at the deps boundary (the cast is on the MOCK — the deps
 * property itself must accept the AdminDatabase type with no cast, which is
 * exactly what the annotations below pin at compile time).
 */
function createAdminTypedMockDb(initialHead: string | undefined) {
  const inserts: Array<Record<string, unknown>> = [];
  let currentHead = initialHead;

  const execute = (sqlObj: { strings: TemplateStringsArray; values: unknown[] }) => {
    if (sqlObj.strings.join('').includes('pg_advisory_xact_lock')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: currentHead ? [{ event_hash: currentHead }] : [] });
  };
  const insert = () => ({
    values: (value: Record<string, unknown>) => {
      inserts.push(value);
      currentHead = value.eventHash as string;
      return Promise.resolve(undefined);
    },
  });
  const tx = { execute, insert };
  const db = {
    execute,
    transaction: async (callback: (transactionClient: typeof tx) => Promise<void>) =>
      callback(tx),
  } as unknown as AdminDatabase;

  return { db, inserts };
}

describe('Phase 0 seams accept the AdminDatabase client (Phase 2 gate)', () => {
  describe('compile-level: deps types are satisfied by AdminDatabase AND the main db', () => {
    it('SecurityAuditRepositoryDeps.db accepts AdminDatabase and typeof db', () => {
      // These annotations are the test: they fail tsc if the seam narrows.
      const adminDeps: SecurityAuditRepositoryDeps = { db: {} as AdminDatabase };
      const mainDeps: SecurityAuditRepositoryDeps = { db: defaultDb };
      expect(adminDeps.db).toBeDefined();
      expect(mainDeps.db).toBeDefined();
    });

    it('VerifySecurityChainDeps.db accepts AdminDatabase and typeof db', () => {
      const adminDeps: VerifySecurityChainDeps = { db: {} as AdminDatabase };
      const mainDeps: VerifySecurityChainDeps = { db: defaultDb };
      expect(adminDeps.db).toBeDefined();
      expect(mainDeps.db).toBeDefined();
    });

    it('AuditQueryDeps.db accepts AdminDatabase and typeof db', () => {
      const adminDeps: AuditQueryDeps = { db: {} as AdminDatabase };
      const mainDeps: AuditQueryDeps = { db: defaultDb };
      expect(adminDeps.db).toBeDefined();
      expect(mainDeps.db).toBeDefined();
    });
  });

  describe('behavioral smoke: an AdminDatabase-typed client is accepted and used', () => {
    it('createSecurityAuditRepository appends through the admin-typed client with unchanged chain semantics', async () => {
      const { db, inserts } = createAdminTypedMockDb(undefined);
      const repo = createSecurityAuditRepository({ db });
      const now = new Date('2026-07-10T00:00:00Z');

      await repo.appendEvent({ eventType: 'auth.login.success', userId: 'user-1' }, { now });

      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.previousHash).toBe('genesis');
      expect(inserts[0]!.eventHash).toBe(
        computeSecurityEventHash({ eventType: 'auth.login.success', userId: 'user-1' }, 'genesis', now),
      );
    });

    it('readChainHead reads through the admin-typed client', async () => {
      const { db } = createAdminTypedMockDb('admin-head-hash');
      const repo = createSecurityAuditRepository({ db });

      await expect(repo.readChainHead()).resolves.toBe('admin-head-hash');
    });

    it('verifySecurityAuditChain runs against an admin-typed client', async () => {
      const select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
      });
      const findMany = vi.fn().mockResolvedValue([]);
      const db = { select, query: { securityAuditLog: { findMany } } } as unknown as AdminDatabase;

      const result = await verifySecurityAuditChain({}, { db });

      expect(select).toHaveBeenCalled();
      expect(result.isValid).toBe(true);
    });

    it('queryAuditEvents runs against an admin-typed client', async () => {
      const orderBy = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
        then: (resolveFn: (v: unknown[]) => void) => resolveFn([]),
      });
      const where = vi.fn().mockReturnValue({ orderBy });
      const from = vi.fn().mockReturnValue({ where });
      const select = vi.fn().mockReturnValue({ from });
      const db = { select } as unknown as AdminDatabase;

      await expect(queryAuditEvents({}, { db })).resolves.toEqual([]);

      expect(select).toHaveBeenCalled();
    });
  });
});
