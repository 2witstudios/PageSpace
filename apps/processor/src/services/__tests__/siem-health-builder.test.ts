import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  buildSiemHealth,
  type CursorSnapshot,
  type RecentReceipt,
} from '../siem-health-builder';
import type { AuditLogSource } from '../siem-adapter';

const SENTINEL = '__cursor_init__';
const SOURCES: readonly AuditLogSource[] = ['activity_logs', 'security_audit_log'];

const makeCursor = (overrides: Partial<CursorSnapshot> = {}): CursorSnapshot => ({
  id: 'activity_logs',
  lastDeliveredId: 'log_001',
  lastDeliveredAt: new Date('2026-04-10T12:00:00Z'),
  lastError: null,
  lastErrorAt: null,
  deliveryCount: 10,
  updatedAt: new Date('2026-04-10T12:00:05Z'),
  ...overrides,
});

describe('buildSiemHealth', () => {
  it('given SIEM disabled, should return enabled false, type null, and empty sources', () => {
    const result = buildSiemHealth({
      enabled: false,
      type: null,
      sources: SOURCES,
      cursors: [],
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'SIEM disabled',
      should: 'report enabled=false and empty sources',
      actual: { enabled: result.enabled, type: result.type, sources: result.sources },
      expected: { enabled: false, type: null, sources: {} },
    });
  });

  it('given both sources with valid cursors, should return delivering status for each', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({ id: 'activity_logs' }),
      makeCursor({ id: 'security_audit_log', lastDeliveredId: 'sec_001' }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'two valid cursors',
      should: 'report delivering for both',
      actual: [
        result.sources.activity_logs!.status,
        result.sources.security_audit_log!.status,
      ],
      expected: ['delivering', 'delivering'],
    });
  });

  it('given a cursor with lastDeliveredId equal to the injected sentinel, should return initialized status', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({ id: 'activity_logs', lastDeliveredId: SENTINEL }),
      makeCursor({ id: 'security_audit_log' }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a cursor whose lastDeliveredId is the sentinel',
      should: 'report initialized',
      actual: result.sources.activity_logs!.status,
      expected: 'initialized',
    });
  });

  it('given a cursor with lastError set and lastErrorAt after lastDeliveredAt, should return error status', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredAt: new Date('2026-04-10T12:00:00Z'),
        lastError: 'HTTP 500',
        lastErrorAt: new Date('2026-04-10T12:05:00Z'),
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a cursor whose most recent event is an error',
      should: 'report error',
      actual: result.sources.activity_logs!.status,
      expected: 'error',
    });
  });

  it('given a cursor with lastError set but lastErrorAt before lastDeliveredAt, should return delivering status (recovered)', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredAt: new Date('2026-04-10T12:10:00Z'),
        lastError: 'HTTP 500',
        lastErrorAt: new Date('2026-04-10T12:05:00Z'),
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a cursor that recovered after an error',
      should: 'report delivering',
      actual: result.sources.activity_logs!.status,
      expected: 'delivering',
    });
  });

  it('given a cursor with lastError set and lastDeliveredAt null, should return error status', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredId: null,
        lastDeliveredAt: null,
        lastError: 'init failure',
        lastErrorAt: new Date('2026-04-10T12:00:00Z'),
        deliveryCount: 0,
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a cursor with an error and no delivery',
      should: 'report error',
      actual: result.sources.activity_logs!.status,
      expected: 'error',
    });
  });

  it('given a cursor still at the init sentinel but with an error after it, should return error status (error beats initialized)', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredId: SENTINEL,
        lastDeliveredAt: null,
        lastError: 'HTTP 500 from SIEM endpoint',
        lastErrorAt: new Date('2026-04-10T12:05:00Z'),
        deliveryCount: 0,
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a cursor at the init sentinel that has started failing',
      should: 'report error so /health surfaces the failure instead of initialized',
      actual: result.sources.activity_logs!.status,
      expected: 'error',
    });
  });

  it('given no cursor row for a source in SOURCES, should return missing status for that source', () => {
    const cursors: CursorSnapshot[] = [makeCursor({ id: 'activity_logs' })];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'no cursor row for security_audit_log',
      should: 'report missing with zero delivery count',
      actual: {
        status: result.sources.security_audit_log!.status,
        deliveryCount: result.sources.security_audit_log!.deliveryCount,
        lastDeliveredAt: result.sources.security_audit_log!.lastDeliveredAt,
        lastError: result.sources.security_audit_log!.lastError,
      },
      expected: {
        status: 'missing',
        deliveryCount: 0,
        lastDeliveredAt: null,
        lastError: null,
      },
    });
  });

  it('given recentReceipts null, should omit lastReceipt from every source', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({ id: 'activity_logs' }),
      makeCursor({ id: 'security_audit_log' }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'recentReceipts null (feature unavailable)',
      should: 'omit lastReceipt for every source',
      actual: [
        'lastReceipt' in result.sources.activity_logs!,
        'lastReceipt' in result.sources.security_audit_log!,
      ],
      expected: [false, false],
    });
  });

  it('given recentReceipts with a match, should include lastReceipt for that source with ISO-serialized dates', () => {
    const cursors: CursorSnapshot[] = [makeCursor({ id: 'activity_logs' })];
    const receipts: RecentReceipt[] = [
      {
        deliveryId: 'del_001',
        source: 'activity_logs',
        deliveredAt: new Date('2026-04-10T12:00:00Z'),
        ackReceivedAt: new Date('2026-04-10T12:00:02Z'),
        entryCount: 25,
      },
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: receipts,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a matching receipt',
      should: 'attach ISO-serialized lastReceipt to the source',
      actual: result.sources.activity_logs!.lastReceipt,
      expected: {
        deliveryId: 'del_001',
        deliveredAt: '2026-04-10T12:00:00.000Z',
        ackReceivedAt: '2026-04-10T12:00:02.000Z',
        entryCount: 25,
      },
    });
  });

  it('given recentReceipts with no match for a source, should omit lastReceipt for that source but still populate the others', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({ id: 'activity_logs' }),
      makeCursor({ id: 'security_audit_log' }),
    ];
    const receipts: RecentReceipt[] = [
      {
        deliveryId: 'del_001',
        source: 'activity_logs',
        deliveredAt: new Date('2026-04-10T12:00:00Z'),
        ackReceivedAt: null,
        entryCount: 5,
      },
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: receipts,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'receipts covering only activity_logs',
      should: 'include lastReceipt only on activity_logs',
      actual: {
        activity_logs: Boolean(result.sources.activity_logs!.lastReceipt),
        security_audit_log: 'lastReceipt' in result.sources.security_audit_log!,
      },
      expected: { activity_logs: true, security_audit_log: false },
    });
  });

  it('given a cursor whose lastError holds a raw webhook body, should redact it to unclassified_error on /health while keeping error status', () => {
    const rawBody =
      'HTTP 500: {"error":"invalid token: sk-live-abc123","stack":"at handler (/srv/app.js:42)"}';
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredId: null,
        lastDeliveredAt: null,
        lastError: rawBody,
        lastErrorAt: new Date('2026-04-10T12:05:00Z'),
        deliveryCount: 0,
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a legacy cursor row containing a raw customer-controlled webhook body',
      should: 'replace lastError with the safe marker but still report error status',
      actual: {
        lastError: result.sources.activity_logs!.lastError,
        status: result.sources.activity_logs!.status,
      },
      expected: { lastError: 'unclassified_error', status: 'error' },
    });
  });

  it('given a cursor whose lastError is a recognized safe class, should pass it through unchanged on /health', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredId: null,
        lastDeliveredAt: null,
        lastError: 'http_server_error',
        lastErrorAt: new Date('2026-04-10T12:05:00Z'),
        deliveryCount: 0,
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a cursor whose lastError is already a safe DeliveryErrorClass',
      should: 'pass the class through to /health verbatim',
      actual: result.sources.activity_logs!.lastError,
      expected: 'http_server_error',
    });
  });

  it('given a cursor with no error, should leave lastError null on /health', () => {
    const cursors: CursorSnapshot[] = [makeCursor({ id: 'activity_logs', lastError: null })];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'a healthy cursor with lastError null',
      should: 'keep lastError null (no spurious marker)',
      actual: result.sources.activity_logs!.lastError,
      expected: null,
    });
  });

  it('given a cursor lastDeliveredAt, should serialize it to ISO string in the output', () => {
    const cursors: CursorSnapshot[] = [
      makeCursor({
        id: 'activity_logs',
        lastDeliveredAt: new Date('2026-04-10T12:34:56Z'),
        updatedAt: new Date('2026-04-10T12:34:57Z'),
      }),
    ];

    const result = buildSiemHealth({
      enabled: true,
      type: 'webhook',
      sources: SOURCES,
      cursors,
      recentReceipts: null,
      cursorInitSentinel: SENTINEL,
    });

    assert({
      given: 'Date objects on the cursor',
      should: 'emit ISO strings in the output',
      actual: {
        lastDeliveredAt: result.sources.activity_logs!.lastDeliveredAt,
        updatedAt: result.sources.activity_logs!.updatedAt,
      },
      expected: {
        lastDeliveredAt: '2026-04-10T12:34:56.000Z',
        updatedAt: '2026-04-10T12:34:57.000Z',
      },
    });
  });
});
