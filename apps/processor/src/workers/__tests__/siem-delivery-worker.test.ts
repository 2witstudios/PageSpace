import { beforeEach, describe, it, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';

const { mockLoadSiemConfig, mockValidateSiemConfig, mockDeliverToSiemWithRetry, mockQuery, mockRelease } = vi.hoisted(() => {
  const mockLoadSiemConfig = vi.fn();
  const mockValidateSiemConfig = vi.fn();
  const mockDeliverToSiemWithRetry = vi.fn();
  const mockQuery = vi.fn();
  const mockRelease = vi.fn();

  return {
    mockLoadSiemConfig,
    mockValidateSiemConfig,
    mockDeliverToSiemWithRetry,
    mockQuery,
    mockRelease,
  };
});

vi.mock('../../services/siem-adapter', () => ({
  loadSiemConfig: mockLoadSiemConfig,
  validateSiemConfig: mockValidateSiemConfig,
  deliverToSiemWithRetry: mockDeliverToSiemWithRetry,
}));

vi.mock('../../db', () => ({
  getPoolForWorker: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    }),
  })),
}));

import { processSiemDelivery } from '../siem-delivery-worker';

describe('processSiemDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('successful delivery updates cursor', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Cursor query returns no previous cursor
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Activity logs query returns 2 rows
    const rows = [
      {
        id: 'log_1', timestamp: new Date('2026-04-10T12:00:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'page.create', resourceType: 'page', resourceId: 'p1',
        resourceTitle: 'Title', driveId: 'd1', pageId: 'p1',
        metadata: null, previousLogHash: null, logHash: 'h1',
      },
      {
        id: 'log_2', timestamp: new Date('2026-04-10T12:01:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'page.update', resourceType: 'page', resourceId: 'p1',
        resourceTitle: 'Title', driveId: 'd1', pageId: 'p1',
        metadata: null, previousLogHash: 'h1', logHash: 'h2',
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

    // Delivery succeeds
    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 2 });

    // Cursor upsert
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

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
      expected: config,
    });

    assert({
      given: 'successful delivery',
      should: 'pass 2 mapped entries',
      actual: mockDeliverToSiemWithRetry.mock.calls[0][1].length,
      expected: 2,
    });

    // The 3rd query call is the cursor advance (clears error state)
    const upsertCall = mockQuery.mock.calls[2];
    const upsertSql = upsertCall[0] as string;

    assert({
      given: 'successful delivery',
      should: 'upsert cursor with last delivered id',
      actual: (upsertCall[1] as unknown[])[1],
      expected: 'log_2',
    });

    assert({
      given: 'successful delivery',
      should: 'clear lastError on success',
      actual: upsertSql.includes('"lastError" = NULL'),
      expected: true,
    });

    assert({
      given: 'successful delivery',
      should: 'clear lastErrorAt on success',
      actual: upsertSql.includes('"lastErrorAt" = NULL'),
      expected: true,
    });
  });

  it('failed delivery with zero entries records error without advancing cursor', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Cursor query returns no previous cursor
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Activity logs query returns 1 row
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'log_1', timestamp: new Date('2026-04-10T12:00:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'page.create', resourceType: 'page', resourceId: 'p1',
        resourceTitle: null, driveId: null, pageId: null,
        metadata: null, previousLogHash: null, logHash: null,
      }],
      rowCount: 1,
    });

    // Delivery fails with zero delivered
    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false, entriesDelivered: 0, error: 'HTTP 502: Bad Gateway',
    });

    // Error cursor upsert (only query after the 2 reads — no cursor advance)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await processSiemDelivery();

    // Only 3 queries: cursor read, logs read, error upsert (no cursor advance)
    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'issue exactly 3 queries (no cursor advance)',
      actual: mockQuery.mock.calls.length,
      expected: 3,
    });

    const errorUpdateCall = mockQuery.mock.calls[2];
    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'record the error message',
      actual: (errorUpdateCall[1] as unknown[])[1],
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

    // No existing cursor
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Activity logs returns 3 rows
    const rows = [
      {
        id: 'log_1', timestamp: new Date('2026-04-10T12:00:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'page.create', resourceType: 'page', resourceId: 'p1',
        resourceTitle: null, driveId: null, pageId: null,
        metadata: null, previousLogHash: null, logHash: null,
      },
      {
        id: 'log_2', timestamp: new Date('2026-04-10T12:01:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'page.update', resourceType: 'page', resourceId: 'p1',
        resourceTitle: null, driveId: null, pageId: null,
        metadata: null, previousLogHash: null, logHash: null,
      },
      {
        id: 'log_3', timestamp: new Date('2026-04-10T12:02:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'page.delete', resourceType: 'page', resourceId: 'p1',
        resourceTitle: null, driveId: null, pageId: null,
        metadata: null, previousLogHash: null, logHash: null,
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 3 });

    // Syslog delivers 2 of 3 then fails mid-batch
    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false, entriesDelivered: 2, error: 'TCP connection reset',
    });

    // Cursor advance upsert
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Error upsert
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await processSiemDelivery();

    // 4 queries: cursor read, logs read, cursor advance, error upsert
    assert({
      given: 'partial delivery (2 of 3)',
      should: 'issue 4 queries (cursor advance + error)',
      actual: mockQuery.mock.calls.length,
      expected: 4,
    });

    // Cursor advance is at index 2 — should point to log_2 (2nd row, index 1)
    const advanceCall = mockQuery.mock.calls[2];
    assert({
      given: 'partial delivery of 2 entries',
      should: 'advance cursor to the last delivered entry (log_2)',
      actual: (advanceCall[1] as unknown[])[1],
      expected: 'log_2',
    });

    // Error upsert is at index 3
    const errorCall = mockQuery.mock.calls[3];
    assert({
      given: 'partial delivery failure',
      should: 'record the error message',
      actual: (errorCall[1] as unknown[])[1],
      expected: 'TCP connection reset',
    });
  });

  it('no new rows means no delivery', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Cursor with existing position
    mockQuery.mockResolvedValueOnce({
      rows: [{ lastDeliveredId: 'log_99', lastDeliveredAt: new Date('2026-04-10T11:00:00Z'), deliveryCount: 50 }],
      rowCount: 1,
    });

    // Activity logs returns nothing new
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processSiemDelivery();

    assert({
      given: 'no new activity_logs rows',
      should: 'not attempt delivery',
      actual: mockDeliverToSiemWithRetry.mock.calls.length,
      expected: 0,
    });
  });

  it('uses timestamp-only cursor to resume after last delivered position', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    const cursorTimestamp = new Date('2026-04-10T11:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{ lastDeliveredId: 'log_99', lastDeliveredAt: cursorTimestamp, deliveryCount: 50 }],
      rowCount: 1,
    });

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processSiemDelivery();

    // The 2nd query is the activity_logs fetch
    const logsQuery = mockQuery.mock.calls[1];
    const sql = logsQuery[0] as string;
    const params = logsQuery[1] as unknown[];

    assert({
      given: 'an existing cursor',
      should: 'use timestamp-only comparison (not composite with non-monotonic IDs)',
      actual: sql.includes('WHERE timestamp > $1'),
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
      should: 'pass batchSize as second param',
      actual: params[1],
      expected: 100,
    });
  });

  it('releases the pool client even on error', async () => {
    mockLoadSiemConfig.mockReturnValue({
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    });
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Cursor query throws
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));

    await processSiemDelivery();

    assert({
      given: 'a database error',
      should: 'release the pool client',
      actual: mockRelease.mock.calls.length,
      expected: 1,
    });
  });
});
