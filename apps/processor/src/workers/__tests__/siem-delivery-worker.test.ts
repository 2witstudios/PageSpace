import { beforeEach, describe, it, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';

const {
  mockLoadSiemConfig,
  mockValidateSiemConfig,
  mockDeliverToSiemWithRetry,
  mockQuery,
  mockRelease,
  mockRunChainPreflight,
  mockNotifyChainPreflightFailure,
} = vi.hoisted(() => {
  const mockLoadSiemConfig = vi.fn();
  const mockValidateSiemConfig = vi.fn();
  const mockDeliverToSiemWithRetry = vi.fn();
  const mockQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockRunChainPreflight = vi.fn();
  const mockNotifyChainPreflightFailure = vi.fn();

  return {
    mockLoadSiemConfig,
    mockValidateSiemConfig,
    mockDeliverToSiemWithRetry,
    mockQuery,
    mockRelease,
    mockRunChainPreflight,
    mockNotifyChainPreflightFailure,
  };
});

vi.mock('../../services/siem-adapter', async () => {
  const actual = await vi.importActual<typeof import('../../services/siem-adapter')>(
    '../../services/siem-adapter'
  );
  return {
    ...actual,
    loadSiemConfig: mockLoadSiemConfig,
    validateSiemConfig: mockValidateSiemConfig,
    deliverToSiemWithRetry: mockDeliverToSiemWithRetry,
  };
});

vi.mock('../../db', () => ({
  getPoolForWorker: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    }),
  })),
}));

// Default preflight stub: returns null (chain verifies clean, no halt). Tests
// that exercise preflight tamper paths override this via mockRunChainPreflight
// in-test. Pre-preflight tests (Wave 2 and earlier) see a no-op so they don't
// have to stub the extra cursor/anchor/hashable DB calls the real preflight
// would issue.
vi.mock('../siem-delivery-preflight', () => ({
  runChainPreflight: mockRunChainPreflight,
}));

vi.mock('@pagespace/lib/audit', () => ({
  notifyChainPreflightFailure: mockNotifyChainPreflightFailure,
}));

import { processSiemDelivery, SOURCES } from '../siem-delivery-worker';
import type { AuditLogSource } from '../../services/siem-adapter';

const WEBHOOK_CONFIG = {
  enabled: true,
  type: 'webhook' as const,
  webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
};

// --- Mock query helpers ---------------------------------------------------

function stubLockAcquired() {
  mockQuery.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });
}

function stubLockRelease() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

/** Cursor row returned from SELECT — pre-seeded, ready to poll */
function stubCursorRow(lastDeliveredId: string, lastDeliveredAt: Date, deliveryCount = 0) {
  mockQuery.mockResolvedValueOnce({
    rows: [{ lastDeliveredId, lastDeliveredAt, deliveryCount }],
    rowCount: 1,
  });
}

/** Cursor row missing — triggers init INSERT in worker */
function stubCursorMissing() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

/** Response for the init INSERT (UPSERT with RETURNING) — returns the
 *  planted row so the worker can use the DB-side statement_timestamp. */
function stubCursorInit(plantedAt: Date = new Date()) {
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        lastDeliveredId: '__cursor_init__',
        lastDeliveredAt: plantedAt,
        deliveryCount: 0,
      },
    ],
    rowCount: 1,
  });
}

/** Response for a source rows SELECT */
function stubSourceRows<T>(rows: T[]) {
  mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

/** Response for cursor advance UPSERT */
function stubCursorAdvance() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
}

/** Response for error UPSERT */
function stubErrorUpsert() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
}

// --- Row factories --------------------------------------------------------

function makeActivityRow(id: string, timestamp: Date, overrides: Record<string, unknown> = {}) {
  return {
    id,
    timestamp,
    userId: 'u1',
    actorEmail: 'a@b.com',
    actorDisplayName: 'A',
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    aiConversationId: null,
    operation: 'page.create',
    resourceType: 'page',
    resourceId: 'p1',
    resourceTitle: null,
    driveId: null,
    pageId: null,
    metadata: null,
    previousLogHash: null,
    logHash: null,
    ...overrides,
  };
}

function makeSecurityRow(id: string, timestamp: Date, overrides: Record<string, unknown> = {}) {
  return {
    id,
    timestamp,
    eventType: 'auth.login.success',
    userId: 'u1',
    sessionId: 'sess_1',
    serviceId: null,
    resourceType: 'user',
    resourceId: 'u1',
    ipAddress: '10.0.0.1',
    userAgent: 'Mozilla/5.0',
    geoLocation: null,
    details: null,
    riskScore: null,
    anomalyFlags: null,
    previousHash: 'prev_hash',
    eventHash: 'event_hash',
    ...overrides,
  };
}

// --- Assertion helpers ----------------------------------------------------

/** Find the index of the first mockQuery call whose SQL includes the needle */
function findCallContaining(needle: string): number {
  return mockQuery.mock.calls.findIndex((call) => typeof call[0] === 'string' && (call[0] as string).includes(needle));
}

/** Find all mockQuery calls whose SQL includes the needle */
function findAllCallsContaining(needle: string): unknown[][] {
  return mockQuery.mock.calls.filter(
    (call) => typeof call[0] === 'string' && (call[0] as string).includes(needle)
  );
}

