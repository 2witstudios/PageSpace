import { describe, it, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { writeReceipts } from '../siem-receipt-writer';
import type { ReceiptRow } from '../../services/siem-receipt-builder';
import type { PgPoolClient } from '../../db';

function makeReceipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    deliveryId: 'delivery-xyz',
    source: 'activity_logs',
    firstEntryId: 'a1',
    lastEntryId: 'a2',
    firstEntryTimestamp: new Date('2026-04-10T12:00:00Z'),
    lastEntryTimestamp: new Date('2026-04-10T12:01:00Z'),
    entryCount: 2,
    deliveredAt: new Date('2026-04-10T12:05:00Z'),
    webhookStatus: 200,
    webhookResponseHash: 'abc',
    ackReceivedAt: null,
    ...overrides,
  };
}

function makeClient(queryImpl: ReturnType<typeof vi.fn>): PgPoolClient {
  return {
    query: queryImpl as unknown as PgPoolClient['query'],
    release: vi.fn(),
  };
}

describe('writeReceipts', () => {
  it('empty receipts array results in no DB call', async () => {
    const query = vi.fn();
    const client = makeClient(query);

    await writeReceipts(client, []);

    assert({
      given: 'an empty receipts array',
      should: 'not call client.query',
      actual: query.mock.calls.length,
      expected: 0,
    });
  });

  it('two receipts produce a single INSERT with both rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    const client = makeClient(query);

    const receipts: ReceiptRow[] = [
      makeReceipt({ source: 'activity_logs', firstEntryId: 'a1', lastEntryId: 'a2' }),
      makeReceipt({ source: 'security_audit_log', firstEntryId: 's1', lastEntryId: 's1', entryCount: 1 }),
    ];

    await writeReceipts(client, receipts);

    assert({
      given: 'two receipts',
      should: 'issue exactly one DB round trip',
      actual: query.mock.calls.length,
      expected: 1,
    });

    const [sql, params] = query.mock.calls[0];

    assert({
      given: 'two receipts',
      should: 'emit an INSERT against siem_delivery_receipts',
      actual: typeof sql === 'string' && (sql as string).includes('INSERT INTO siem_delivery_receipts'),
      expected: true,
    });

    assert({
      given: 'two receipts',
      should: 'emit two parameterized value clauses',
      actual: (sql as string).match(/\$\d+/g)?.length,
      expected: 22, // 2 rows * 11 columns
    });

    assert({
      given: 'two receipts',
      should: 'pass 22 params in order',
      actual: (params as unknown[]).length,
      expected: 22,
    });

    assert({
      given: 'two receipts',
      should: 'put the first receipt source at param index 1',
      actual: (params as unknown[])[1],
      expected: 'activity_logs',
    });

    assert({
      given: 'two receipts',
      should: 'put the second receipt source at param index 12',
      actual: (params as unknown[])[12],
      expected: 'security_audit_log',
    });
  });

  it('DB error propagates to caller', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection reset'));
    const client = makeClient(query);

    let thrown: Error | null = null;
    try {
      await writeReceipts(client, [makeReceipt()]);
    } catch (e) {
      thrown = e as Error;
    }

    assert({
      given: 'a DB error on INSERT',
      should: 'throw so the worker try/catch can handle it',
      actual: thrown?.message,
      expected: 'connection reset',
    });
  });
});
