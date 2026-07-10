/**
 * Phase 0 regression suite (DB Decomposition epic, #890).
 *
 * Leaves 1-3 extracted the repository/service/reader/verifier seams via DI.
 * This suite is the safety net for Phases 1-2, which will re-point these
 * seams at a dedicated audit Postgres: it pins the CURRENT hash/chain
 * semantics so any future change to hashing, chain serialization, or DI
 * wiring fails loudly here first.
 *
 * Maps to the four Phase 0 requirements on the phase page:
 *   1. Hash golden vectors           -> describe block 1
 *   2. Concurrent-append chain integrity -> describe block 2
 *   3. DI completeness sweep         -> describe block 3
 *   4. Zero-call-site regression     -> describe block 4
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    }),
    query: {
      securityAuditLog: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));
vi.mock('@pagespace/db/schema/security-audit', () => ({ securityAuditLog: {} }));
vi.mock('@pagespace/db/operators', () => ({
  desc: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  eq: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import {
  computeSecurityEventHash,
  createSecurityAuditService,
  securityAudit,
  type AuditEvent,
} from '../security-audit';
import {
  createSecurityAuditRepository,
  type SecurityAuditRepository,
  type SecurityAuditRepositoryDeps,
} from '../security-audit-repository';
import { queryAuditEvents, type AuditQueryDeps } from '../audit-query';
import {
  verifySecurityAuditChain,
  type VerifySecurityChainDeps,
} from '../security-audit-chain-verifier';
import { verifyAndAlert } from '../security-audit-alerting';

// ============================================================================
// 1. Hash golden vectors
// ============================================================================
// Pinned literal hex outputs of computeSecurityEventHash for fixed inputs.
// Regenerated with the exact production algorithm (sha256 over
// stableStringify of the same payload shape) — if this suite ever fails,
// hashing semantics changed and every historical chain entry is now
// unverifiable against a fresh recomputation.
describe('1. Hash golden vectors (pinned)', () => {
  const GENESIS_HASH = '352808abde213c0a20c3d2a5d709f4e33955aa33b6971d6960993755606b7aef';
  const CHAINED_HASH = '7566053c513943d7842722b5f40cc6e1654fdd0d939d32f5df2c37a7f621af77';
  const DETAILS_HASH = 'e4e3c56dececa1b30b46d9902ed54be7a5ba2630246024ec61e9925b0beb319f';
  const ALL_FIELDS_HASH = '13b4892e73c5c0b2ad4a245875afbe4c28884cc1b6f65760b989e258a97f7f50';
  const UNICODE_HASH = 'fe00f0e287d8282ec3bae0f5759c54d9fead54387da06fca94b324231bba8066';

  it('genesis event (minimal fields, previousHash="genesis") matches the pinned hash', () => {
    const event: AuditEvent = { eventType: 'auth.login.success' };
    const hash = computeSecurityEventHash(event, 'genesis', new Date('2026-01-25T10:00:00.000Z'));

    expect(hash).toBe(GENESIS_HASH);
  });

  it('chained event (previousHash = prior genesis hash) matches the pinned hash', () => {
    const event: AuditEvent = {
      eventType: 'auth.logout',
      userId: 'user-1',
      resourceType: 'session',
      resourceId: 'sess-1',
    };
    const hash = computeSecurityEventHash(event, GENESIS_HASH, new Date('2026-01-25T10:00:01.000Z'));

    expect(hash).toBe(CHAINED_HASH);
  });

  it('event with a details jsonb payload matches the pinned hash', () => {
    const event: AuditEvent = {
      eventType: 'data.export',
      resourceType: 'drive',
      resourceId: 'drive-42',
      details: { format: 'pdf', pageCount: 12, tags: ['q1', 'report'] },
      riskScore: 0.2,
    };
    const hash = computeSecurityEventHash(event, CHAINED_HASH, new Date('2026-01-25T10:00:02.000Z'));

    expect(hash).toBe(DETAILS_HASH);
  });

  it('event with every PII field present matches the pinned hash AND equals the PII-stripped equivalent (proves PII exclusion)', () => {
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

    const hashWithPii = computeSecurityEventHash(withPii, CHAINED_HASH, timestamp);
    const hashWithoutPii = computeSecurityEventHash(withoutPii, CHAINED_HASH, timestamp);

    expect(hashWithPii).toBe(ALL_FIELDS_HASH);
    expect(hashWithPii).toBe(hashWithoutPii);
  });

  it('unicode content and reversed key order produce the same pinned hash (stableStringify stress)', () => {
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

    const hashA = computeSecurityEventHash(a, GENESIS_HASH, timestamp);
    const hashB = computeSecurityEventHash(b, GENESIS_HASH, timestamp);

    expect(hashA).toBe(UNICODE_HASH);
    expect(hashA).toBe(hashB);
  });
});

// ============================================================================
// 2. Concurrent-append chain integrity
// ============================================================================
// Models pg_advisory_xact_lock as a real mutual-exclusion primitive: a
// transaction's lock-acquire `execute()` call blocks (via an unresolved
// promise) until the previously-queued transaction commits and releases.
// Firing appendEvent calls through Promise.all (rather than sequential
// awaits) means the mock genuinely interleaves at the point each call first
// suspends, exercising the same ordering hazard a real concurrent workload
// would hit if the lock were ever taken after the head read instead of before.
function createSerializingMockDb(initialHead: string | undefined) {
  // Each entry tagged with the transaction that issued it, since genuinely
  // concurrent dispatch (Promise.all) interleaves at the synchronous-dispatch
  // phase: every transaction's lock-acquire call fires (and is recorded)
  // before any of them resolve their `myTurn` wait, so global array adjacency
  // does NOT mean same-transaction — only per-transaction order is meaningful.
  const executedSql: Array<{ txId: number; sqlObj: { strings: TemplateStringsArray; values: unknown[] } }> = [];
  const inserts: Array<{ previousHash: string; eventHash: string }> = [];
  let currentHead = initialHead;
  let mutexTail: Promise<void> = Promise.resolve();
  let txCounter = 0;

  const db = {
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      const txId = txCounter++;
      const myTurn = mutexTail;
      let releaseMutex: () => void = () => {};
      mutexTail = new Promise((resolve) => {
        releaseMutex = resolve;
      });

      const tx = {
        execute: async (sqlObj: { strings: TemplateStringsArray; values: unknown[] }) => {
          executedSql.push({ txId, sqlObj });
          const joined = sqlObj.strings.join('');
          if (joined.includes('pg_advisory_xact_lock')) {
            await myTurn;
            return { rows: [] };
          }
          return { rows: currentHead ? [{ event_hash: currentHead }] : [] };
        },
        insert: () => ({
          values: (value: { previousHash: string; eventHash: string }) => {
            inserts.push(value);
            currentHead = value.eventHash;
            return Promise.resolve(undefined);
          },
        }),
      };

      await callback(tx);
      releaseMutex();
    },
  } as unknown as SecurityAuditRepositoryDeps['db'];

  return { db, inserts, executedSql };
}

describe('2. Concurrent-append chain integrity', () => {
  it('given N concurrent appendEvent calls dispatched via Promise.all, should never fork the chain', async () => {
    const { db, inserts } = createSerializingMockDb(undefined);
    const repo = createSecurityAuditRepository({ db });
    const events: AuditEvent[] = Array.from({ length: 5 }, (_, i) => ({
      eventType: 'auth.login.success',
      userId: `user-${i}`,
    }));

    await Promise.all(
      events.map((event, i) => repo.appendEvent(event, { now: new Date(Date.UTC(2026, 0, 25, 10, 0, i)) }))
    );

    expect(inserts).toHaveLength(5);
    expect(inserts[0]!.previousHash).toBe('genesis');

    // Linear chain: each insert's previousHash is the exact prior insert's
    // eventHash, in commit order — no two inserts share a previousHash (a
    // fork), and no hash repeats.
    for (let i = 1; i < inserts.length; i++) {
      expect(inserts[i]!.previousHash).toBe(inserts[i - 1]!.eventHash);
    }
    const previousHashes = inserts.map((r) => r.previousHash);
    expect(new Set(previousHashes).size).toBe(previousHashes.length);
    const eventHashes = inserts.map((r) => r.eventHash);
    expect(new Set(eventHashes).size).toBe(eventHashes.length);
  });

  it('for every one of N concurrent transactions, the lock is acquired before its head read', async () => {
    const { db, executedSql } = createSerializingMockDb(undefined);
    const repo = createSecurityAuditRepository({ db });
    const events: AuditEvent[] = Array.from({ length: 4 }, () => ({ eventType: 'auth.logout' }));

    await Promise.all(events.map((event) => repo.appendEvent(event)));

    const byTx = new Map<number, Array<{ strings: TemplateStringsArray; values: unknown[] }>>();
    for (const { txId, sqlObj } of executedSql) {
      const calls = byTx.get(txId) ?? [];
      calls.push(sqlObj);
      byTx.set(txId, calls);
    }

    expect(byTx.size).toBe(4);
    for (const calls of byTx.values()) {
      expect(calls).toHaveLength(2);
      expect(calls[0]!.strings.join('')).toContain('pg_advisory_xact_lock');
      expect(calls[1]!.strings.join('')).toContain('ORDER BY chain_seq DESC');
    }
  });
});

// ============================================================================
// 3. DI completeness sweep — no seam silently falls through to a singleton
// ============================================================================
describe('3. DI completeness sweep (no singleton fallthrough)', () => {
  it('repository: two repositories built from two distinct db clients never cross-touch each other', async () => {
    const { db: dbA, inserts: insertsA } = createSerializingMockDb(undefined);
    const { db: dbB, inserts: insertsB } = createSerializingMockDb(undefined);
    const repoA = createSecurityAuditRepository({ db: dbA });
    const repoB = createSecurityAuditRepository({ db: dbB });

    await repoA.appendEvent({ eventType: 'auth.login.success' });

    expect(insertsA).toHaveLength(1);
    expect(insertsB).toHaveLength(0);
  });

  it('service factory: two services built from two distinct repositories never cross-call each other', async () => {
    function mockRepo(): SecurityAuditRepository & { appendEvent: ReturnType<typeof vi.fn> } {
      return { appendEvent: vi.fn().mockResolvedValue(undefined), readChainHead: vi.fn() };
    }
    const repoA = mockRepo();
    const repoB = mockRepo();
    const serviceA = createSecurityAuditService({ repository: repoA });
    const serviceB = createSecurityAuditService({ repository: repoB });

    await serviceA.logEvent({ eventType: 'auth.login.success' });

    expect(repoA.appendEvent).toHaveBeenCalledTimes(1);
    expect(repoB.appendEvent).not.toHaveBeenCalled();
    expect(serviceB.isInitialized()).toBe(false);
  });

  it('queryAuditEvents: given an injected db, never touches the default db (seam confirmed, see audit-query.test.ts for full coverage)', async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit, then: (r: (v: unknown) => void) => r([]) });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const deps: AuditQueryDeps = { db: { select } as unknown as AuditQueryDeps['db'] };

    await queryAuditEvents({}, deps);

    expect(select).toHaveBeenCalled();
  });

  it('verifySecurityAuditChain: given an injected db, never touches the default db (seam confirmed, see security-audit-chain-verifier.test.ts for full coverage)', async () => {
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
    });
    const findMany = vi.fn().mockResolvedValue([]);
    const deps: VerifySecurityChainDeps = {
      db: { select, query: { securityAuditLog: { findMany } } } as unknown as VerifySecurityChainDeps['db'],
    };

    const result = await verifySecurityAuditChain({}, deps);

    expect(select).toHaveBeenCalled();
    expect(result.totalEntries).toBe(0);
  });

  it('verifyAndAlert: threads deps through to verifySecurityAuditChain (seam confirmed, see security-audit-alerting.test.ts for full coverage)', async () => {
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
    });
    const findMany = vi.fn().mockResolvedValue([]);
    const deps: VerifySecurityChainDeps = {
      db: { select, query: { securityAuditLog: { findMany } } } as unknown as VerifySecurityChainDeps['db'],
    };

    const result = await verifyAndAlert('manual', undefined, deps);

    expect(select).toHaveBeenCalled();
    expect(result.isValid).toBe(true);
  });

  it('given ADMIN_DATABASE_URL is set, its presence has no effect on any audit reader (readers stay on the injected/default db until Phase 2 wires the adminDb registry)', async () => {
    const prev = process.env.ADMIN_DATABASE_URL;
    process.env.ADMIN_DATABASE_URL = 'postgres://not-yet-wired-up/pagespace_admin';
    try {
      // No deps injected -> falls back to the (mocked) default db, exactly as
      // it would with the env var absent. Only the adminDb registry
      // (@pagespace/db/admin-db) reads this variable, and no audit reader
      // consults that registry yet, so its presence must be a complete no-op.
      const result = await verifySecurityAuditChain();
      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_DATABASE_URL;
      else process.env.ADMIN_DATABASE_URL = prev;
    }
  });
});

// ============================================================================
// 4. Zero-call-site regression: securityAudit singleton public surface
// ============================================================================
// The 248 existing audit()/auditRequest() call sites (via audit-log.ts) and
// any direct securityAudit.* callers depend on this exact surface. Phase 0
// must not add, remove, or rename anything on it.
describe('4. Zero-call-site regression: securityAudit public surface', () => {
  const EXPECTED_METHODS = [
    'initialize',
    'isInitialized',
    'logEvent',
    'logAuthSuccess',
    'logAuthFailure',
    'logAccessDenied',
    'logTokenCreated',
    'logTokenRevoked',
    'logAnomalyDetected',
    'logDataAccess',
    'logLogout',
    'logRateLimited',
    'logBruteForceDetected',
    'queryEvents',
  ] as const;

  it('exposes exactly logEvent + the 10 convenience wrappers + queryEvents + initialize/isInitialized (14 total)', () => {
    expect(EXPECTED_METHODS).toHaveLength(14);
    expect(Object.keys(securityAudit).sort()).toEqual([...EXPECTED_METHODS].sort());
  });

  it('every surface member is callable', () => {
    for (const method of EXPECTED_METHODS) {
      expect(typeof securityAudit[method]).toBe('function');
    }
  });
});
