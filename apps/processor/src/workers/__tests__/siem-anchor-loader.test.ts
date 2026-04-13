import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  loadAnchorHash,
  loadActivityLogHashableFields,
  loadSecurityAuditHashableFields,
} from '../siem-anchor-loader';
import { CURSOR_INIT_SENTINEL } from '../siem-delivery-worker';

interface MockQueryCall {
  sql: string;
  params: unknown[];
}

function createMockClient(responses: Array<{ rows: Record<string, unknown>[]; rowCount: number }>) {
  const calls: MockQueryCall[] = [];
  let i = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    const resp = responses[i++];
    if (!resp) {
      throw new Error(`Unexpected extra query call #${i}: ${sql}`);
    }
    return resp;
  });
  return { query, calls };
}

describe('loadAnchorHash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('non-sentinel activity_logs id selects logHash by id', async () => {
    const client = createMockClient([
      { rows: [{ logHash: 'activity_anchor_hash' }], rowCount: 1 },
    ]);

    const result = await loadAnchorHash(client, 'activity_logs', 'log_prev_99');

    assert({
      given: 'a non-sentinel activity_logs lastDeliveredId',
      should: 'return the logHash of that row',
      actual: result,
      expected: 'activity_anchor_hash',
    });

    assert({
      given: 'a non-sentinel activity_logs lastDeliveredId',
      should: 'SELECT logHash from activity_logs WHERE id = $1',
      actual: client.calls[0].sql.includes('"logHash"') && client.calls[0].sql.includes('FROM activity_logs'),
      expected: true,
    });

    assert({
      given: 'a non-sentinel activity_logs lastDeliveredId',
      should: 'pass the id as the single parameter',
      actual: client.calls[0].params,
      expected: ['log_prev_99'],
    });
  });

  it('non-sentinel security_audit_log id selects event_hash aliased as logHash', async () => {
    const client = createMockClient([
      { rows: [{ logHash: 'security_anchor_hash' }], rowCount: 1 },
    ]);

    const result = await loadAnchorHash(client, 'security_audit_log', 'sec_prev_99');

    assert({
      given: 'a non-sentinel security_audit_log lastDeliveredId',
      should: 'return the event_hash aliased as logHash',
      actual: result,
      expected: 'security_anchor_hash',
    });

    assert({
      given: 'a non-sentinel security_audit_log lastDeliveredId',
      should: 'alias event_hash AS logHash in the SELECT',
      actual:
        client.calls[0].sql.includes('event_hash') &&
        client.calls[0].sql.includes('FROM security_audit_log'),
      expected: true,
    });
  });

  it('CURSOR_INIT_SENTINEL returns null without querying', async () => {
    const client = createMockClient([]);

    const result = await loadAnchorHash(client, 'activity_logs', CURSOR_INIT_SENTINEL);

    assert({
      given: 'a lastDeliveredId equal to CURSOR_INIT_SENTINEL',
      should: 'return null without querying',
      actual: result,
      expected: null,
    });

    assert({
      given: 'a sentinel lastDeliveredId',
      should: 'make zero database calls',
      actual: client.calls.length,
      expected: 0,
    });
  });

  it('missing row logs a warn and returns null', async () => {
    const client = createMockClient([{ rows: [], rowCount: 0 }]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await loadAnchorHash(client, 'activity_logs', 'log_deleted');

    assert({
      given: 'a lastDeliveredId whose row is missing',
      should: 'return null',
      actual: result,
      expected: null,
    });

    assert({
      given: 'a lastDeliveredId whose row is missing',
      should: 'emit a warn via console.warn',
      actual: warnSpy.mock.calls.length >= 1,
      expected: true,
    });

    warnSpy.mockRestore();
  });
});

describe('loadActivityLogHashableFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('empty id array short-circuits with empty map', async () => {
    const client = createMockClient([]);

    const result = await loadActivityLogHashableFields(client, []);

    assert({
      given: 'an empty id array',
      should: 'return an empty map without querying',
      actual: { size: result.size, calls: client.calls.length },
      expected: { size: 0, calls: 0 },
    });
  });

  it('returns a map of id → hashable fields for each row', async () => {
    const row = {
      id: 'log_1',
      timestamp: new Date('2026-04-10T12:00:00Z'),
      operation: 'page.update',
      resourceType: 'page',
      resourceId: 'p1',
      driveId: null,
      pageId: null,
      contentSnapshot: null,
      previousValues: null,
      newValues: null,
      metadata: null,
    };
    const client = createMockClient([{ rows: [row], rowCount: 1 }]);

    const result = await loadActivityLogHashableFields(client, ['log_1']);

    assert({
      given: 'one activity_logs id',
      should: 'return a 1-entry map keyed by id',
      actual: {
        size: result.size,
        hasId: result.has('log_1'),
        operation: result.get('log_1')?.operation,
      },
      expected: { size: 1, hasId: true, operation: 'page.update' },
    });

    assert({
      given: 'an id array',
      should: 'SELECT from activity_logs WHERE id = ANY($1)',
      actual: client.calls[0].sql.includes('WHERE id = ANY($1)'),
      expected: true,
    });
  });
});

describe('loadSecurityAuditHashableFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('empty id array short-circuits with empty map', async () => {
    const client = createMockClient([]);

    const result = await loadSecurityAuditHashableFields(client, []);

    assert({
      given: 'an empty id array',
      should: 'return an empty map without querying',
      actual: { size: result.size, calls: client.calls.length },
      expected: { size: 0, calls: 0 },
    });
  });

  it('returns a map of id → hashable fields for each row', async () => {
    const row = {
      id: 'sec_1',
      eventType: 'auth.login.success',
      serviceId: null,
      resourceType: 'user',
      resourceId: 'u1',
      details: null,
      riskScore: null,
      anomalyFlags: null,
      timestamp: new Date('2026-04-10T09:00:00Z'),
    };
    const client = createMockClient([{ rows: [row], rowCount: 1 }]);

    const result = await loadSecurityAuditHashableFields(client, ['sec_1']);

    assert({
      given: 'one security_audit_log id',
      should: 'return a 1-entry map keyed by id with the eventType preserved',
      actual: {
        size: result.size,
        eventType: result.get('sec_1')?.eventType,
      },
      expected: { size: 1, eventType: 'auth.login.success' },
    });

    assert({
      given: 'an id array',
      should: 'SELECT from security_audit_log WHERE id = ANY($1)',
      actual:
        client.calls[0].sql.includes('FROM security_audit_log') &&
        client.calls[0].sql.includes('WHERE id = ANY($1)'),
      expected: true,
    });
  });
});
