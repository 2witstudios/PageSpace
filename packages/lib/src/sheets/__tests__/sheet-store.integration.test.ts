/**
 * Integration tests for the sheet row store.
 *
 * These need a real database, and that is the point rather than an
 * inconvenience. Every serious defect this layer has had was invisible to unit
 * testing: whole-row jsonb upserts silently deleting columns, `AND` binding
 * tighter than `OR` so a tab filter stopped applying, Postgres declining to
 * short-circuit a type guard next to a cast, a per-row unique constraint
 * tripping mid-statement, a bind-parameter ceiling reached only under bulk
 * load. A mocked database reproduces none of them.
 *
 * Requires a running Postgres with the latest migrations applied. Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/lib' test:integration
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { sheetTabs, sheetRows, sheetCellDeps, sheetRangeDeps, sheetChanges } from '@pagespace/db/schema';
import {
  setCells,
  appendRows,
  deleteRows,
  readRows,
  queryRows,
  readSheetData,
  getTab,
  rebuildTab,
} from '../store';
import type { StoredRow } from '../projection';

/** A sheet page with one tab, sized so appends land where the test expects. */
async function makeSheet(options: { rowCount?: number; columnCount?: number } = {}) {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const page = await factories.createPage(drive.id, { type: 'SHEET', title: 'Sheet', position: 0 });

  const [tab] = await db
    .insert(sheetTabs)
    .values({
      pageId: page.id,
      tabIndex: 0,
      name: 'Sheet1',
      rowCount: options.rowCount ?? 0,
      columnCount: options.columnCount ?? 8,
    })
    .returning();

  return { ownerId: owner.id, pageId: page.id, tabId: tab.id };
}

const cellAt = (rows: StoredRow[], rowIndex: number, column: string) =>
  rows.find((row) => row.rowIndex === rowIndex)?.cells[column];

