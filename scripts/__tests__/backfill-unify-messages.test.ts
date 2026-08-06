/**
 * Tests for the chat_messages → messages backfill (Phase 4 PR 10 of the
 * "Agent-Session Single Source of Truth" epic).
 *
 * `db.execute` is stubbed with a scripted queue of results, so the loop's
 * CONTROL FLOW — where it resumes, how far each batch advances the cursor,
 * when it stops, what the summary reports — is exercised without a database.
 * The SQL text of each call is captured too, because two of this script's
 * correctness properties are properties of the statements themselves:
 * `ON CONFLICT ... DO NOTHING` (idempotency) and the `("createdAt", id)`
 * row-comparison cursor (a `createdAt`-only cursor would loop or skip on a
 * shared timestamp).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Executed {
  sql: string;
  params: unknown[];
}

const executed: Executed[] = [];
const queue: Array<{ rows: unknown[] }> = [];

const mockDb = {
  execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
    // The stubbed `sql` tag below produces { sqlText, params }; drizzle's real
    // one produces a chunked AST. Only the stub is ever used here.
    const q = query as unknown as { sqlText: string; params: unknown[] };
    executed.push({ sql: q.sqlText, params: q.params });
    return queue.shift() ?? { rows: [] };
  }),
};

vi.mock('@pagespace/db/db', () => ({ getMigrationDb: () => mockDb }));

// Minimal `sql` tag: concatenates the literal chunks, substitutes `$n` for
// each interpolation, and recursively inlines nested fragments (the script
// composes `cursorBound(...)` and `CREATED_AT_TEXT` into larger statements).
vi.mock('@pagespace/db/operators', () => {
  interface Fragment {
    sqlText: string;
    params: unknown[];
    __fragment: true;
  }
  const isFragment = (v: unknown): v is Fragment =>
    typeof v === 'object' && v !== null && '__fragment' in (v as Record<string, unknown>);

  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Fragment => {
    let sqlText = '';
    const params: unknown[] = [];
    strings.forEach((chunk, index) => {
      sqlText += chunk;
      if (index >= values.length) return;
      const value = values[index];
      if (isFragment(value)) {
        sqlText += value.sqlText;
        params.push(...value.params);
      } else {
        params.push(value);
        sqlText += `$${params.length}`;
      }
    });
    return { sqlText, params, __fragment: true };
  };
  return { sql };
});

import { runBackfill, deriveResumeCursor } from '../backfill-unify-messages';

const row = (id: string, createdAtText: string, hasConversation = true) => ({
  id,
  createdAtText,
  hasConversation,
});

beforeEach(() => {
  executed.length = 0;
  queue.length = 0;
  mockDb.execute.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('deriveResumeCursor', () => {
  it('given no uncopied legacy row, returns null (the tables are reconciled)', async () => {
    queue.push({ rows: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed db is structurally sufficient
    expect(await deriveResumeCursor(mockDb as any)).toBeNull();
  });

  it('resumes at the FIRST GAP, inclusive, not at the target table maximum', async () => {
    queue.push({ rows: [row('m-3', '2026-01-01 00:00:03.000000')] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const cursor = await deriveResumeCursor(mockDb as any);

    expect(cursor).toEqual({
      createdAtText: '2026-01-01 00:00:03.000000',
      id: 'm-3',
      inclusive: true,
    });
    // The resume query must be an anti-join on the TARGET table. A
    // MAX("createdAt") derivation would fast-forward past the whole backlog,
    // because the dual-write is concurrently inserting rows stamped `now()`.
    expect(executed[0].sql).toContain('NOT EXISTS');
    expect(executed[0].sql).toContain('FROM messages m');
    expect(executed[0].sql).not.toContain('max(');
  });
});

describe('runBackfill', () => {
  it('given nothing to copy, reports a zero run without issuing a copy', async () => {
    queue.push({ rows: [] }); // resume cursor: no gap

    const summary = await runBackfill();

    expect(summary).toMatchObject({ copied: 0, skipped: 0, total: 0, batches: 0 });
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it('copies a single short batch and stops without an extra round trip', async () => {
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] }); // resume
    queue.push({
      rows: [row('m-1', '2026-01-01 00:00:01.000000'), row('m-2', '2026-01-01 00:00:02.000000')],
    }); // candidates (short: 2 < batchSize)
    queue.push({ rows: [{ id: 'm-1' }, { id: 'm-2' }] }); // insert ... returning

    const summary = await runBackfill({ batchSize: 10 });

    expect(summary).toMatchObject({ copied: 2, skipped: 0, total: 2, batches: 1, dryRun: false });
    // resume + candidates + insert, then stop — a short batch proves exhaustion.
    expect(mockDb.execute).toHaveBeenCalledTimes(3);
  });

  it('walks batch by batch, advancing the cursor to the last row of the previous batch', async () => {
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] }); // resume
    queue.push({
      rows: [row('m-1', '2026-01-01 00:00:01.000000'), row('m-2', '2026-01-01 00:00:02.000000')],
    }); // full batch of 2
    queue.push({ rows: [{ id: 'm-1' }, { id: 'm-2' }] });
    queue.push({ rows: [row('m-3', '2026-01-01 00:00:03.000000')] }); // short batch
    queue.push({ rows: [{ id: 'm-3' }] });

    const summary = await runBackfill({ batchSize: 2 });

    expect(summary).toMatchObject({ copied: 3, total: 3, batches: 2 });
    // The second batch's candidate query carries the previous batch's LAST
    // row as an EXCLUSIVE cursor.
    const secondCandidateQuery = executed[3];
    expect(secondCandidateQuery.params).toContain('2026-01-01 00:00:02.000000');
    expect(secondCandidateQuery.params).toContain('m-2');
  });

  it('is idempotent by construction: anti-join candidates + ON CONFLICT DO NOTHING', async () => {
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] });
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] });
    queue.push({ rows: [{ id: 'm-1' }] });

    await runBackfill({ batchSize: 10 });

    const candidateQuery = executed[1].sql;
    const insertQuery = executed[2].sql;
    expect(candidateQuery).toContain('NOT EXISTS (SELECT 1 FROM messages m');
    expect(insertQuery).toContain('ON CONFLICT ("id") DO NOTHING');
    // Never an UPDATE: a copied row belongs to whoever wrote it (the
    // dual-write or an earlier run) and is never overwritten from the legacy
    // snapshot.
    expect(insertQuery).not.toContain('DO UPDATE');
  });

  it('orders and bounds by ("createdAt", id) — never by createdAt alone', async () => {
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] });
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] });
    queue.push({ rows: [{ id: 'm-1' }] });

    await runBackfill({ batchSize: 10 });

    expect(executed[1].sql).toContain('ORDER BY c."createdAt", c."id"');
    expect(executed[1].sql).toContain('(c."createdAt", c."id")');
  });

  it('counts a row whose conversation is missing as skipped, and does not stall on it', async () => {
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] });
    queue.push({
      rows: [
        row('m-1', '2026-01-01 00:00:01.000000', false), // no conversations row
        row('m-2', '2026-01-01 00:00:02.000000'),
      ],
    });
    queue.push({ rows: [{ id: 'm-2' }] }); // only the copyable one comes back

    const summary = await runBackfill({ batchSize: 10 });

    expect(summary).toMatchObject({
      copied: 1,
      skipped: 1,
      skippedNoConversation: 1,
      total: 2,
    });
    // The copy statement filters them out itself, so the FK cannot abort the batch.
    expect(executed[2].sql).toContain('EXISTS (SELECT 1 FROM conversations cv');
  });

  it('--dry-run reports what it would copy and issues no INSERT', async () => {
    queue.push({ rows: [row('m-1', '2026-01-01 00:00:01.000000')] });
    queue.push({
      rows: [
        row('m-1', '2026-01-01 00:00:01.000000'),
        row('m-2', '2026-01-01 00:00:02.000000', false),
      ],
    });

    const summary = await runBackfill({ batchSize: 10, dryRun: true });

    expect(summary).toMatchObject({
      copied: 1,
      skipped: 1,
      skippedNoConversation: 1,
      total: 2,
      dryRun: true,
    });
    expect(executed.every((call) => !call.sql.includes('INSERT INTO messages'))).toBe(true);
  });
});
