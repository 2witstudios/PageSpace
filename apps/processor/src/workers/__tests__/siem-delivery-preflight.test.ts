/**
 * Unit tests for the SIEM chain-verification preflight's store routing and
 * era-aware behavior (#890 Phase 2 leaf 7).
 *
 * The preflight now takes an explicit per-purpose client set instead of one
 * client: cursors live in the Admin PG for both sources, activity_logs data
 * stays on main, and security_audit_log data reads the plane the routing
 * matrix selected. These tests drive the REAL preflight + verifier + hashers
 * against pattern-matching client stubs that record which store served which
 * query — the pool-per-operation matrix for the preflight, pinned.
 */
import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { computeSecurityEventHash, type AuditEvent } from '@pagespace/lib/audit/security-audit';
import { computeEmissionHash } from '@pagespace/lib/audit/emission-hash';
import { computeChainHash } from '@pagespace/lib/audit/chain-step';
import { computeLogHash } from '@pagespace/lib/monitoring/activity-logger';
import type { AuditLogEntry } from '../../services/siem-adapter';
import { runChainPreflight, type PreflightStores } from '../siem-delivery-preflight';

interface RecordedCall {
  sql: string;
  params?: unknown[];
}

interface StubClient {
  calls: RecordedCall[];
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

type Responder = (sql: string, params?: unknown[]) => Record<string, unknown>[] | null;

function createStubClient(respond: Responder): StubClient {
  const calls: RecordedCall[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const rows = respond(sql, params);
      if (rows === null) {
        throw new Error(`Unhandled SQL in preflight test stub: ${sql.slice(0, 120)}`);
      }
      return { rows, rowCount: rows.length };
    },
  };
}

// --- security fixtures ------------------------------------------------------

const T = (s: number) => new Date(Date.UTC(2026, 3, 10, 9, 0, s));

interface SecurityFixtureRow {
  id: string;
  event: AuditEvent;
  timestamp: Date;
  previousHash: string;
  eventHash: string;
  emissionHash: string | null;
}

function legacySecurityRow(id: string, seconds: number, previousHash: string): SecurityFixtureRow {
  const event: AuditEvent = {
    eventType: 'auth.login.success',
    serviceId: 'web',
    resourceType: 'user',
    resourceId: `u-${id}`,
    details: { probe: id },
  };
  const timestamp = T(seconds);
  return {
    id,
    event,
    timestamp,
    previousHash,
    eventHash: computeSecurityEventHash(event, previousHash, timestamp),
    emissionHash: null,
  };
}

function chainerSecurityRow(id: string, seconds: number, previousHash: string): SecurityFixtureRow {
  const event: AuditEvent = {
    eventType: 'data.read',
    serviceId: 'web',
    resourceType: 'page',
    resourceId: `p-${id}`,
    details: { probe: id },
  };
  const timestamp = T(seconds);
  const emissionHash = computeEmissionHash(event, timestamp);
  return {
    id,
    event,
    timestamp,
    previousHash,
    eventHash: computeChainHash(emissionHash, previousHash),
    emissionHash,
  };
}

function securityEntry(row: SecurityFixtureRow): AuditLogEntry {
  return {
    id: row.id,
    source: 'security_audit_log',
    timestamp: row.timestamp,
    userId: null,
    actorEmail: 'system@pagespace',
    actorDisplayName: null,
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    aiConversationId: null,
    operation: row.event.eventType,
    resourceType: row.event.resourceType ?? 'unknown',
    resourceId: row.event.resourceId ?? 'unknown',
    resourceTitle: null,
    driveId: null,
    pageId: null,
    metadata: null,
    previousLogHash: row.previousHash,
    logHash: row.eventHash,
  };
}

function securityHashableRow(row: SecurityFixtureRow, plane: 'admin' | 'main'): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    eventType: row.event.eventType,
    serviceId: row.event.serviceId ?? null,
    resourceType: row.event.resourceType ?? null,
    resourceId: row.event.resourceId ?? null,
    details: row.event.details ?? null,
    riskScore: row.event.riskScore ?? null,
    anomalyFlags: row.event.anomalyFlags ?? null,
    timestamp: row.timestamp,
  };
  if (plane === 'admin') {
    base.emissionHash = row.emissionHash;
  }
  return base;
}

// --- activity fixtures ------------------------------------------------------

interface ActivityFixtureRow {
  id: string;
  timestamp: Date;
  previousLogHash: string;
  logHash: string;
  fields: Record<string, unknown>;
}

function activityRow(id: string, seconds: number, previousLogHash: string): ActivityFixtureRow {
  const timestamp = T(seconds);
  const hashable = {
    id,
    timestamp,
    operation: 'page.update',
    resourceType: 'page',
    resourceId: `p-${id}`,
    driveId: 'd1',
    pageId: `p-${id}`,
    contentSnapshot: undefined,
    previousValues: undefined,
    newValues: undefined,
    metadata: undefined,
  };
  return {
    id,
    timestamp,
    previousLogHash,
    logHash: computeLogHash(hashable, previousLogHash),
    fields: {
      id,
      timestamp,
      operation: 'page.update',
      resourceType: 'page',
      resourceId: `p-${id}`,
      driveId: 'd1',
      pageId: `p-${id}`,
      contentSnapshot: null,
      previousValues: null,
      newValues: null,
      metadata: null,
    },
  };
}