describe('sheet store (integration)', () => {
  beforeEach(async () => {
    await db.delete(sheetChanges);
    await db.delete(sheetRangeDeps);
    await db.delete(sheetCellDeps);
    await db.delete(sheetRows);
    await db.delete(sheetTabs);
    await db.delete(pages);
    await db.delete(drives);
    await db.delete(users);
  });

  describe('writes materialise values', () => {
    it('stores the computed value beside the authored text', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();

      await setCells({ pageId }, [
        { address: 'A1', value: '10' },
        { address: 'A2', value: '20' },
        { address: 'B1', value: '=A1*2' },
        { address: 'C1', value: '=SUM(A1:A2)' },
      ], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 100 });
      expect(cellAt(rows, 0, 'A')?.value).toBe(10);
      expect(cellAt(rows, 0, 'B')?.value).toBe(20);
      expect(cellAt(rows, 0, 'C')?.value).toBe(30);
      // The formula text survives; only the value is derived.
      expect(cellAt(rows, 0, 'B')?.raw).toBe('=A1*2');
    });

    it('recomputes only the dependency closure', async () => {
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: '10' },
        { address: 'B1', value: '=A1*2' },
        { address: 'E9', value: 'unrelated' },
      ], { userId: ownerId });

      const touched = await setCells({ pageId }, [{ address: 'A1', value: '50' }], { userId: ownerId });
      expect(touched.recomputed).toEqual(['B1']);

      const untouched = await setCells({ pageId }, [{ address: 'E9', value: 'still' }], { userId: ownerId });
      expect(untouched.recomputed).toEqual([]);
    });
  });

  describe('recomputing a dependent in another row', () => {
    it('leaves the rest of that row intact', async () => {
      // The whole-row jsonb upsert makes this the sharpest failure mode in the
      // store: recomputing B2 must not delete C2 and D2 beside it.
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: '10' },
        { address: 'B2', value: '=A1*2' },
        { address: 'C2', value: 'keep me' },
        { address: 'D2', value: 'me too' },
      ], { userId: ownerId });

      await setCells({ pageId }, [{ address: 'A1', value: '50' }], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 100 });
      expect(cellAt(rows, 1, 'B')?.value).toBe(100);
      expect(cellAt(rows, 1, 'B')?.raw).toBe('=A1*2');
      expect(cellAt(rows, 1, 'C')?.value).toBe('keep me');
      expect(cellAt(rows, 1, 'D')?.value).toBe('me too');
    });

    it('reads its inputs from rows the edit never named', async () => {
      // B5 reads A2, which is in neither the edited row nor B5's own row. If
      // the input is not loaded it evaluates as empty and B5 is materialised
      // with a wrong but entirely plausible number.
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: '10' },
        { address: 'A2', value: '7' },
        { address: 'B5', value: '=A1+A2' },
        { address: 'B6', value: '=SUM(A1:A2)' },
      ], { userId: ownerId });

      await setCells({ pageId }, [{ address: 'A1', value: '100' }], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 100 });
      expect(cellAt(rows, 4, 'B')?.value).toBe(107);
      expect(cellAt(rows, 5, 'B')?.value).toBe(107);
    });
  });

  describe('closure scoping', () => {
    it('never reaches into another page', async () => {
      const other = await makeSheet();
      await setCells({ pageId: other.pageId }, [{ address: 'Z1', value: '=SUM(A1:A9)' }], { userId: other.ownerId });

      const mine = await makeSheet();
      // More than one dirty cell: with the range clauses joined by OR and not
      // parenthesised, AND binds tighter and every clause after the first
      // escapes the tab filter.
      const result = await setCells({ pageId: mine.pageId }, [
        { address: 'A1', value: '1' },
        { address: 'A2', value: '2' },
        { address: 'A3', value: '3' },
      ], { userId: mine.ownerId });

      expect(result.recomputed).toEqual([]);

      const otherRows = await readRows(other.tabId, { limit: 10 });
      expect(cellAt(otherRows, 0, 'Z')?.raw).toBe('=SUM(A1:A9)');
    });
  });

  describe('dependency edges', () => {
    it('stores a range as one row rather than expanding it', async () => {
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'B1', value: '=SUM(A1:A1000)' }], { userId: ownerId });

      const ranges = await db.select().from(sheetRangeDeps);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].rowStart).toBe(0);
      expect(ranges[0].rowEnd).toBe(999);
    });

    it('drops edges when a formula becomes a literal', async () => {
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'B1', value: '=SUM(A1:A10)' }], { userId: ownerId });
      expect(await db.select().from(sheetRangeDeps)).toHaveLength(1);

      await setCells({ pageId }, [{ address: 'B1', value: 'plain text' }], { userId: ownerId });
      expect(await db.select().from(sheetRangeDeps)).toHaveLength(0);
    });
  });

  describe('appendRows', () => {
    it('appends without rewriting the sheet', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      const result = await appendRows({ pageId }, [
        { A: 'one', B: '1' },
        { A: 'two', B: '2' },
      ], { userId: ownerId });

      expect(result.appended).toBe(2);
      const rows = await readRows(tabId, { limit: 100 });
      expect(cellAt(rows, result.firstRowIndex, 'A')?.value).toBe('one');
      expect(cellAt(rows, result.firstRowIndex + 1, 'B')?.value).toBe(2);
    });

    it('widens the tab to fit columns past its declared width', async () => {
      const { pageId, ownerId } = await makeSheet({ columnCount: 3 });
      await appendRows({ pageId }, [{ A: '1', B: '2', C: '3', D: '4', E: '5' }], { userId: ownerId });

      const tab = await getTab({ pageId });
      expect(tab!.columnCount).toBeGreaterThanOrEqual(5);
    });

    it('records one change entry for a bulk append, not one per cell', async () => {
      // Per-cell audit rows for a bulk load are both useless and unbounded —
      // and overrun Postgres's bind-parameter ceiling.
      const { pageId, ownerId } = await makeSheet();
      await appendRows(
        { pageId },
        Array.from({ length: 300 }, (_, index) => ({ A: String(index), B: 'x', C: 'y' })),
        { userId: ownerId }
      );

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sheetChanges);
      expect(count).toBeLessThan(10);
    });
  });

  describe('deleteRows', () => {
    it('closes the gap without tripping the row-index unique constraint', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      await appendRows(
        { pageId },
        Array.from({ length: 20 }, (_, index) => ({ A: String(index) })),
        { userId: ownerId }
      );
      // Rewrite two rows so heap order stops matching rowIndex order, which is
      // what makes a naive single-statement shift collide.
      await setCells({ pageId }, [{ address: 'B5', value: 'x' }, { address: 'B2', value: 'y' }], { userId: ownerId });

      await expect(deleteRows({ pageId }, 2, 3, { userId: ownerId })).resolves.toBeTruthy();

      const rows = await readRows(tabId, { limit: 100 });
      expect(cellAt(rows, 2, 'A')?.value).toBe(5);
      expect(new Set(rows.map((row) => row.rowIndex)).size).toBe(rows.length);
    });
  });

  describe('queryRows', () => {
    async function seeded() {
      const sheet = await makeSheet();
      await appendRows({ pageId: sheet.pageId }, [
        { A: 'alpha', B: '10', C: 'active' },
        { A: 'beta', B: '250', C: 'inactive' },
        { A: 'gamma', B: '30', C: 'active' },
        { A: '50% off', B: 'n/a', C: 'active' },
        { A: 'delta', B: '7', C: '' },
      ], { userId: sheet.ownerId });
      return sheet;
    }

    it('filters on equality', async () => {
      const { pageId } = await seeded();
      expect((await queryRows({ pageId }, { where: { column: 'C', op: 'eq', value: 'active' } })).total).toBe(3);
    });

    it('compares numerically without failing on a text cell in the column', async () => {
      // Column B holds "n/a". Postgres does not guarantee AND short-circuits,
      // so a type guard beside the cast does not protect it — the cast must sit
      // inside a CASE or this raises 22023 and the whole query dies.
      const { pageId } = await seeded();
      const result = await queryRows({ pageId }, { where: { column: 'B', op: 'gt', value: 20 } });
      expect(result.total).toBe(2);
    });

    it('treats a literal % as text, not a wildcard', async () => {
      const { pageId } = await seeded();
      expect((await queryRows({ pageId }, { where: { column: 'A', op: 'contains', value: '50%' } })).total).toBe(1);
    });

    it('combines conditions', async () => {
      const { pageId } = await seeded();
      const result = await queryRows({ pageId }, {
        where: { and: [{ column: 'C', op: 'eq', value: 'active' }, { column: 'B', op: 'gt', value: 20 }] },
      });
      expect(result.total).toBe(1);
      expect(result.rows[0].cells.A?.value).toBe('gamma');
    });

    it('filters on a formula result rather than its text', async () => {
      const { pageId, ownerId } = await seeded();
      await setCells({ pageId }, [{ address: 'D1', value: '=B1*2' }], { userId: ownerId });

      expect((await queryRows({ pageId }, { where: { column: 'D', op: 'eq', value: 20 } })).total).toBe(1);
      expect((await queryRows({ pageId }, { where: { column: 'D', op: 'contains', value: '=B' } })).total).toBe(0);
    });

    it('compares booleans', async () => {
      // Postgres has no boolean-to-jsonb cast; `true::jsonb` raises.
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'B1', value: '=1=1' }], { userId: ownerId });
      const result = await queryRows({ pageId }, { where: { column: 'B', op: 'eq', value: true } });
      expect(result.total).toBe(1);
    });

    it('sorts, limits and paginates', async () => {
      const { pageId } = await seeded();
      const page1 = await queryRows({ pageId }, {
        orderBy: [{ column: 'B', numeric: true, direction: 'desc' }],
        limit: 2,
      });
      expect(page1.rows[0].cells.B?.value).toBe(250);
      expect(page1.hasMore).toBe(true);

      const last = await queryRows({ pageId }, { limit: 2, offset: 4 });
      expect(last.hasMore).toBe(false);
    });

    it('projects only the requested columns', async () => {
      const { pageId } = await seeded();
      const result = await queryRows({ pageId }, { select: ['A', 'C'], limit: 1 });
      expect(Object.keys(result.rows[0].cells).sort()).toEqual(['A', 'C']);
    });

    it('cannot be made to execute injected SQL', async () => {
      const { pageId } = await seeded();
      const result = await queryRows({ pageId }, {
        where: { column: 'A', op: 'eq', value: "x'; DELETE FROM sheet_rows; --" },
      });
      expect(result.total).toBe(0);

      // The rows are still there — the string was compared, not executed.
      expect((await queryRows({ pageId }, {})).total).toBe(5);
    });
  });

  describe('cell preservation', () => {
    it('keeps formatting when a cell is cleared', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId });
      await db.execute(
        sql`update sheet_rows set cells = jsonb_set(cells, '{A,format}', '{"bold":true}')
            where "tabId" = ${tabId} and "rowIndex" = 0`
      );

      await setCells({ pageId }, [{ address: 'A1', value: '' }], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'A')?.format).toEqual({ bold: true });
      expect(cellAt(rows, 0, 'A')?.raw).toBe('');
    });

    it('keeps fields it does not manage, such as notes', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'v' }], { userId: ownerId });
      await db.execute(
        sql`update sheet_rows set cells = jsonb_set(cells, '{A,notes}', '["a note"]')
            where "tabId" = ${tabId} and "rowIndex" = 0`
      );

      await setCells({ pageId }, [{ address: 'A1', value: 'v2' }], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'A')?.notes).toEqual(['a note']);
    });
  });

  describe('cycles', () => {
    it('flags a cycle rather than storing a plausible value', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'D1', value: '=D2' },
        { address: 'D2', value: '=D1' },
      ], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'D')?.error).toBeTruthy();
    });
  });

  describe('rebuildTab', () => {
    it('removes rows that are no longer in the projection', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'x' }, { address: 'A2', value: 'y' }], { userId: ownerId });
      await setCells({ pageId }, [{ address: 'A2', value: '' }], { userId: ownerId });

      await rebuildTab({ pageId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(rows.find((row) => row.rowIndex === 1)).toBeUndefined();
    });
  });

  describe('readSheetData', () => {
    it('projects back to the shape the exporters and editor speak', async () => {
      const { pageId, ownerId } = await makeSheet({ rowCount: 10, columnCount: 5 });
      await setCells({ pageId }, [
        { address: 'A1', value: 'Name' },
        { address: 'B1', value: '=1+1' },
      ], { userId: ownerId });

      const data = await readSheetData({ pageId });
      expect(data?.cells['A1']).toBe('Name');
      // The formula, not its result — a round trip must not lose it.
      expect(data?.cells['B1']).toBe('=1+1');
      expect(data?.sheetName).toBe('Sheet1');
    });
  });

  describe('cascade', () => {
    it('drops rows with their page', async () => {
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId });

      await db.delete(pages).where(eq(pages.id, pageId));

      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(sheetRows);
      expect(count).toBe(0);
    });
  });
});