describe('processSiemDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: preflight verifies clean. Individual tamper tests override this.
    mockRunChainPreflight.mockResolvedValue(null);
    mockNotifyChainPreflightFailure.mockResolvedValue(undefined);
  });

  it('short-circuit when SIEM disabled', async () => {
    mockLoadSiemConfig.mockReturnValue({ enabled: false, type: 'webhook' });

    await processSiemDelivery();

    assert({
      given: 'SIEM is disabled',
      should: 'not query the database',
      actual: mockQuery.mock.calls.length,
      expected: 0,
    });

    assert({
      given: 'SIEM is disabled',
      should: 'not attempt delivery',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });
  });

  it('short-circuit when config is invalid', async () => {
    mockLoadSiemConfig.mockReturnValue({ enabled: true, type: 'webhook', webhook: { url: '', secret: '' } });
    mockValidateSiemConfig.mockReturnValue({ valid: false, errors: ['AUDIT_WEBHOOK_URL is required'] });

    await processSiemDelivery();

    assert({
      given: 'an invalid SIEM config',
      should: 'not query the database',
      actual: mockQuery.mock.calls.length,
      expected: 0,
    });
  });

  it('skips processing when advisory lock is not acquired', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    mockQuery.mockResolvedValueOnce({ rows: [{ acquired: false }], rowCount: 1 });

    await processSiemDelivery();

    assert({
      given: 'advisory lock not acquired',
      should: 'only issue the lock query (no cursor/logs queries)',
      actual: mockQuery.mock.calls.length,
      expected: 1,
    });

    assert({
      given: 'advisory lock not acquired',
      should: 'not attempt delivery',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });
  });

  it('successful delivery updates cursor', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    // activity_logs cursor pre-seeded so it polls normally
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 10);
    const activityRows = [
      makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z'), { logHash: 'h1' }),
      makeActivityRow('log_2', new Date('2026-04-10T12:01:00Z'), { previousLogHash: 'h1', logHash: 'h2' }),
    ];
    stubSourceRows(activityRows);
    // security_audit_log cursor pre-seeded, empty rows
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 5);
    stubSourceRows([]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 2 });

    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'successful delivery of 2 entries',
      should: 'call deliverToSiemWithRetry once',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 1,
    });

    assert({
      given: 'successful delivery',
      should: 'pass the config to delivery',
      actual: mockDeliverToSiemWithRetry.mock.calls[0][0],
      expected: WEBHOOK_CONFIG,
    });

    assert({
      given: 'successful delivery',
      should: 'pass 2 mapped entries',
      actual: mockDeliverToSiemWithRetry.mock.calls[0][1].length,
      expected: 2,
    });

    const upsertCalls = findAllCallsContaining('ON CONFLICT (id) DO UPDATE');
    const advanceCall = upsertCalls.find(
      (c) => Array.isArray(c[1]) && (c[1] as unknown[])[1] === 'log_2'
    );

    assert({
      given: 'successful delivery',
      should: 'upsert cursor with last delivered id',
      actual: advanceCall ? (advanceCall[1] as unknown[])[1] : null,
      expected: 'log_2',
    });

    assert({
      given: 'successful delivery',
      should: 'advance delivery count by the number of delivered entries',
      actual: advanceCall ? (advanceCall[1] as unknown[])[3] : null,
      expected: 12,
    });

    assert({
      given: 'successful delivery',
      should: 'clear lastError on success',
      actual: advanceCall ? (advanceCall[0] as string).includes('"lastError" = NULL') : false,
      expected: true,
    });
  });

  it('failed delivery with zero entries records error without advancing cursor', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);

    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false,
      entriesDelivered: 0,
      error: 'HTTP 502: Bad Gateway',
    });

    // Two error upserts — one per source
    stubErrorUpsert();
    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    const advanceCalls = findAllCallsContaining('ON CONFLICT (id) DO UPDATE\n           SET');
    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'not issue any cursor-advance upserts',
      actual: advanceCalls.length,
      expected: 0,
    });

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );
    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'record the error on both source cursors',
      actual: errorCalls.length,
      expected: 2,
    });

    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'include the activity_logs source in the error writes',
      actual: errorCalls.some((c) => (c[1] as unknown[])[0] === 'activity_logs'),
      expected: true,
    });

    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'include the security_audit_log source in the error writes',
      actual: errorCalls.some((c) => (c[1] as unknown[])[0] === 'security_audit_log'),
      expected: true,
    });

    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'record the error message',
      actual: (errorCalls[0][1] as unknown[])[1],
      expected: 'HTTP 502: Bad Gateway',
    });
  });

  it('partial delivery advances cursor past delivered entries then records error', async () => {
    const config = {
      enabled: true,
      type: 'syslog' as const,
      syslog: { host: 'syslog.example.com', port: 514, protocol: 'tcp' as const, facility: 'local0' as const },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    const rows = [
      makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z')),
      makeActivityRow('log_2', new Date('2026-04-10T12:01:00Z'), { operation: 'page.update' }),
      makeActivityRow('log_3', new Date('2026-04-10T12:02:00Z'), { operation: 'page.delete' }),
    ];
    stubSourceRows(rows);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);

    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false,
      entriesDelivered: 2,
      error: 'TCP connection reset',
    });

    stubCursorAdvance(); // activity_logs advance
    stubErrorUpsert(); // activity_logs error
    stubErrorUpsert(); // security_audit_log error
    stubLockRelease();

    await processSiemDelivery();

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"deliveryCount" = $4')
    );

    assert({
      given: 'partial delivery (2 of 3 activity_logs rows)',
      should: 'advance the activity_logs cursor to log_2',
      actual: (advanceCalls[0][1] as unknown[])[1],
      expected: 'log_2',
    });

    assert({
      given: 'partial delivery (2 of 3)',
      should: 'advance only the source that had delivered entries',
      actual: advanceCalls.length,
      expected: 1,
    });

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );
    assert({
      given: 'partial delivery failure',
      should: 'record the error on both sources',
      actual: errorCalls.map((c) => (c[1] as unknown[])[1]),
      expected: ['TCP connection reset', 'TCP connection reset'],
    });
  });

  it('no new rows means no delivery', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_99', new Date('2026-04-10T11:00:00Z'), 50);
    stubSourceRows([]);
    stubCursorRow('sec_99', new Date('2026-04-10T11:00:00Z'), 30);
    stubSourceRows([]);
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'no new rows from either source',
      should: 'not attempt delivery',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });
  });

  it('uses tuple (timestamp, id) cursor to resume after last delivered position', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    const cursorTimestamp = new Date('2026-04-10T11:00:00Z');
    stubCursorRow('log_99', cursorTimestamp, 50);
    stubSourceRows([]);
    stubCursorRow('sec_99', new Date('2026-04-10T11:00:00Z'), 30);
    stubSourceRows([]);
    stubLockRelease();

    await processSiemDelivery();

    const activityLogsQueryIndex = findCallContaining('FROM activity_logs');
    const activityLogsQuery = mockQuery.mock.calls[activityLogsQueryIndex];
    const sql = activityLogsQuery[0] as string;
    const params = activityLogsQuery[1] as unknown[];

    assert({
      given: 'an existing cursor',
      should: 'use tuple (timestamp, id) > ($1, $2) cursor so same-timestamp siblings are not dropped',
      actual: sql.includes('(timestamp, id) > ($1, $2)'),
      expected: true,
    });

    assert({
      given: 'an existing cursor',
      should: 'pass cursor timestamp as first param',
      actual: params[0],
      expected: cursorTimestamp,
    });

    assert({
      given: 'an existing cursor',
      should: 'pass cursor id as second param',
      actual: params[1],
      expected: 'log_99',
    });

    assert({
      given: 'an existing cursor',
      should: 'pass batchSize as third param',
      actual: params[2],
      expected: 100,
    });
  });

  it('releases pool client and advisory lock even on error', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));

    // Catch block writes error to both sources
    stubErrorUpsert();
    stubErrorUpsert();
    stubLockRelease();

    let thrownError: Error | null = null;
    try {
      await processSiemDelivery();
    } catch (err) {
      thrownError = err as Error;
    }

    assert({
      given: 'a database error',
      should: 'rethrow the error for pg-boss failure tracking',
      actual: thrownError?.message,
      expected: 'connection reset',
    });

    assert({
      given: 'a database error',
      should: 'release the pool client',
      actual: mockRelease.mock.calls.length,
      expected: 1,
    });

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('siem_delivery_cursors') && (call[0] as string).includes('"lastError" = $2')
    );

    assert({
      given: 'a database error',
      should: 'attempt best-effort error persistence on both sources',
      actual: errorCalls.length,
      expected: 2,
    });
  });

  it('acquires advisory lock before reading cursor', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_99', new Date('2026-04-10T11:00:00Z'), 50);
    stubSourceRows([]);
    stubCursorRow('sec_99', new Date('2026-04-10T11:00:00Z'), 30);
    stubSourceRows([]);
    stubLockRelease();

    await processSiemDelivery();

    const lockQuery = mockQuery.mock.calls[0];
    assert({
      given: 'a valid SIEM config',
      should: 'acquire advisory lock as the first DB operation',
      actual: (lockQuery[0] as string).includes('pg_try_advisory_lock'),
      expected: true,
    });

    assert({
      given: 'a valid SIEM config',
      should: 'use activity_logs as the single backward-compatible lock key',
      actual: (lockQuery[1] as unknown[])[0],
      expected: 'activity_logs',
    });
  });

  // ---------- New dual-source tests (wave 2) ----------

  it('polls both sources when both have new rows and delivers a single merged batch', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([
      makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z')),
      makeActivityRow('log_2', new Date('2026-04-10T12:02:00Z')),
    ]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([
      makeSecurityRow('sec_1', new Date('2026-04-10T12:01:00Z')),
      makeSecurityRow('sec_2', new Date('2026-04-10T12:03:00Z')),
    ]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 4 });

    stubCursorAdvance();
    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'both sources have new rows',
      should: 'issue exactly one delivery call',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 1,
    });

    const batch = mockDeliverToSiemWithRetry.mock.calls[0][1] as { source: AuditLogSource }[];

    assert({
      given: 'both sources have new rows',
      should: 'pass a merged batch containing all 4 entries',
      actual: batch.length,
      expected: 4,
    });

    assert({
      given: 'both sources have new rows',
      should: 'include entries from activity_logs',
      actual: batch.filter((e) => e.source === 'activity_logs').length,
      expected: 2,
    });

    assert({
      given: 'both sources have new rows',
      should: 'include entries from security_audit_log',
      actual: batch.filter((e) => e.source === 'security_audit_log').length,
      expected: 2,
    });
  });

  it('interleaves entries from both sources by timestamp', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([
      makeActivityRow('log_a', new Date('2026-04-10T00:00:10Z')),
      makeActivityRow('log_b', new Date('2026-04-10T00:00:30Z')),
    ]);
    stubCursorRow('sec_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([
      makeSecurityRow('sec_a', new Date('2026-04-10T00:00:20Z')),
      makeSecurityRow('sec_b', new Date('2026-04-10T00:00:40Z')),
    ]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 4 });

    stubCursorAdvance();
    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    const batch = mockDeliverToSiemWithRetry.mock.calls[0][1] as {
      id: string;
      source: AuditLogSource;
      timestamp: Date;
    }[];

    assert({
      given: 'activity_logs at t=10,30 and security_audit_log at t=20,40',
      should: 'interleave the merged batch by timestamp',
      actual: batch.map((e) => e.id),
      expected: ['log_a', 'sec_a', 'log_b', 'sec_b'],
    });
  });

  it('initializes a new security_audit_log cursor to NOW() and delivers zero security entries', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    // activity_logs cursor pre-seeded and empty
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    // security_audit_log cursor missing → init path
    stubCursorMissing();
    stubCursorInit();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'a missing security_audit_log cursor',
      should: 'not attempt delivery (merged batch is empty after init)',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });

    const initInserts = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('statement_timestamp()') &&
        (call[0] as string).includes('RETURNING')
    );

    assert({
      given: 'a missing security_audit_log cursor',
      should: 'INSERT a sentinel cursor row planted at the DB clock (statement_timestamp)',
      actual: initInserts.length,
      expected: 1,
    });

    const initSql = initInserts[0][0] as string;
    assert({
      given: 'the init INSERT',
      should: 'not pass a JS Date for the timestamp — must let Postgres stamp it',
      actual: (initInserts[0][1] as unknown[]).some((p) => p instanceof Date),
      expected: false,
    });

    assert({
      given: 'the init INSERT',
      should: 'upsert via ON CONFLICT DO UPDATE so error-only rows are repaired',
      actual: initSql.includes('ON CONFLICT (id) DO UPDATE'),
      expected: true,
    });

    const initParams = initInserts[0][1] as unknown[];
    assert({
      given: 'a missing security_audit_log cursor',
      should: 'target the security_audit_log source',
      actual: initParams[0],
      expected: 'security_audit_log',
    });

    // Crucially: no security_audit_log SELECT happened — zero historical delivery
    const securityQueryCount = findAllCallsContaining('FROM security_audit_log').length;
    assert({
      given: 'a missing security_audit_log cursor',
      should: 'skip the security_audit_log rows query on init run (no backfill)',
      actual: securityQueryCount,
      expected: 0,
    });
  });

  it('subsequent run after cursor init proceeds normally', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    // security cursor exists from a prior init run
    const initTimestamp = new Date('2026-04-10T09:00:00Z');
    stubCursorRow('__cursor_init__', initTimestamp, 0);
    stubSourceRows([makeSecurityRow('sec_1', new Date('2026-04-10T11:00:00Z'))]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 1 });

    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'a pre-initialized security_audit_log cursor',
      should: 'query security_audit_log after the cursor timestamp',
      actual: findAllCallsContaining('FROM security_audit_log').length,
      expected: 1,
    });

    const securityQuery = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('FROM security_audit_log')
    );
    assert({
      given: 'a pre-initialized security_audit_log cursor',
      should: 'use the cursor timestamp as the query predicate',
      actual: (securityQuery?.[1] as unknown[])[0],
      expected: initTimestamp,
    });

    assert({
      given: 'a pre-initialized security_audit_log cursor with one new row',
      should: 'deliver the single security entry',
      actual: mockDeliverToSiemWithRetry.mock.calls[0][1].length,
      expected: 1,
    });
  });

  it('empty security_audit_log does not break activity_logs delivery', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 7);
    stubSourceRows([makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 3);
    stubSourceRows([]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 1 });

    stubCursorAdvance(); // activity_logs advance only
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'activity_logs has rows and security_audit_log is empty',
      should: 'deliver the activity_logs entry',
      actual: mockDeliverToSiemWithRetry.mock.calls[0][1].length,
      expected: 1,
    });

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"deliveryCount" = $4')
    );

    assert({
      given: 'activity_logs has rows and security_audit_log is empty',
      should: 'only advance the activity_logs cursor',
      actual: advanceCalls.length,
      expected: 1,
    });

    assert({
      given: 'activity_logs has rows and security_audit_log is empty',
      should: 'advance cursor for activity_logs',
      actual: (advanceCalls[0][1] as unknown[])[0],
      expected: 'activity_logs',
    });
  });

  it('both sources empty → no delivery call, cursors unchanged', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'both sources empty',
      should: 'not issue a delivery',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"deliveryCount" = $4')
    );
    assert({
      given: 'both sources empty',
      should: 'not advance any cursor',
      actual: advanceCalls.length,
      expected: 0,
    });
  });

  it('per-source cursor advancement after full delivery', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T00:00:00Z'), 4);
    stubSourceRows([
      makeActivityRow('log_a', new Date('2026-04-10T00:00:10Z')),
      makeActivityRow('log_b', new Date('2026-04-10T00:00:30Z')),
    ]);
    stubCursorRow('sec_prev', new Date('2026-04-10T00:00:00Z'), 2);
    stubSourceRows([
      makeSecurityRow('sec_a', new Date('2026-04-10T00:00:20Z')),
      makeSecurityRow('sec_b', new Date('2026-04-10T00:00:40Z')),
    ]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 4 });

    stubCursorAdvance();
    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"deliveryCount" = $4')
    );

    assert({
      given: 'full delivery of 2 rows per source',
      should: 'advance both cursors',
      actual: advanceCalls.length,
      expected: 2,
    });

    const byId = new Map<string, unknown[]>();
    for (const call of advanceCalls) {
      const params = call[1] as unknown[];
      byId.set(params[0] as string, params);
    }

    assert({
      given: 'full delivery',
      should: 'advance activity_logs cursor to log_b',
      actual: byId.get('activity_logs')?.[1],
      expected: 'log_b',
    });

    assert({
      given: 'full delivery',
      should: 'advance activity_logs deliveryCount by 2',
      actual: byId.get('activity_logs')?.[3],
      expected: 6,
    });

    assert({
      given: 'full delivery',
      should: 'advance security_audit_log cursor to sec_b',
      actual: byId.get('security_audit_log')?.[1],
      expected: 'sec_b',
    });

    assert({
      given: 'full delivery',
      should: 'advance security_audit_log deliveryCount by 2',
      actual: byId.get('security_audit_log')?.[3],
      expected: 4,
    });
  });

  it('partial delivery walks the merged batch correctly across sources', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([
      makeActivityRow('log_a', new Date('2026-04-10T00:00:10Z')),
      makeActivityRow('log_b', new Date('2026-04-10T00:00:30Z')),
    ]);
    stubCursorRow('sec_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([
      makeSecurityRow('sec_a', new Date('2026-04-10T00:00:20Z')),
      makeSecurityRow('sec_b', new Date('2026-04-10T00:00:40Z')),
    ]);

    // Merged: [log_a(10), sec_a(20), log_b(30), sec_b(40)]
    // Delivered prefix: 3 → log_a, sec_a, log_b. sec_b stays behind.
    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false,
      entriesDelivered: 3,
      error: 'HTTP 503: timeout',
    });

    // activity_logs advance, security_audit_log advance, then 2 error upserts
    stubCursorAdvance();
    stubCursorAdvance();
    stubErrorUpsert();
    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"deliveryCount" = $4')
    );

    const byId = new Map<string, unknown[]>();
    for (const call of advanceCalls) {
      const params = call[1] as unknown[];
      byId.set(params[0] as string, params);
    }

    assert({
      given: 'partial delivery of 3 of 4 merged entries',
      should: 'advance activity_logs cursor over both of its delivered entries (log_a, log_b → log_b)',
      actual: byId.get('activity_logs')?.[1],
      expected: 'log_b',
    });

    assert({
      given: 'partial delivery of 3 of 4 merged entries',
      should: 'advance security_audit_log cursor only to sec_a (sec_b un-delivered)',
      actual: byId.get('security_audit_log')?.[1],
      expected: 'sec_a',
    });

    assert({
      given: 'partial delivery of 3 of 4 merged entries',
      should: 'advance activity_logs count by 2',
      actual: byId.get('activity_logs')?.[3],
      expected: 2,
    });

    assert({
      given: 'partial delivery of 3 of 4 merged entries',
      should: 'advance security_audit_log count by 1',
      actual: byId.get('security_audit_log')?.[3],
      expected: 1,
    });
  });

  it('recordError UPSERT does not overwrite advanced cursor state on partial delivery', async () => {
    // Regression pin: Phase 6 in the worker runs recordError() AFTER
    // advanceCursor() for partial deliveries, and depends on recordError's
    // UPDATE SET clause touching ONLY lastError/lastErrorAt/updatedAt. If a
    // future refactor adds lastDeliveredId/lastDeliveredAt/deliveryCount to
    // that SET clause, the just-advanced cursor state for sources that made
    // partial progress would be clobbered.
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([
      makeActivityRow('log_a', new Date('2026-04-10T00:00:10Z')),
      makeActivityRow('log_b', new Date('2026-04-10T00:00:30Z')),
    ]);
    stubCursorRow('sec_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([makeSecurityRow('sec_a', new Date('2026-04-10T00:00:20Z'))]);

    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false,
      entriesDelivered: 2, // log_a + sec_a delivered, log_b remains
      error: 'HTTP 503',
    });

    stubCursorAdvance(); // activity_logs advance
    stubCursorAdvance(); // security_audit_log advance
    stubErrorUpsert(); // activity_logs error
    stubErrorUpsert(); // security_audit_log error
    stubLockRelease();

    await processSiemDelivery();

    const errorUpsertCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );

    assert({
      given: 'a partial-delivery failure after per-source advance',
      should: 'emit a recordError UPSERT for each source',
      actual: errorUpsertCalls.length,
      expected: 2,
    });

    for (const call of errorUpsertCalls) {
      const sql = call[0] as string;

      assert({
        given: 'the recordError UPSERT SQL',
        should: 'not overwrite lastDeliveredId (would clobber the advance)',
        actual: sql.includes('"lastDeliveredId" ='),
        expected: false,
      });

      assert({
        given: 'the recordError UPSERT SQL',
        should: 'not overwrite lastDeliveredAt (would clobber the advance)',
        actual: sql.includes('"lastDeliveredAt" ='),
        expected: false,
      });

      assert({
        given: 'the recordError UPSERT SQL',
        should: 'not overwrite deliveryCount (would reset the counter)',
        actual: sql.includes('"deliveryCount" ='),
        expected: false,
      });
    }
  });

  it('delivery failure records error on both source cursors', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_1', new Date('2026-04-10T01:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T00:00:00Z'), 0);
    stubSourceRows([makeSecurityRow('sec_1', new Date('2026-04-10T01:00:01Z'))]);

    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false,
      entriesDelivered: 0,
      error: 'webhook unreachable',
    });

    stubErrorUpsert();
    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );

    assert({
      given: 'a total delivery failure',
      should: 'write lastError to both source cursors',
      actual: errorCalls.map((c) => (c[1] as unknown[])[0]).sort(),
      expected: ['activity_logs', 'security_audit_log'],
    });

    assert({
      given: 'a total delivery failure',
      should: 'propagate the error message to every cursor',
      actual: errorCalls.every((c) => (c[1] as unknown[])[1] === 'webhook unreachable'),
      expected: true,
    });

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"deliveryCount" = $4')
    );
    assert({
      given: 'a total delivery failure',
      should: 'not advance either cursor',
      actual: advanceCalls.length,
      expected: 0,
    });
  });

  it('cursor row with null lastDeliveredAt is treated as uninitialized and re-initialized', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    // activity_logs cursor is healthy and empty
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    // security_audit_log cursor exists but with null timestamps — created by a
    // prior error-path recordError() that ran before the cursor was ever
    // initialized. The schema check constraint allows (null, null), so the
    // worker must NOT skip this source forever — it must re-init it.
    mockQuery.mockResolvedValueOnce({
      rows: [{ lastDeliveredId: null, lastDeliveredAt: null, deliveryCount: 0 }],
      rowCount: 1,
    });
    stubCursorInit(); // worker should now initCursor for security_audit_log
    stubLockRelease();

    await processSiemDelivery();

    const initInserts = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('statement_timestamp()') &&
        (call[0] as string).includes('ON CONFLICT (id) DO UPDATE')
    );

    assert({
      given: 'a security_audit_log cursor row with null lastDeliveredAt',
      should: 'UPSERT a fresh sentinel cursor row with statement_timestamp (re-initialize)',
      actual: initInserts.length,
      expected: 1,
    });

    assert({
      given: 'a security_audit_log cursor row with null lastDeliveredAt',
      should: 'target the security_audit_log source for re-init',
      actual: (initInserts[0][1] as unknown[])[0],
      expected: 'security_audit_log',
    });

    // Crucially: NO security_audit_log SELECT happened — same as a brand-new
    // source (no historical backfill, no permanent skip).
    const securityQueryCount = findAllCallsContaining('FROM security_audit_log').length;
    assert({
      given: 'a security_audit_log cursor row with null lastDeliveredAt',
      should: 'not query security_audit_log on the re-init run',
      actual: securityQueryCount,
      expected: 0,
    });
  });

  it('returns rows whose timestamp ties the cursor timestamp (no same-microsecond drop)', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    const tieTimestamp = new Date('2026-04-10T12:00:00.000Z');
    // activity_logs cursor sits exactly at tieTimestamp with id 'log_a' delivered
    stubCursorRow('log_a', tieTimestamp, 1);
    stubSourceRows([]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    stubLockRelease();

    await processSiemDelivery();

    const activityQuery = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('FROM activity_logs')
    );

    assert({
      given: 'a cursor sitting on a row that may have same-timestamp siblings',
      should: 'use a tuple (timestamp, id) > ($1, $2) cursor, not a strict timestamp >',
      actual:
        typeof activityQuery?.[0] === 'string' &&
        (activityQuery[0] as string).includes('(timestamp, id) > ($1, $2)'),
      expected: true,
    });

    assert({
      given: 'a cursor sitting on a row that may have same-timestamp siblings',
      should: 'pass the cursor timestamp as the first param',
      actual: (activityQuery?.[1] as unknown[])[0],
      expected: tieTimestamp,
    });

    assert({
      given: 'a cursor sitting on a row that may have same-timestamp siblings',
      should: 'pass the cursor id as the second param so same-timestamp rows with id > cursor id still match',
      actual: (activityQuery?.[1] as unknown[])[1],
      expected: 'log_a',
    });
  });

  it('does not log the polled-rows line when both sources are empty', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);
    stubLockRelease();

    await processSiemDelivery();

    const polledLogCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('Polled')
    );

    consoleSpy.mockRestore();

    assert({
      given: 'a polling cycle where both sources returned zero rows',
      should: 'not emit the [siem-delivery] Polled info log',
      actual: polledLogCalls.length,
      expected: 0,
    });
  });

  it('backlogged source caps delivery watermark so newer cross-source rows are deferred', async () => {
    // Scenario from Codex P2 review: activity_logs has a big historical
    // backlog (Jan rows), security_audit_log has a few fresh rows (Apr). If we
    // naively ship every polled row in one batch, the Apr security rows go out
    // BEFORE most of the Jan activity rows, then the next run ships more Jan
    // rows — the SIEM receiver's delivery order no longer matches event order.
    //
    // Expected behavior: because activity_logs hit its LIMIT (backlog still
    // pending past the tail), the delivery watermark caps at the activity
    // batch's last timestamp. Newer security rows past that watermark are
    // held back — NOT delivered, NOT advanced — until the activity backlog
    // drains in subsequent runs.
    const smallBatchConfig = {
      enabled: true,
      type: 'webhook' as const,
      webhook: {
        url: 'https://siem.example.com',
        secret: 's3cret',
        batchSize: 3,
        retryAttempts: 3,
      },
    };
    mockLoadSiemConfig.mockReturnValue(smallBatchConfig);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    // activity_logs has a backlog — returns LIMIT=3 old rows from Jan
    stubCursorRow('log_prev', new Date('2026-01-01T00:00:00Z'), 10);
    stubSourceRows([
      makeActivityRow('log_jan1', new Date('2026-01-01T01:00:00Z')),
      makeActivityRow('log_jan2', new Date('2026-01-01T02:00:00Z')),
      makeActivityRow('log_jan3', new Date('2026-01-01T03:00:00Z')),
    ]);
    // security_audit_log is caught up except for 2 fresh rows from April
    stubCursorRow('sec_prev', new Date('2026-04-10T00:00:00Z'), 5);
    stubSourceRows([
      makeSecurityRow('sec_apr1', new Date('2026-04-10T10:00:00Z')),
      makeSecurityRow('sec_apr2', new Date('2026-04-10T10:05:00Z')),
    ]);

    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 3 });

    stubCursorAdvance(); // only activity_logs advances
    stubLockRelease();

    await processSiemDelivery();

    const deliveredBatch = mockDeliverToSiemWithRetry.mock.calls[0][1] as { source: AuditLogSource }[];

    assert({
      given: 'activity_logs has backlog and security has newer rows',
      should: 'only deliver the activity (backlogged) prefix, not the newer security rows',
      actual: deliveredBatch.length,
      expected: 3,
    });

    assert({
      given: 'the delivery watermark cap',
      should: 'include all three activity_logs rows',
      actual: deliveredBatch.every((e) => e.source === 'activity_logs'),
      expected: true,
    });

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"lastDeliveredId" = $2') &&
        (call[0] as string).includes('"lastDeliveredAt" = $3')
    );

    assert({
      given: 'security rows were held back by the watermark',
      should: 'only issue a cursor advance for activity_logs, not security_audit_log',
      actual: advanceCalls.length,
      expected: 1,
    });

    assert({
      given: 'the single advance call',
      should: 'target the activity_logs source',
      actual: (advanceCalls[0][1] as unknown[])[0],
      expected: 'activity_logs',
    });
  });

  it('SOURCES constant is typed as AuditLogSource[] and contains both sources', () => {
    const expected: AuditLogSource[] = ['activity_logs', 'security_audit_log'];
    assert({
      given: 'the exported SOURCES constant',
      should: 'equal the two known AuditLogSource values in order',
      actual: [...SOURCES],
      expected,
    });
  });

  // --- Phase 2c: chain verification preflight --------------------------------
  //
  // These tests use the preflight module as a mock seam. The real preflight
  // implementation is covered by its own unit tests
  // (siem-chain-verifier.test.ts + siem-chain-hashers.test.ts +
  // siem-anchor-loader.test.ts). Here we verify the WORKER's integration
  // with that surface: does tamper detection halt delivery, are errors
  // recorded on the right cursor, does the alert fire once, etc.

  it('clean preflight proceeds to delivery as before', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeSecurityRow('sec_1', new Date('2026-04-10T12:05:00Z'))]);

    mockRunChainPreflight.mockResolvedValue(null); // clean
    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 2 });

    stubCursorAdvance();
    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: "both sources' chains verify clean",
      should: 'proceed to deliverToSiemWithRetry',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 1,
    });

    assert({
      given: 'a clean preflight',
      should: 'not fire the chain verification alert',
      actual: mockNotifyChainPreflightFailure.mock.calls.length,
      expected: 0,
    });
  });

  it('tamper on activity_logs does not call deliverToSiemWithRetry', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_tampered', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeSecurityRow('sec_clean', new Date('2026-04-10T12:05:00Z'))]);

    mockRunChainPreflight.mockResolvedValue({
      source: 'activity_logs',
      entryId: 'log_tampered',
      breakAtIndex: 0,
      breakReason: 'hash_mismatch',
      expectedHash: 'expected',
      actualHash: 'tampered',
    });

    stubErrorUpsert(); // error recorded on activity_logs cursor
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'a tampered activity_logs row in the merged batch',
      should: 'NOT call deliverToSiemWithRetry',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });
  });

  it('tamper on activity_logs records a chain error on the activity_logs cursor', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_tampered', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);

    mockRunChainPreflight.mockResolvedValue({
      source: 'activity_logs',
      entryId: 'log_tampered',
      breakAtIndex: 0,
      breakReason: 'hash_mismatch',
      expectedHash: 'expected',
      actualHash: 'tampered',
    });

    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );

    assert({
      given: 'a tampered activity_logs row',
      should: 'record the chain error on exactly one cursor',
      actual: errorCalls.length,
      expected: 1,
    });

    assert({
      given: 'a tampered activity_logs row',
      should: 'target the activity_logs cursor',
      actual: (errorCalls[0][1] as unknown[])[0],
      expected: 'activity_logs',
    });

    assert({
      given: 'a tampered activity_logs row',
      should: 'include the break index and reason in the error message',
      actual:
        typeof (errorCalls[0][1] as unknown[])[1] === 'string' &&
        ((errorCalls[0][1] as string[])[1] as string).includes('hash_mismatch') &&
        ((errorCalls[0][1] as string[])[1] as string).includes('log_tampered'),
      expected: true,
    });
  });

  it('tamper halts delivery for both sources without advancing cursors', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_tampered', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeSecurityRow('sec_clean', new Date('2026-04-10T12:05:00Z'))]);

    mockRunChainPreflight.mockResolvedValue({
      source: 'activity_logs',
      entryId: 'log_tampered',
      breakAtIndex: 0,
      breakReason: 'hash_mismatch',
      expectedHash: 'expected',
      actualHash: 'tampered',
    });

    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    const advanceCalls = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('"lastDeliveredId" = $2') &&
        (call[0] as string).includes('"lastDeliveredAt" = $3')
    );

    assert({
      given: 'a tampered activity_logs row',
      should: 'NOT advance either source cursor',
      actual: advanceCalls.length,
      expected: 0,
    });
  });

  it('tamper fires the chain verification alert exactly once', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_tampered', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);

    mockRunChainPreflight.mockResolvedValue({
      source: 'activity_logs',
      entryId: 'log_tampered',
      breakAtIndex: 0,
      breakReason: 'hash_mismatch',
      expectedHash: 'expected',
      actualHash: 'tampered',
    });

    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'a tampered activity_logs row',
      should: 'fire notifyChainPreflightFailure exactly once',
      actual: mockNotifyChainPreflightFailure.mock.calls.length,
      expected: 1,
    });

    assert({
      given: 'a tampered activity_logs row',
      should: 'pass the break details to the alert with auditSource=activity_logs',
      actual: (mockNotifyChainPreflightFailure.mock.calls[0][0] as { auditSource: string }).auditSource,
      expected: 'activity_logs',
    });

    assert({
      given: 'a tampered activity_logs row',
      should: 'pass the break reason to the alert',
      actual: (mockNotifyChainPreflightFailure.mock.calls[0][0] as { breakReason: string }).breakReason,
      expected: 'hash_mismatch',
    });
  });

  it('fresh-init cursor skip still lets the worker deliver the other source when preflight passes', async () => {
    // The worker's integration with preflight is the boundary this test
    // covers; the "fresh init skip" semantics themselves are enforced inside
    // runChainPreflight and covered by its own tests. Here we just verify
    // that when the preflight mock says "clean" (whether by skipping or
    // actually verifying), delivery proceeds unaffected.
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z'))]);
    // security_audit_log is freshly initialized this run
    stubCursorMissing();
    stubCursorInit(new Date('2026-04-10T11:00:00Z'));

    mockRunChainPreflight.mockResolvedValue(null);
    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 1 });

    stubCursorAdvance();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'a fresh-init security_audit_log cursor and a clean activity_logs batch',
      should: 'still call delivery for the activity_logs entry',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 1,
    });
  });

  it('alert webhook throwing does not stop the error write or lock release', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_tampered', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);

    mockRunChainPreflight.mockResolvedValue({
      source: 'activity_logs',
      entryId: 'log_tampered',
      breakAtIndex: 0,
      breakReason: 'hash_mismatch',
      expectedHash: 'expected',
      actualHash: 'tampered',
    });

    // Alert throws — the worker must keep going.
    mockNotifyChainPreflightFailure.mockRejectedValue(new Error('alert webhook is down'));

    stubErrorUpsert();
    stubLockRelease();

    // If the worker does NOT swallow the alert error, this call would reject.
    await processSiemDelivery();

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );
    // Note: in the worker, recordError is called BEFORE notifyChainPreflightFailure,
    // so the error write already happened. What we care about is that the
    // alert failure didn't cause the processSiemDelivery promise to reject.
    assert({
      given: 'the alert webhook throws',
      should: 'still record the tamper error on the failing source cursor',
      actual: errorCalls.length >= 1 && (errorCalls[0][1] as unknown[])[0] === 'activity_logs',
      expected: true,
    });
  });

  it('preflight halt on anchor-load DB error is recorded and delivery halts', async () => {
    mockLoadSiemConfig.mockReturnValue(WEBHOOK_CONFIG);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    stubCursorRow('log_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([makeActivityRow('log_1', new Date('2026-04-10T12:00:00Z'))]);
    stubCursorRow('sec_prev', new Date('2026-04-10T10:00:00Z'), 0);
    stubSourceRows([]);

    // Simulate the real preflight's defensive behavior when an anchor-load
    // DB query fails: it returns a synthesized halt (missing_hash + error in
    // actualHash) for the affected source rather than throwing.
    mockRunChainPreflight.mockResolvedValue({
      source: 'activity_logs',
      entryId: 'log_1',
      breakAtIndex: 0,
      breakReason: 'missing_hash',
      expectedHash: null,
      actualHash: 'connection refused',
    });

    stubErrorUpsert();
    stubLockRelease();

    await processSiemDelivery();

    assert({
      given: 'an anchor-load DB error surfaced as a preflight halt',
      should: 'NOT call deliverToSiemWithRetry',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });

    const errorCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('"lastError" = $2')
    );
    assert({
      given: 'an anchor-load DB error',
      should: 'record the error on the activity_logs cursor',
      actual: errorCalls.length === 1 && (errorCalls[0][1] as unknown[])[0] === 'activity_logs',
      expected: true,
    });
  });
});
