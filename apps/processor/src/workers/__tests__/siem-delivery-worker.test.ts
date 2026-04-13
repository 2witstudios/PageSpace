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

/** Stub the advisory lock as acquired (default path for most tests) */
function stubLockAcquired() {
  mockQuery.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });
}

/** Stub the advisory unlock (resolves at end of every successful path) */
function stubLockRelease() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

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

  it('skips processing when advisory lock is not acquired', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Lock NOT acquired (another worker holds it)
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
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // 1. Lock acquired
    stubLockAcquired();

    // 2. Cursor query returns no previous cursor
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // 3. Activity logs query returns 2 rows
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
    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: true,
      entriesDelivered: 2,
      deliveryId: 'adapter-echoed-id',
      webhookStatus: 200,
      responseHash: 'rh',
      ackReceivedAt: null,
    });

    // 4. Cursor upsert
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // 5. Receipt INSERT
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // 6. Advisory unlock in finally
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
      expected: config,
    });

    assert({
      given: 'successful delivery',
      should: 'pass 2 mapped entries',
      actual: mockDeliverToSiemWithRetry.mock.calls[0][1].length,
      expected: 2,
    });

    assert({
      given: 'successful delivery',
      should: 'generate and pass a deliveryId string to the adapter',
      actual: typeof mockDeliverToSiemWithRetry.mock.calls[0][2],
      expected: 'string',
    });

    // The 4th query call (index 3) is the cursor advance (after lock, cursor read, logs read)
    const upsertCall = mockQuery.mock.calls[3];
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

    // 1. Lock acquired
    stubLockAcquired();

    // 2. Cursor query returns no previous cursor
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // 3. Activity logs query returns 1 row
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

    // 4. Error cursor upsert (only query after the 3 reads — no cursor advance)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // 5. Advisory unlock
    stubLockRelease();

    await processSiemDelivery();

    // 5 queries: lock, cursor read, logs read, error upsert, unlock
    assert({
      given: 'failed delivery with 0 entries delivered',
      should: 'issue exactly 5 queries (lock + cursor + logs + error + unlock)',
      actual: mockQuery.mock.calls.length,
      expected: 5,
    });

    const errorUpdateCall = mockQuery.mock.calls[3];
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

    // 1. Lock acquired
    stubLockAcquired();

    // 2. No existing cursor
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // 3. Activity logs returns 3 rows
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
      deliveryId: 'd-partial', webhookStatus: null, responseHash: null, ackReceivedAt: null,
    });

    // 4. Cursor advance upsert
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // 5. Receipt INSERT (partial delivery still attests what shipped)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // 6. Error upsert
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // 7. Advisory unlock
    stubLockRelease();

    await processSiemDelivery();

    // 7 queries: lock, cursor read, logs read, cursor advance, receipt insert, error upsert, unlock
    assert({
      given: 'partial delivery (2 of 3)',
      should: 'issue 7 queries (lock + cursor + logs + advance + receipt + error + unlock)',
      actual: mockQuery.mock.calls.length,
      expected: 7,
    });

    // Cursor advance is at index 3 — should point to log_2 (2nd row, index 1)
    const advanceCall = mockQuery.mock.calls[3];
    assert({
      given: 'partial delivery of 2 entries',
      should: 'advance cursor to the last delivered entry (log_2)',
      actual: (advanceCall[1] as unknown[])[1],
      expected: 'log_2',
    });

    // Receipt insert at index 4 references the delivered prefix only
    const receiptCall = mockQuery.mock.calls[4];
    assert({
      given: 'partial delivery of 2 entries',
      should: 'emit a receipt INSERT after cursor advance',
      actual: (receiptCall[0] as string).includes('INSERT INTO siem_delivery_receipts'),
      expected: true,
    });

    // Error upsert is at index 5
    const errorCall = mockQuery.mock.calls[5];
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

    // 1. Lock acquired
    stubLockAcquired();

    // 2. Cursor with existing position
    mockQuery.mockResolvedValueOnce({
      rows: [{ lastDeliveredId: 'log_99', lastDeliveredAt: new Date('2026-04-10T11:00:00Z'), deliveryCount: 50 }],
      rowCount: 1,
    });

    // 3. Activity logs returns nothing new
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // 4. Advisory unlock
    stubLockRelease();

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

    // 1. Lock acquired
    stubLockAcquired();

    // 2. Existing cursor
    const cursorTimestamp = new Date('2026-04-10T11:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{ lastDeliveredId: 'log_99', lastDeliveredAt: cursorTimestamp, deliveryCount: 50 }],
      rowCount: 1,
    });

    // 3. No new logs
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // 4. Advisory unlock
    stubLockRelease();

    await processSiemDelivery();

    // The 3rd query (index 2) is the activity_logs fetch
    const logsQuery = mockQuery.mock.calls[2];
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

  it('releases pool client and advisory lock even on error', async () => {
    mockLoadSiemConfig.mockReturnValue({
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    });
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Lock acquired
    stubLockAcquired();

    // Cursor query throws
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));

    // Best-effort error upsert (in catch block)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Advisory unlock in finally
    stubLockRelease();

    // Worker now rethrows — expect the error to propagate
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

    // Verify best-effort error upsert was attempted (index 2 = after lock + failed cursor)
    const errorUpsertCall = mockQuery.mock.calls[2];
    assert({
      given: 'a database error',
      should: 'attempt best-effort error persistence',
      actual: (errorUpsertCall[0] as string).includes('siem_delivery_cursors'),
      expected: true,
    });
  });

  it('acquires advisory lock before reading cursor', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    // Lock acquired
    stubLockAcquired();

    // Cursor + no rows + unlock
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    stubLockRelease();

    await processSiemDelivery();

    // First query should be the advisory lock
    const lockQuery = mockQuery.mock.calls[0];
    assert({
      given: 'a valid SIEM config',
      should: 'acquire advisory lock as the first DB operation',
      actual: (lockQuery[0] as string).includes('pg_try_advisory_lock'),
      expected: true,
    });

    assert({
      given: 'a valid SIEM config',
      should: 'use CURSOR_ID as lock key via hashtext',
      actual: (lockQuery[1] as unknown[])[0],
      expected: 'activity_logs',
    });
  });

  it('successful delivery writes a receipt AFTER cursor advancement', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // cursor read
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
    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: true, entriesDelivered: 1,
      deliveryId: 'd-echo', webhookStatus: 200, responseHash: 'rh', ackReceivedAt: new Date(),
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // cursor advance
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // receipt insert
    stubLockRelease();

    await processSiemDelivery();

    // Index 3 = cursor advance, index 4 = receipt insert
    const advanceSql = mockQuery.mock.calls[3][0] as string;
    const receiptSql = mockQuery.mock.calls[4][0] as string;

    assert({
      given: 'a successful delivery',
      should: 'write the receipt AFTER the cursor advance',
      actual: {
        advanceIsCursor: advanceSql.includes('siem_delivery_cursors'),
        receiptIsReceipts: receiptSql.includes('INSERT INTO siem_delivery_receipts'),
      },
      expected: { advanceIsCursor: true, receiptIsReceipts: true },
    });
  });

  it('receipt INSERT carries the same deliveryId that was passed to the adapter', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'log_1', timestamp: new Date('2026-04-10T12:00:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'op', resourceType: 'page', resourceId: 'p1',
        resourceTitle: null, driveId: null, pageId: null,
        metadata: null, previousLogHash: null, logHash: null,
      }],
      rowCount: 1,
    });
    mockDeliverToSiemWithRetry.mockResolvedValue({ success: true, entriesDelivered: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // cursor advance
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // receipt insert
    stubLockRelease();

    await processSiemDelivery();

    const generatedDeliveryId = mockDeliverToSiemWithRetry.mock.calls[0][2] as string;
    const receiptParams = mockQuery.mock.calls[4][1] as unknown[];
    // Params order from writer: deliveryId, source, firstEntryId, lastEntryId, ...
    const receiptDeliveryId = receiptParams[0];

    assert({
      given: 'a successful delivery',
      should: 'write the receipt with the deliveryId that was passed to the adapter',
      actual: receiptDeliveryId,
      expected: generatedDeliveryId,
    });
  });

  it('zero-delivery failure does NOT write any receipt row', async () => {
    const config = {
      enabled: true,
      type: 'webhook' as const,
      webhook: { url: 'https://siem.example.com', secret: 's3cret', batchSize: 100, retryAttempts: 3 },
    };
    mockLoadSiemConfig.mockReturnValue(config);
    mockValidateSiemConfig.mockReturnValue({ valid: true, errors: [] });

    stubLockAcquired();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'log_1', timestamp: new Date('2026-04-10T12:00:00Z'),
        userId: 'u1', actorEmail: 'a@b.com', actorDisplayName: 'A',
        isAiGenerated: false, aiProvider: null, aiModel: null, aiConversationId: null,
        operation: 'op', resourceType: 'page', resourceId: 'p1',
        resourceTitle: null, driveId: null, pageId: null,
        metadata: null, previousLogHash: null, logHash: null,
      }],
      rowCount: 1,
    });
    mockDeliverToSiemWithRetry.mockResolvedValue({
      success: false, entriesDelivered: 0, error: 'HTTP 502: Bad Gateway',
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // error upsert
    stubLockRelease();

    await processSiemDelivery();

    const anyReceiptInsert = mockQuery.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('siem_delivery_receipts')
    );

    assert({
      given: 'a zero-delivery failure',
      should: 'NOT emit any INSERT against siem_delivery_receipts',
      actual: anyReceiptInsert,
      expected: false,
    });
  });
});
