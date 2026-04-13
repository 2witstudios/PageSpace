import { describe, it, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { readCursorSnapshots } from '../siem-cursor-reader';
import type { AuditLogSource } from '../../services/siem-adapter';

const SOURCES: readonly AuditLogSource[] = ['activity_logs', 'security_audit_log'];

function makeClient(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('readCursorSnapshots', () => {
  it('given an empty table, should return an empty array', async () => {
    const client = makeClient([]);
    const result = await readCursorSnapshots(client, SOURCES);

    assert({
      given: 'no cursor rows in the DB',
      should: 'return an empty array',
      actual: result,
      expected: [],
    });
  });

  it('given two cursor rows, should return two snapshots', async () => {
    const client = makeClient([
      {
        id: 'activity_logs',
        lastDeliveredId: 'log_001',
        lastDeliveredAt: new Date('2026-04-10T12:00:00Z'),
        lastError: null,
        lastErrorAt: null,
        deliveryCount: 3,
        updatedAt: new Date('2026-04-10T12:00:05Z'),
      },
      {
        id: 'security_audit_log',
        lastDeliveredId: 'sec_001',
        lastDeliveredAt: new Date('2026-04-10T12:01:00Z'),
        lastError: null,
        lastErrorAt: null,
        deliveryCount: 7,
        updatedAt: new Date('2026-04-10T12:01:05Z'),
      },
    ]);

    const result = await readCursorSnapshots(client, SOURCES);

    assert({
      given: 'two cursor rows',
      should: 'return two snapshots preserving the source ids',
      actual: result.map((r) => r.id),
      expected: ['activity_logs', 'security_audit_log'],
    });
  });

  it('given a DB error, should throw so the server handler can catch it', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    };

    let thrown: unknown = null;
    try {
      await readCursorSnapshots(client, SOURCES);
    } catch (err) {
      thrown = err;
    }

    assert({
      given: 'the DB rejects the query',
      should: 'propagate the error',
      actual: thrown instanceof Error && thrown.message,
      expected: 'connection refused',
    });
  });

  it('given the query, should filter by id = ANY(SOURCES) so non-siem ids are excluded', async () => {
    const client = makeClient([]);
    await readCursorSnapshots(client, SOURCES);

    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];

    assert({
      given: 'the cursor query is issued',
      should: 'use id = ANY($1) with SOURCES as the parameter',
      actual: { matchesSql: /id\s*=\s*ANY\(\$1/.test(sql), params },
      expected: { matchesSql: true, params: [SOURCES] },
    });
  });
});
