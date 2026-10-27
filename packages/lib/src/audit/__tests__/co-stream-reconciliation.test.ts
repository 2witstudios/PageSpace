/**
 * Unit suite for runCoStreamReconciliation (#890 Phase 2, leaf 4).
 *
 * The consumer stub wires the pure reconciliation core (co-stream.ts) to
 * Admin PG store reads: windowed chained rows + an INDEPENDENT read of the
 * window's latest chained head (ORDER BY chain_seq DESC LIMIT 1). No cron
 * wiring here — the tamper drill (Phase 6) and the dual-era verifier
 * (backfill leaf) call it with collector-supplied records.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  runCoStreamReconciliation,
  type RunCoStreamReconciliationDeps,
} from '../co-stream-reconciliation';
import {
  reconcileCoStream,
  type CoStreamRecord,
  type CoStreamStoreRow,
  type ReconciliationWindow,
} from '../co-stream';

const WINDOW: ReconciliationWindow = {
  start: new Date('2026-02-01T00:00:00.000Z'),
  end: new Date('2026-02-01T01:00:00.000Z'),
};

const RECORDS: CoStreamRecord[] = [
  {
    eventId: 'evt-1',
    emissionHash: 'h1',
    eventType: 'auth.login.success',
    emittedAt: '2026-02-01T00:10:00.000Z',
  },
  {
    eventId: 'evt-2',
    emissionHash: 'h2',
    eventType: 'auth.logout',
    emittedAt: '2026-02-01T00:20:00.000Z',
  },
];

const STORE_ROWS: CoStreamStoreRow[] = [
  {
    id: 'evt-1',
    emissionHash: 'h1',
    eventType: 'auth.login.success',
    timestamp: new Date('2026-02-01T00:10:00.000Z'),
    chainSeq: 41,
    eventHash: 'c41',
  },
  {
    id: 'evt-2',
    emissionHash: 'h2',
    eventType: 'auth.logout',
    timestamp: new Date('2026-02-01T00:20:00.000Z'),
    chainSeq: 42,
    eventHash: 'c42',
  },
];

interface CapturedSelect {
  whereArg: unknown;
  orderByArgs: unknown[] | null;
  limitArg: number | null;
}

function createMockAdminDb(queuedResults: unknown[][]) {
  const selects: CapturedSelect[] = [];
  let queryIndex = 0;

  const select = vi.fn(() => {
    const call: CapturedSelect = { whereArg: null, orderByArgs: null, limitArg: null };
    selects.push(call);
    const result = queuedResults[queryIndex++] ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn((where: unknown) => {
        call.whereArg = where;
        return builder;
      }),
      orderBy: vi.fn((...args: unknown[]) => {
        call.orderByArgs = args;
        return builder;
      }),
      limit: vi.fn((n: number) => {
        call.limitArg = n;
        return builder;
      }),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const db = { select } as unknown as RunCoStreamReconciliationDeps['db'];
  return { db, select, selects };
}

describe('runCoStreamReconciliation', () => {
  it('reads windowed store rows + the window-latest chained head and returns exactly the pure-core report', async () => {
    const headRow = { chainSeq: 42, eventHash: 'c42' };
    const { db, select } = createMockAdminDb([STORE_ROWS, [headRow]]);

    const report = await runCoStreamReconciliation({ records: RECORDS, db, window: WINDOW });

    expect(select).toHaveBeenCalledTimes(2);
    expect(report).toEqual(reconcileCoStream(RECORDS, STORE_ROWS, WINDOW, headRow));
    expect(report.verified).toBe(true);
    expect(report.head.matches).toBe(true);
  });

  it('the head read is independent: ORDER BY … LIMIT 1, while the row read is unordered and unlimited', async () => {
    const { db, selects } = createMockAdminDb([STORE_ROWS, [{ chainSeq: 42, eventHash: 'c42' }]]);

    await runCoStreamReconciliation({ records: RECORDS, db, window: WINDOW });

    const [rowsQuery, headQuery] = selects;
    expect(rowsQuery!.whereArg).not.toBeNull();
    expect(rowsQuery!.orderByArgs).toBeNull();
    expect(rowsQuery!.limitArg).toBeNull();
    expect(headQuery!.whereArg).not.toBeNull();
    expect(headQuery!.orderByArgs).not.toBeNull();
    expect(headQuery!.limitArg).toBe(1);
  });

  it('given no chained rows in the window, passes a null head — the report is unverified', async () => {
    const { db } = createMockAdminDb([[], []]);

    const report = await runCoStreamReconciliation({ records: RECORDS, db, window: WINDOW });

    expect(report.head.latestChainedHead).toBeNull();
    expect(report.head.matches).toBe(false);
    expect(report.verified).toBe(false);
    expect(report.counts.missing_from_store).toBe(2);
  });

  it('propagates store read errors to the caller — the drill/verifier owns failure handling', async () => {
    const failure = new Error('admin pg unreachable');
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => Promise.reject(failure),
        }),
      })),
    } as unknown as RunCoStreamReconciliationDeps['db'];

    await expect(runCoStreamReconciliation({ records: [], db, window: WINDOW })).rejects.toBe(failure);
  });
});
