import { describe, it, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { readRecentReceipts } from '../siem-receipt-reader';

function makeClient(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('readRecentReceipts', () => {
  it('given receipts for both sources, should return one per source (most recent)', async () => {
    const client = makeClient([
      {
        deliveryId: 'del_a',
        source: 'activity_logs',
        deliveredAt: new Date('2026-04-10T12:00:00Z'),
        ackReceivedAt: new Date('2026-04-10T12:00:02Z'),
        entryCount: 3,
      },
      {
        deliveryId: 'del_b',
        source: 'security_audit_log',
        deliveredAt: new Date('2026-04-10T12:01:00Z'),
        ackReceivedAt: null,
        entryCount: 7,
      },
    ]);

    const result = await readRecentReceipts(client);

    assert({
      given: 'receipts for both sources',
      should: 'map rows into RecentReceipt entries',
      actual: result?.map((r) => ({ deliveryId: r.deliveryId, source: r.source, entryCount: r.entryCount })),
      expected: [
        { deliveryId: 'del_a', source: 'activity_logs', entryCount: 3 },
        { deliveryId: 'del_b', source: 'security_audit_log', entryCount: 7 },
      ],
    });
  });

  it('given no receipts, should return an empty array', async () => {
    const client = makeClient([]);
    const result = await readRecentReceipts(client);

    assert({
      given: 'the receipts table is empty',
      should: 'return an empty array (feature available, no data)',
      actual: result,
      expected: [],
    });
  });

  it('given a 42P01 relation-not-found error, should return null (feature unavailable)', async () => {
    const relationNotFound: Error & { code?: string } = Object.assign(
      new Error('relation "siem_delivery_receipts" does not exist'),
      { code: '42P01' },
    );
    const client = { query: vi.fn().mockRejectedValue(relationNotFound) };

    const result = await readRecentReceipts(client);

    assert({
      given: 'the receipts table does not yet exist',
      should: 'return null so the builder omits lastReceipt fields',
      actual: result,
      expected: null,
    });
  });

  it('given any other DB error, should throw', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection reset')) };

    let thrown: unknown = null;
    try {
      await readRecentReceipts(client);
    } catch (err) {
      thrown = err;
    }

    assert({
      given: 'a non-schema DB error',
      should: 'propagate the error',
      actual: thrown instanceof Error && thrown.message,
      expected: 'connection reset',
    });
  });
});