function activityEntry(row: ActivityFixtureRow): AuditLogEntry {
  return {
    id: row.id,
    source: 'activity_logs',
    timestamp: row.timestamp,
    userId: 'u1',
    actorEmail: 'user@example.com',
    actorDisplayName: null,
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    aiConversationId: null,
    operation: 'page.update',
    resourceType: 'page',
    resourceId: `p-${row.id}`,
    resourceTitle: null,
    driveId: 'd1',
    pageId: `p-${row.id}`,
    metadata: null,
    previousLogHash: row.previousLogHash,
    logHash: row.logHash,
  };
}

// --- stores wiring ----------------------------------------------------------

function cursorResponder(cursorBySource: Record<string, string>): Responder {
  return (sql, params) => {
    if (sql.includes('FROM siem_delivery_cursors WHERE id =')) {
      const source = String(params?.[0]);
      return [{ lastDeliveredId: cursorBySource[source] ?? null }];
    }
    return null;
  };
}

describe('runChainPreflight store routing (#890 Phase 2 leaf 7)', () => {
  // Shared fixture: a legacy security chain g -> s1 -> s2 living in the ADMIN
  // store (s1 backfilled legacy row, s2 chainer-era row) with the cursor
  // anchored at g; an activity chain a0 -> a1 on MAIN anchored at a0.
  const g = legacySecurityRow('sec-g', 0, 'genesis');
  const s1 = legacySecurityRow('sec-1', 1, g.eventHash);
  const s2 = chainerSecurityRow('sec-2', 2, s1.eventHash);
  const a0 = activityRow('act-0', 0, 'seed');
  const a1 = activityRow('act-1', 1, a0.logHash);

  function dedicatedStores(overrides?: Partial<PreflightStores>): {
    stores: PreflightStores;
    cursors: StubClient;
    activityData: StubClient;
    securityData: StubClient;
    legacyStore: StubClient;
  } {
    const cursors = createStubClient(
      cursorResponder({ security_audit_log: g.id, activity_logs: a0.id })
    );
    const activityData = createStubClient((sql, params) => {
      if (sql.includes('SELECT "logHash" FROM activity_logs WHERE id = $1')) {
        return params?.[0] === a0.id ? [{ logHash: a0.logHash }] : [];
      }
      if (sql.includes('FROM activity_logs') && sql.includes('id = ANY($1)')) {
        return [a1.fields];
      }
      return null;
    });
    const securityData = createStubClient((sql, params) => {
      if (sql.includes('SELECT event_hash AS "logHash" FROM security_audit_log WHERE id = $1')) {
        return params?.[0] === g.id ? [{ logHash: g.eventHash }] : [];
      }
      if (sql.includes('FROM security_audit_log') && sql.includes('id = ANY($1)')) {
        return [securityHashableRow(s1, 'admin'), securityHashableRow(s2, 'admin')];
      }
      return null;
    });
    const legacyStore = createStubClient((sql) => {
      if (sql.includes('SELECT 1 FROM security_audit_log WHERE id = $1')) {
        return [{ '?column?': 1 }];
      }
      return null;
    });
    return {
      stores: {
        cursors,
        activityData,
        securityData,
        securityPlane: 'admin',
        legacySecurityStore: legacyStore,
        ...overrides,
      },
      cursors,
      activityData,
      securityData,
      legacyStore,
    };
  }

  const mergedBoth = [activityEntry(a1), securityEntry(s1), securityEntry(s2)];

  it('given a clean dual-era batch, should verify each source against ITS store and pass', async () => {
    const { stores, cursors, activityData, securityData } = dedicatedStores();

    const result = await runChainPreflight(stores, mergedBoth);

    assert({
      given: 'a clean batch spanning a backfilled legacy row and a chainer-era row',
      should: 'pass preflight',
      actual: result,
      expected: null,
    });
    assert({
      given: 'the dedicated routing',
      should: 'read both cursors from the cursors store only',
      actual: {
        cursorReads: cursors.calls.filter((c) => c.sql.includes('siem_delivery_cursors')).length,
        cursorReadsOnActivity: activityData.calls.filter((c) => c.sql.includes('siem_delivery_cursors')).length,
        cursorReadsOnSecurity: securityData.calls.filter((c) => c.sql.includes('siem_delivery_cursors')).length,
      },
      expected: { cursorReads: 2, cursorReadsOnActivity: 0, cursorReadsOnSecurity: 0 },
    });
    assert({
      given: 'the dedicated routing',
      should: 'load the security anchor + hashables from the ADMIN store and activity from MAIN',
      actual: {
        securityQueriesOnAdmin: securityData.calls.filter((c) => c.sql.includes('security_audit_log')).length >= 2,
        securityQueriesOnMainData: activityData.calls.filter((c) => c.sql.includes('security_audit_log')).length,
        activityQueriesOnMain: activityData.calls.filter((c) => c.sql.includes('activity_logs')).length >= 2,
        activityQueriesOnAdmin: securityData.calls.filter((c) => c.sql.includes('activity_logs')).length,
      },
      expected: {
        securityQueriesOnAdmin: true,
        securityQueriesOnMainData: 0,
        activityQueriesOnMain: true,
        activityQueriesOnAdmin: 0,
      },
    });
  });

  it('given a tampered chainer-era row, should halt with hash_mismatch (era-aware recompute)', async () => {
    const tamperedS2 = { ...securityEntry(s2) };
    const { stores } = dedicatedStores();
    // Serve tampered DATA for s2 from the admin store: details changed after
    // chaining — the era-aware recompute must derive a different emission.
    const securityData = createStubClient((sql, params) => {
      if (sql.includes('SELECT event_hash AS "logHash" FROM security_audit_log WHERE id = $1')) {
        return params?.[0] === g.id ? [{ logHash: g.eventHash }] : [];
      }
      if (sql.includes('FROM security_audit_log') && sql.includes('id = ANY($1)')) {
        return [
          securityHashableRow(s1, 'admin'),
          { ...securityHashableRow(s2, 'admin'), details: { probe: 'FORGED' } },
        ];
      }
      return null;
    });

    const result = await runChainPreflight(
      { ...stores, securityData },
      [securityEntry(s1), tamperedS2]
    );

    assert({
      given: 'a chainer-era row whose details were modified in the admin store',
      should: 'halt with tamper/hash_mismatch on that entry',
      actual: result && result.kind === 'tamper'
        ? { kind: result.kind, entryId: result.entryId, breakReason: result.breakReason }
        : result,
      expected: { kind: 'tamper', entryId: s2.id, breakReason: 'hash_mismatch' },
    });
  });

  it('given the anchor row missing from admin but present in main, should defer with awaiting_backfill (and still verify activity)', async () => {
    const { stores, legacyStore, activityData } = dedicatedStores({
      securityData: createStubClient((sql) => {
        if (sql.includes('SELECT event_hash AS "logHash" FROM security_audit_log WHERE id = $1')) {
          return []; // anchor not yet backfilled into the admin store
        }
        return null;
      }),
    });

    const result = await runChainPreflight(stores, mergedBoth);

    assert({
      given: 'a seeded cursor whose anchor row is not yet backfilled',
      should: 'return awaiting_backfill for security_audit_log',
      actual: result,
      expected: {
        kind: 'awaiting_backfill',
        source: 'security_audit_log',
        anchorId: g.id,
      },
    });
    assert({
      given: 'the awaiting-backfill probe',
      should: 'check the legacy main store for the anchor row',
      actual: legacyStore.calls.some((c) =>
        c.sql.includes('SELECT 1 FROM security_audit_log WHERE id = $1') && c.params?.[0] === g.id
      ),
      expected: true,
    });
    assert({
      given: 'a deferral on the security source',
      should: 'still have verified activity_logs against main',
      actual: activityData.calls.filter((c) => c.sql.includes('activity_logs')).length >= 2,
      expected: true,
    });
  });

  it('given the anchor row missing from BOTH stores, should fail closed with db_error (anchor loss is not backfill lag)', async () => {
    const { stores } = dedicatedStores({
      securityData: createStubClient((sql) => {
        if (sql.includes('SELECT event_hash AS "logHash" FROM security_audit_log WHERE id = $1')) {
          return [];
        }
        return null;
      }),
      legacySecurityStore: createStubClient((sql) => {
        if (sql.includes('SELECT 1 FROM security_audit_log WHERE id = $1')) {
          return [];
        }
        return null;
      }),
    });

    const result = await runChainPreflight(stores, [securityEntry(s1)]);

    assert({
      given: 'an anchor row absent from admin AND main',
      should: 'halt fail-closed as a db_error on the security source',
      actual: result ? { kind: result.kind, source: result.source } : result,
      expected: { kind: 'db_error', source: 'security_audit_log' },
    });
  });

  it('given break-glass (securityPlane main, no legacy probe store), should verify the legacy chain on the main store without emission_hash SQL', async () => {
    const cursors = createStubClient(cursorResponder({ security_audit_log: g.id }));
    const mainData = createStubClient((sql, params) => {
      if (sql.includes('SELECT event_hash AS "logHash" FROM security_audit_log WHERE id = $1')) {
        return params?.[0] === g.id ? [{ logHash: g.eventHash }] : [];
      }
      if (sql.includes('FROM security_audit_log') && sql.includes('id = ANY($1)')) {
        return [securityHashableRow(s1, 'main')];
      }
      return null;
    });

    const result = await runChainPreflight(
      {
        cursors,
        activityData: mainData,
        securityData: mainData,
        securityPlane: 'main',
        legacySecurityStore: null,
      },
      [securityEntry(s1)]
    );

    assert({
      given: 'break-glass routing with a clean legacy chain',
      should: 'pass preflight',
      actual: result,
      expected: null,
    });
    assert({
      given: 'a main-plane hashable load',
      should: 'never reference emission_hash',
      actual: mainData.calls.some((c) => c.sql.includes('emission_hash')),
      expected: false,
    });
  });
});
