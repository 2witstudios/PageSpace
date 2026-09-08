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
import { describe, it, expect, afterEach } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, and, gt, sql, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { sheetTabs, sheetRows, sheetRangeDeps, sheetChanges } from '@pagespace/db/schema';
import {
  setCells,
  appendRows,
  deleteRows,
  readRows,
  queryRows,
  readSheetData,
  getTab,
  rebuildTab,
  readSheetDocument,
  replaceFromDocument,
  copySheetRows,
  listTabs,
  sheetMatchingRowsByPage,
  applyFormatOps,
  readTabFormatting,
} from '../store';
import { SheetFormatError } from '../format-request';
import type { StoredRow } from '../projection';
import { parseSheetContent, serializeSheetContent } from '../io';
import { sheetCellsMatchIlike, sheetCellsMatchRegex } from '../search-sql';

/**
 * Ids this file created, so cleanup can be row-scoped.
 *
 * Deleting `users`/`drives`/`pages` wholesale would empty the shared test
 * database out from under every other suite in the same CI step. The adjacent
 * `packages/db` integration job is justified in its workflow comment precisely
 * on the grounds that its cleanup does not do that, and `fileParallelism:
 * false` is a scheduling accident, not a guarantee — so this suite tracks what
 * it seeded and removes only that.
 */
const seededUserIds: string[] = [];

/** A sheet page with one tab, sized so appends land where the test expects. */
async function makeSheet(options: { rowCount?: number; columnCount?: number } = {}) {
  const owner = await factories.createUser();
  seededUserIds.push(owner.id);
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

/** A SHEET page with NO tab row — the state every sheet is in before migration. */
async function makeUnmigratedSheet(content: string) {
  const owner = await factories.createUser();
  seededUserIds.push(owner.id);
  const drive = await factories.createDrive(owner.id);
  const page = await factories.createPage(drive.id, {
    type: 'SHEET',
    title: 'Sheet',
    position: 0,
    content,
  });
  return { ownerId: owner.id, pageId: page.id };
}

/** The batched matcher, narrowed to one page — most cases only care about one. */
const matchingRowsFor = async (
  pageId: string,
  match: Parameters<typeof sheetMatchingRowsByPage>[1],
  options?: Parameters<typeof sheetMatchingRowsByPage>[2]
) => (await sheetMatchingRowsByPage([pageId], match, options)).get(pageId) ?? [];

const cellAt = (rows: StoredRow[], rowIndex: number, column: string) =>
  rows.find((row) => row.rowIndex === rowIndex)?.cells[column];


const BOLD = { bold: true };

/** A rule the format tests add; its own constant so the block is self-contained. */
const FORMAT_RULE = {
  id: 'over-100',
  kind: 'cell' as const,
  ranges: ['A1:A9'],
  condition: { operator: 'greaterThan' as const, value: '100' },
  format: { background: '#fee2e2' },
};

const REGION = {
  id: 'orders',
  name: 'Orders',
  range: 'A1:D',
  headerRows: 1,
  columns: [{ column: 'C', role: 'currency' as const, currency: 'USD' }],
};

type StoreExecutor = NonNullable<Parameters<typeof applyFormatOps>[3]>;

/**
 * `exec` with the FIRST call to `method` held until `hook` resolves.
 *
 * Drizzle builders are thenables, so the hold goes in `then`: the query is
 * built as normal and only its execution waits. This is what makes a
 * concurrency test deterministic — the transaction is paused at exactly the
 * statement whose timing matters, and another connection does its work in
 * the gap.
 */
function holdFirst(
  exec: StoreExecutor,
  method: 'insert' | 'update',
  hook: () => Promise<void>
): StoreExecutor {
  let held = false;
  const gate = (query: object): object =>
    new Proxy(query, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            hook().then(() => target).then(resolve, reject);
        }
        if (typeof value === 'function') {
          return (...args: unknown[]) => gate((value as (...inner: unknown[]) => object).apply(target, args));
        }
        return value;
      },
    });

  return new Proxy(exec, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === method && typeof value === 'function' && !held) {
        return (...args: unknown[]) => {
          held = true;
          return gate((value as (...inner: unknown[]) => object).apply(target, args));
        };
      }
      return value;
    },
  }) as StoreExecutor;
}

const holdBeforeInsert = (exec: StoreExecutor, hook: () => Promise<void>) => holdFirst(exec, 'insert', hook);
const holdBeforeUpdate = (exec: StoreExecutor, hook: () => Promise<void>) => holdFirst(exec, 'update', hook);

/**
 * Resolves once ANOTHER connection is waiting on a `sheet_tabs` lock while
 * `pending` is still unsettled — so a test that releases a held transaction
 * after this knows the other writer really was blocked behind it, rather than
 * having quietly finished first and turned the race into a sequence.
 */
async function waitForLockWaiter(pending: Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (settled) throw new Error('The other writer finished before it was seen waiting on the lock');
    const result = await db.execute(
      sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%sheet_tabs%'`
    );
    if (Number((result.rows[0] as { waiting: number }).waiting) > 0) return;
    if (Date.now() > deadline) throw new Error('No transaction ever waited on the sheet_tabs lock');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Counts `UPDATE` statements against one tab row, by trigger. A stored value
 * cannot tell one statement from four; a row-level trigger can.
 */
async function countTabUpdates(tabId: string) {
  const suffix = tabId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const table = `fmt_audit_${suffix}`;
  const fn = `fmt_audit_fn_${suffix}`;
  const trigger = `fmt_audit_trg_${suffix}`;

  await db.execute(sql.raw(`CREATE TABLE ${table} (n serial PRIMARY KEY)`));
  await db.execute(
    sql.raw(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '${tabId}' THEN INSERT INTO ${table} DEFAULT VALUES; END IF;
         RETURN NEW;
       END $$`
    )
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER ${trigger} AFTER UPDATE ON sheet_tabs FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  );

  return {
    count: async () => {
      const result = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      return Number((result.rows[0] as { n: number }).n);
    },
    drop: async () => {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON sheet_tabs`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
    },
  };
}

describe('sheet store (integration)', () => {
  // Row-scoped, and after rather than before: every sheet table cascades from
  // `pages`, which cascades from `drives`, which cascades from `users` — so
  // removing the users this file made removes everything it made, and nothing
  // it did not.
  afterEach(async () => {
    if (seededUserIds.length === 0) return;
    await db.delete(users).where(inArray(users.id, seededUserIds));
    seededUserIds.length = 0;
  });

  describe('conditional formatting survives the store', () => {
    const RULE = {
      id: 'over-100',
      kind: 'cell' as const,
      ranges: ['A1:A9'],
      condition: { operator: 'greaterThan' as const, value: '100' },
      format: { background: '#fee2e2' },
    };

    const documentWithRule = () => {
      const sheet = parseSheetContent('');
      sheet.cells.A1 = '150';
      sheet.conditionalFormats = [RULE];
      return serializeSheetContent(sheet);
    };

    it('carries rules from a document into the tab row and back', async () => {
      // The projection round-trip is unit-tested, but the projection is not
      // what persists: the store builds its own insert column list, and a
      // column missing from it discards the rules with no error anywhere.
      const { pageId } = await makeUnmigratedSheet(documentWithRule());

      await replaceFromDocument({ pageId }, documentWithRule(), { userId: null });

      const [tab] = await db.select().from(sheetTabs).where(eq(sheetTabs.pageId, pageId));
      expect(tab.conditionalFormats).toEqual([RULE]);

      const sheet = await readSheetData({ pageId });
      expect(sheet?.conditionalFormats).toEqual([RULE]);
    });

    it('restores rules already present in the database on read', async () => {
      // The read path builds its own column list too, so a rule can be stored
      // correctly and still never reach a SheetData.
      const { pageId, tabId } = await makeSheet();
      await db.update(sheetTabs).set({ conditionalFormats: [RULE] }).where(eq(sheetTabs.id, tabId));

      expect((await readSheetData({ pageId }))?.conditionalFormats).toEqual([RULE]);
    });

    it('keeps rules through a cell write, which rewrites the tab', async () => {
      const { pageId, tabId } = await makeSheet({ rowCount: 9 });
      await db.update(sheetTabs).set({ conditionalFormats: [RULE] }).where(eq(sheetTabs.id, tabId));

      await setCells({ pageId }, [{ address: 'A1', value: '250' }], { userId: null });

      expect((await readSheetData({ pageId }))?.conditionalFormats).toEqual([RULE]);
    });

    it('copies rules to the destination sheet', async () => {
      const source = await makeUnmigratedSheet(documentWithRule());
      await replaceFromDocument({ pageId: source.pageId }, documentWithRule(), { userId: null });
      const target = await makeSheet();
      // The target's own tab would collide on (pageId, tabIndex), as the
      // existing copy test notes — copy onto a page with no tab of its own.
      await db.delete(sheetTabs).where(eq(sheetTabs.pageId, target.pageId));

      await copySheetRows(source.pageId, target.pageId);

      expect((await readSheetData({ pageId: target.pageId }))?.conditionalFormats).toEqual([RULE]);
    });

    it('leaves a sheet with no rules with none', async () => {
      const { pageId } = await makeSheet({ rowCount: 2 });
      await setCells({ pageId }, [{ address: 'A1', value: '1' }], { userId: null });
      expect((await readSheetData({ pageId }))?.conditionalFormats).toBeUndefined();
    });
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
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'B1', value: '=SUM(A1:A1000)' }], { userId: ownerId });

      // Scoped to this tab: the suite shares a database with other suites, so
      // a bare count over the table would depend on what else is running.
      const ranges = await db.select().from(sheetRangeDeps).where(eq(sheetRangeDeps.tabId, tabId));
      expect(ranges).toHaveLength(1);
      expect(ranges[0].rowStart).toBe(0);
      expect(ranges[0].rowEnd).toBe(999);
    });

    it('drops edges when a formula becomes a literal', async () => {
      const { pageId, tabId, ownerId } = await makeSheet();
      const edges = () =>
        db.select().from(sheetRangeDeps).where(eq(sheetRangeDeps.tabId, tabId));

      await setCells({ pageId }, [{ address: 'B1', value: '=SUM(A1:A10)' }], { userId: ownerId });
      expect(await edges()).toHaveLength(1);

      await setCells({ pageId }, [{ address: 'B1', value: 'plain text' }], { userId: ownerId });
      expect(await edges()).toHaveLength(0);
    });
  });

  describe('lazy provisioning', () => {
    it('materialises an existing document on first write', async () => {
      // Nothing in the product creates a `sheet_tabs` row — only the backfill
      // script did. Without this, every write path threw for a newly created
      // sheet and for any sheet an operator had not backfilled: a public form
      // submission would 500 and the submitted data would be discarded.
      const { pageId, ownerId } = await makeUnmigratedSheet(
        '#%PAGESPACE_SHEETDOC v1\npage_id = "x"\n\n[[sheets]]\nname = "Sheet1"\norder = 0\n\n[sheets.meta]\nrowCount = 5\ncolumnCount = 3\n\n[sheets.cells.A1]\nvalue = "existing"\n'
      );

      await setCells({ pageId }, [{ address: 'B1', value: 'new' }], { userId: ownerId });

      const tab = await getTab({ pageId });
      expect(tab).not.toBeNull();

      const rows = await readRows(tab!.id, { limit: 10 });
      // The write landed AND the document's existing content came with it.
      expect(cellAt(rows, 0, 'B')?.value).toBe('new');
      expect(cellAt(rows, 0, 'A')?.value).toBe('existing');
    });

    it('provisions an empty sheet for a page with no content', async () => {
      const { pageId, ownerId } = await makeUnmigratedSheet('');
      await expect(
        setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId })
      ).resolves.toBeTruthy();
    });

    it('refuses to materialise an unreadable document as an empty sheet', async () => {
      // The dangerous case: presenting "this spreadsheet is blank" as the truth
      // would make the next write destroy it.
      const { pageId, ownerId } = await makeUnmigratedSheet('#%PAGESPACE_SHEETDOC v1\n{{{ not toml');

      await expect(
        setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId })
      ).rejects.toThrow(/could not be read/);

      expect(await getTab({ pageId })).toBeNull();
    });
  });

  describe('concurrent writes', () => {
    it('a row write contributes only its own columns, leaving the rest', async () => {
      // Tests the MECHANISM rather than hoping to win a race.
      //
      // `persistRows` upserts a whole `cells` object. If that object replaces
      // the stored one, a writer holding a stale snapshot erases every column
      // it did not know about — the lost update. Issuing the upsert with a
      // deliberately partial object is what a stale writer looks like, and is
      // deterministic where two concurrent `setCells` calls are not: an earlier
      // version of this test used `Promise.all` and passed even with the fix
      // reverted, because nothing forced the reads to interleave.
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: 'keep-a' },
        { address: 'B1', value: 'keep-b' },
      ], { userId: ownerId });

      // A write that knows only about column C, as a stale writer would.
      await db
        .insert(sheetRows)
        .values({ tabId, pageId, rowIndex: 0, cells: { C: { raw: 'new-c', value: 'new-c' } } })
        .onConflictDoUpdate({
          target: [sheetRows.tabId, sheetRows.rowIndex],
          set: { cells: sql`${sheetRows.cells} || excluded."cells"` },
        });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'C')?.value).toBe('new-c');
      expect(cellAt(rows, 0, 'A')?.value).toBe('keep-a');
      expect(cellAt(rows, 0, 'B')?.value).toBe('keep-b');
    });

    // NOTE: this one is a smoke test, not a race reproduction. Two `setCells`
    // calls in `Promise.all` do not reliably interleave their reads, so it
    // cannot demonstrate the row lock; it only asserts both appends survive.
    it('preserves a column written out-of-band before the call', async () => {
      // HONEST SCOPE: this does NOT prove the read happens under the lock.
      //
      // It cannot: the defect it relates to needs another transaction to commit
      // BETWEEN this call's read and its write, and nothing here can force that
      // interleaving. A mutation reintroducing the read-before-lock shape still
      // passes this test.
      //
      // The lock/read ordering is verified instead by reading Postgres's
      // statement log during a `setCells` (`log_statement=all`) and confirming
      // the `FOR UPDATE` precedes every `sheet_rows` read — see the commit that
      // removed the pre-lock read. What this test does cover is the weaker but
      // still useful property that a foreign column survives a later write.
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'a' }], { userId: ownerId });

      await db
        .update(sheetRows)
        .set({ cells: sql`${sheetRows.cells} || '{"Z":{"raw":"concurrent","value":"concurrent"}}'::jsonb` })
        .where(and(eq(sheetRows.tabId, tabId), eq(sheetRows.rowIndex, 0)));

      await setCells({ pageId }, [{ address: 'B1', value: 'b' }], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'B')?.value).toBe('b');
      expect(cellAt(rows, 0, 'A')?.value).toBe('a');
      expect(cellAt(rows, 0, 'Z')?.value).toBe('concurrent');
    });

    it('lands both rows when two appends run together', async () => {
      const { pageId, ownerId } = await makeSheet();
      const tab = (await getTab({ pageId }))!;

      await Promise.all([
        appendRows({ pageId }, [{ A: 'first' }], { userId: ownerId }),
        appendRows({ pageId }, [{ A: 'second' }], { userId: ownerId }),
      ]);

      const rows = await readRows(tab.id, { limit: 20 });
      const values = rows.map((row) => row.cells.A?.value).filter(Boolean).sort();
      expect(values).toEqual(['first', 'second']);
    });
  });

  describe('wide range formulas', () => {
    it('edits an input of a range far wider than the bind-parameter ceiling', async () => {
      // Postgres refuses a statement with more than 65535 bind parameters. An
      // earlier version expanded each dependency rectangle into one row index
      // per row and handed the lot to `IN (...)`, so a `SUM` over 100k rows
      // made every edit to its inputs die with an opaque 08P01 — on precisely
      // the sheet size this storage model exists to support. Ranges now reach
      // SQL as bounds, costing two parameters however wide they are.
      const { pageId, tabId, ownerId } = await makeSheet();

      await appendRows(
        { pageId },
        Array.from({ length: 200 }, (_, index) => ({ A: String(index + 1) })),
        { userId: ownerId }
      );
      // A range far past both the row count and the parameter ceiling.
      await setCells({ pageId }, [{ address: 'C1', value: '=SUM(A1:A100000)' }], { userId: ownerId });

      await expect(
        setCells({ pageId }, [{ address: 'A1', value: '1000' }], { userId: ownerId })
      ).resolves.toBeTruthy();

      const rows = await readRows(tabId, { limit: 300 });
      // 2..200 sum to 20099, plus the edited 1000.
      expect(cellAt(rows, 0, 'C')?.value).toBe(21099);
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
        .from(sheetChanges)
        .where(eq(sheetChanges.pageId, pageId));
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

  describe('document projection', () => {
    it('round-trips a sheet through the document form', async () => {
      // The bridge that lets the editor, exports and the publisher keep
      // speaking the document format while rows hold the truth.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10, columnCount: 4 });
      await setCells({ pageId }, [
        { address: 'A1', value: 'Name' },
        { address: 'B1', value: '10' },
        { address: 'C1', value: '=B1*2' },
      ], { userId: ownerId });

      const document = await readSheetDocument(pageId);
      expect(document).toContain('#%PAGESPACE_SHEETDOC');

      // Feed it back: the sheet must be unchanged.
      await replaceFromDocument({ pageId }, document!, { userId: ownerId });

      const data = await readSheetData({ pageId });
      expect(data?.cells['A1']).toBe('Name');
      expect(data?.cells['C1']).toBe('=B1*2');
    });

    it('a document write removes cells the document no longer has', async () => {
      // The editor sends a COMPLETE statement of the tab, so a cell absent from
      // it has been deleted — merging would resurrect it.
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: 'keep' },
        { address: 'B1', value: 'remove me' },
      ], { userId: ownerId });

      const document = await readSheetDocument(pageId);
      await setCells({ pageId }, [{ address: 'B1', value: '' }], { userId: ownerId });
      const withoutB = await readSheetDocument(pageId);
      void document;

      await replaceFromDocument({ pageId }, withoutB!, { userId: ownerId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'A')?.value).toBe('keep');
      expect(cellAt(rows, 0, 'B')?.value ?? '').toBe('');
    });

    it('returns null for a page with no rows, so callers can fall back', async () => {
      const { pageId } = await makeUnmigratedSheet('');
      expect(await readSheetDocument(pageId)).toBeNull();
    });
  });

  describe('multi-tab documents', () => {
    const TWO_TABS =
      '#%PAGESPACE_SHEETDOC v1\npage_id = "x"\n\n' +
      '[[sheets]]\nname = "First"\norder = 0\n\n[sheets.meta]\nrowCount = 5\ncolumnCount = 3\n\n[sheets.cells.A1]\nvalue = "one"\n\n' +
      '[[sheets]]\nname = "Second"\norder = 1\n\n[sheets.meta]\nrowCount = 5\ncolumnCount = 3\n\n[sheets.cells.A1]\nvalue = "two"\n';

    it('a document save keeps every tab, not just the first', async () => {
      // `replaceFromDocument` is the single path for every editor save. Writing
      // only tab 0 silently discarded edits to the others — and for tabs that
      // existed only in the document, deleted them outright.
      const { pageId, ownerId } = await makeUnmigratedSheet(TWO_TABS);

      await replaceFromDocument({ pageId }, TWO_TABS, { userId: ownerId });

      const tabs = await listTabs(pageId);
      expect(tabs).toHaveLength(2);
      expect(tabs.map((tab) => tab.name)).toEqual(['First', 'Second']);

      const second = await readSheetData({ pageId, tabIndex: 1 });
      expect(second?.cells['A1']).toBe('two');
    });

    it('projects every tab back into the document', async () => {
      const { pageId, ownerId } = await makeUnmigratedSheet(TWO_TABS);
      await setCells({ pageId }, [{ address: 'B1', value: 'edited' }], { userId: ownerId });

      const document = await readSheetDocument(pageId);
      expect(document).toContain('First');
      expect(document).toContain('Second');
      expect(document).toContain('two');
    });
  });

  describe('tab metadata survives a document save', () => {
    it('persists name, freezes, widths and formats — not just the extent', async () => {
      // `replaceFromDocument` is the path every editor save takes. Writing only
      // rowCount/columnCount meant renaming a sheet, freezing panes, resizing a
      // column or setting a column format appeared to work and then reverted on
      // reload.
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId });

      const document = (await readSheetDocument(pageId))!;
      const parsed = parseSheetContent(document);
      const edited = serializeSheetContent(
        {
          ...parsed,
          sheetName: 'Renamed',
          frozenRows: 2,
          columnWidths: { A: 240 },
          columnFormats: { B: { bold: true } },
        },
        { pageId }
      );

      await replaceFromDocument({ pageId }, edited, { userId: ownerId });

      const tab = (await getTab({ pageId }))!;
      expect(tab.name).toBe('Renamed');
      expect(tab.frozenRows).toBe(2);
      expect(tab.columnWidths).toEqual({ A: 240 });
      expect(tab.columnFormats).toEqual({ B: { bold: true } });
    });
  });

  describe('copySheetRows', () => {
    it('clones tabs and rows onto another page', async () => {
      // Copying a page copies `pages.content`, which is empty for a
      // materialised sheet — so a duplicated spreadsheet came out blank.
      const source = await makeSheet();
      await setCells({ pageId: source.pageId }, [
        { address: 'A1', value: 'original' },
        { address: 'B1', value: '=1+1' },
      ], { userId: source.ownerId });

      const target = await makeSheet();
      // The target's own tab would collide, so copy onto a fresh page.
      await db.delete(sheetTabs).where(eq(sheetTabs.pageId, target.pageId));

      await copySheetRows(source.pageId, target.pageId);

      const copied = await readSheetData({ pageId: target.pageId });
      expect(copied?.cells['A1']).toBe('original');
      expect(copied?.cells['B1']).toBe('=1+1');
    });
  });

  describe('page revision', () => {
    it('bumps on a row write, so an open editor sees a conflict', async () => {
      // The editor holds an `expectedRevision`. A row write that leaves it
      // alone is invisible to that guard, and the editor's next save then
      // deletes every row absent from its stale document.
      const { pageId, ownerId } = await makeSheet();

      const before = await db
        .select({ revision: pages.revision })
        .from(pages)
        .where(eq(pages.id, pageId));

      await setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId });

      const after = await db
        .select({ revision: pages.revision })
        .from(pages)
        .where(eq(pages.id, pageId));

      expect(after[0].revision).toBeGreaterThan(before[0].revision);
    });
  });

  describe('appendRows placement', () => {
    it('appends after the last populated row, not the declared extent', async () => {
      // A default sheet declares 20 empty rows; appending past the extent
      // dropped the rows into row 21 of a three-row table.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 20 });
      await setCells({ pageId }, [
        { address: 'A1', value: 'r0' },
        { address: 'A2', value: 'r1' },
      ], { userId: ownerId });

      const result = await appendRows({ pageId }, [{ A: 'r2' }], { userId: ownerId });

      expect(result.firstRowIndex).toBe(2);
      const rows = await readRows(tabId, { limit: 30 });
      expect(cellAt(rows, 2, 'A')?.value).toBe('r2');
    });
  });

  describe('incremental recompute agrees with a full pass', () => {
    // Cells outside the recompute set enter evaluation as their stringified
    // stored value. That could in principle be re-coerced into something else —
    // a numeric-looking string becoming a number, a boolean becoming text — so
    // these pin the cases where it would show. They all agree today; the tests
    // exist so a change to the engine's coercion cannot quietly break the
    // premise that an incremental write and a full evaluation produce the same
    // sheet.
    it.each([
      ['numeric-looking string through concatenation', '="7"', '=A1&"x"', '7x'],
      ['numeric-looking string through arithmetic', '="7"', '=SUM(A1,1)', 8],
      ['boolean through IF', '=1=1', '=IF(A1,"yes","no")', 'yes'],
      ['boolean through concatenation', '=1=1', '=A1&"y"', 'truey'],
    ])('%s', async (_name, seed, dependent, expected) => {
      const { pageId, tabId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: seed },
        { address: 'B1', value: dependent },
      ], { userId: ownerId });

      // Recompute B1 with A1 frozen: touch a cell B1 does not read, then edit
      // B1 itself so it is in the closure while A1 is not.
      await setCells({ pageId }, [{ address: 'B1', value: dependent }], { userId: ownerId });

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 0, 'B')?.value).toBe(expected);
    });
  });

  describe('a sheet is findable by its contents', () => {
    it('matches cell text through the shared search predicate', async () => {
      // `pages.content` is empty for a materialised sheet, so a search that
      // filters on that column alone stops finding spreadsheets entirely —
      // the pages most likely to hold the string somebody typed.
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [
        { address: 'A1', value: 'Quarterly Revenue' },
        { address: 'B1', value: '=1+1' },
      ], { userId: ownerId });

      const found = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, pageId), sheetCellsMatchIlike('%quarterly%')));
      expect(found).toHaveLength(1);

      const missed = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, pageId), sheetCellsMatchIlike('%nowhere%')));
      expect(missed).toHaveLength(0);
    });

    it('anchors work, because matching is per cell and not over raw JSON', async () => {
      // Over `cells::text` the whole row is one string, so `^Total` could never
      // match and any pattern containing a quote missed on JSON escaping.
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'C3', value: 'Total' }], { userId: ownerId });

      const anchored = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, pageId), sheetCellsMatchRegex('^Total$')));
      expect(anchored).toHaveLength(1);

      // A structural JSON key must NOT match.
      const structural = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, pageId), sheetCellsMatchRegex('^raw$')));
      expect(structural).toHaveLength(0);
    });

    it('quotes the row that matched, however deep in the sheet it is', async () => {
      // The excerpt used to come from a preview of the first N rows, so a
      // search reported a spreadsheet as a hit with no matching lines and a
      // match count of zero whenever the hit was past that bound.
      const { pageId, ownerId } = await makeSheet({ rowCount: 5000 });
      await setCells(
        { pageId },
        [
          { address: 'A1', value: 'header' },
          { address: 'B4000', value: 'needle' },
          { address: 'C4000', value: 'beside it' },
        ],
        { userId: ownerId }
      );

      const matched = await matchingRowsFor(pageId, { ilike: '%needle%' });

      expect(matched).toHaveLength(1);
      expect(matched[0].rowIndex).toBe(3999);
      expect(matched[0].text).toContain('needle');
      // The whole row is quoted, not just the matching cell.
      expect(matched[0].text).toContain('beside it');
    });

    it('finds a row by any of several patterns, and returns rows in order', async () => {
      const { pageId, ownerId } = await makeSheet({ rowCount: 100 });
      await setCells(
        { pageId },
        [
          { address: 'A10', value: 'alpha' },
          { address: 'A20', value: 'beta' },
          { address: 'A30', value: 'gamma' },
        ],
        { userId: ownerId }
      );

      const matched = await matchingRowsFor(pageId, { ilike: ['%alpha%', '%beta%'] });

      expect(matched.map((row) => row.rowIndex)).toEqual([9, 19]);
    });

    it('matches the computed value of a formula, not its authored text', async () => {
      // The same reason `query-rows` filters on `value`: a search for the
      // number a user can see must find the cell showing it.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells(
        { pageId },
        [
          { address: 'A1', value: '40' },
          { address: 'A2', value: '2' },
          { address: 'A3', value: '=A1+A2' },
        ],
        { userId: ownerId }
      );

      const matched = await matchingRowsFor(pageId, { ilike: '%42%' });

      expect(matched.map((row) => row.rowIndex)).toEqual([2]);
    });

    it('honours the row limit', async () => {
      const { pageId, ownerId } = await makeSheet({ rowCount: 20 });
      await setCells(
        { pageId },
        Array.from({ length: 10 }, (_, index) => ({
          address: `A${index + 1}`,
          value: 'repeated',
        })),
        { userId: ownerId }
      );

      const matched = await matchingRowsFor(pageId, { ilike: '%repeated%' }, { limit: 3 });

      expect(matched).toHaveLength(3);
      expect(matched.map((row) => row.rowIndex)).toEqual([0, 1, 2]);
    });
  });

  describe('a formula added after its input already exists', () => {
    it('is recomputed by later writes to that input', async () => {
      // Sequential on purpose. A concurrent CROSS-ROW version of this — the
      // formula created by another transaction mid-write — is a real gap, and
      // it is documented in `setCells` rather than tested here: the closure is
      // resolved before the locks because the locks are derived from it, and
      // closing that would mean taking row locks out of order, trading a rare
      // stale value for a real deadlock.
      //
      // Deliberately NOT a `Promise.all` race test. One was written here and
      // deleted: it passed with `lockRows` removed entirely, so it asserted
      // nothing about the locking it was named for.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells({ pageId }, [{ address: 'A1', value: '5' }], { userId: ownerId });
      await setCells({ pageId }, [{ address: 'B5', value: '=A1*2' }], { userId: ownerId });

      await setCells({ pageId }, [{ address: 'A1', value: '50' }], { userId: ownerId });

      const rows = await readRows((await listTabs(pageId))[0].id, {});
      expect(cellAt(rows, 4, 'B')?.value).toBe(100);
    });
  });

  describe('batched matching rows', () => {
    it('applies the row cap PER PAGE, so one big sheet cannot crowd out the others', async () => {
      // The whole point of the window function. A plain LIMIT over the joined
      // result would spend the entire budget on whichever page sorted first
      // and return no excerpt at all for the rest.
      const a = await makeSheet({ rowCount: 50 });
      const b = await makeSheet({ rowCount: 50 });
      await setCells(
        { pageId: a.pageId },
        Array.from({ length: 10 }, (_, i) => ({ address: `A${i + 1}`, value: 'needle' })),
        { userId: a.ownerId }
      );
      await setCells(
        { pageId: b.pageId },
        [{ address: 'A40', value: 'needle' }],
        { userId: b.ownerId }
      );

      const byPage = await sheetMatchingRowsByPage(
        [a.pageId, b.pageId],
        { ilike: '%needle%' },
        { limit: 3 }
      );

      expect(byPage.get(a.pageId)).toHaveLength(3);
      expect(byPage.get(b.pageId)).toHaveLength(1);
      expect(byPage.get(b.pageId)![0].rowIndex).toBe(39);
    });

    it('omits a page with no match rather than returning it empty', async () => {
      const a = await makeSheet({ rowCount: 10 });
      const b = await makeSheet({ rowCount: 10 });
      await setCells({ pageId: a.pageId }, [{ address: 'A1', value: 'needle' }], { userId: a.ownerId });
      await setCells({ pageId: b.pageId }, [{ address: 'A1', value: 'other' }], { userId: b.ownerId });

      const byPage = await sheetMatchingRowsByPage([a.pageId, b.pageId], { ilike: '%needle%' });

      expect(byPage.has(a.pageId)).toBe(true);
      expect(byPage.has(b.pageId)).toBe(false);
    });

    it('never reads a page it was not asked about', async () => {
      // The caller filters to pages the viewer may see, so leaking a row from
      // an unlisted page would be a permission bug, not just wasted work.
      const a = await makeSheet({ rowCount: 10 });
      const b = await makeSheet({ rowCount: 10 });
      await setCells({ pageId: a.pageId }, [{ address: 'A1', value: 'needle' }], { userId: a.ownerId });
      await setCells({ pageId: b.pageId }, [{ address: 'A1', value: 'needle' }], { userId: b.ownerId });

      const byPage = await sheetMatchingRowsByPage([b.pageId], { ilike: '%needle%' });

      expect([...byPage.keys()]).toEqual([b.pageId]);
    });

    it('returns nothing for an empty page list without touching the database', async () => {
      expect(await sheetMatchingRowsByPage([], { ilike: '%x%' })).toEqual(new Map());
    });
  });

  describe('ordering', () => {
    it('orders a number column numerically, not lexicographically', async () => {
      // 290.5 / 28 / 250 is the exact case that exposed this: as text it sorts
      // 290.5 > 28 > 250, which reads like a plausible descending result and is
      // not one. `orderBy` is how an agent asks for "the top N rows", so a
      // wrong order here is silently wrong analysis.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells(
        { pageId },
        [
          { address: 'A1', value: '28' },
          { address: 'A2', value: '250' },
          { address: 'A3', value: '290.5' },
          { address: 'A4', value: '7' },
        ],
        { userId: ownerId }
      );

      const desc = await queryRows({ pageId }, { orderBy: [{ column: 'A', direction: 'desc' }] });
      expect(desc.rows.map((row) => row.cells.A.value)).toEqual([290.5, 250, 28, 7]);

      const asc = await queryRows({ pageId }, { orderBy: [{ column: 'A', direction: 'asc' }] });
      expect(asc.rows.map((row) => row.cells.A.value)).toEqual([7, 28, 250, 290.5]);
    });

    it('orders a text column lexicographically', async () => {
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells(
        { pageId },
        [
          { address: 'A1', value: 'cherry' },
          { address: 'A2', value: 'apple' },
          { address: 'A3', value: 'banana' },
        ],
        { userId: ownerId }
      );

      const asc = await queryRows({ pageId }, { orderBy: [{ column: 'A', direction: 'asc' }] });
      expect(asc.rows.map((row) => row.cells.A.value)).toEqual(['apple', 'banana', 'cherry']);
    });

    it('groups numbers away from text in a mixed column rather than interleaving them', async () => {
      // Numbers first ascending, then text — the numeric key is NULL for text
      // and NULLS LAST applies in both directions.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells(
        { pageId },
        [
          { address: 'A1', value: 'pending' },
          { address: 'A2', value: '30' },
          { address: 'A3', value: '4' },
          { address: 'A4', value: 'n/a' },
        ],
        { userId: ownerId }
      );

      const asc = await queryRows({ pageId }, { orderBy: [{ column: 'A', direction: 'asc' }] });
      expect(asc.rows.map((row) => row.cells.A.value)).toEqual([4, 30, 'n/a', 'pending']);
    });

    it('orders on the computed value of a formula', async () => {
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells(
        { pageId },
        [
          { address: 'A1', value: '2' },
          { address: 'B1', value: '=A1*100' },
          { address: 'A2', value: '3' },
          { address: 'B2', value: '=A2*3' },
        ],
        { userId: ownerId }
      );

      const desc = await queryRows({ pageId }, { orderBy: [{ column: 'B', direction: 'desc' }] });
      expect(desc.rows.map((row) => row.cells.B.value)).toEqual([200, 9]);
    });
  });

  describe('cascade', () => {
    it('drops rows with their page', async () => {
      const { pageId, ownerId } = await makeSheet();
      await setCells({ pageId }, [{ address: 'A1', value: 'x' }], { userId: ownerId });

      await db.delete(pages).where(eq(pages.id, pageId));

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sheetRows)
        .where(eq(sheetRows.pageId, pageId));
      expect(count).toBe(0);
    });
  });

  describe('applyFormatOps', () => {

    /** Rows 0..count-1, each with one cell, inserted directly and back-dated. */
    async function seedRows(tabId: string, pageId: string, count: number) {
      const stale = new Date(Date.now() - 60_000);
      const CHUNK = 500;
      for (let start = 0; start < count; start += CHUNK) {
        const values = [];
        for (let rowIndex = start; rowIndex < Math.min(count, start + CHUNK); rowIndex++) {
          values.push({
            tabId,
            pageId,
            rowIndex,
            cells: { A: { raw: String(rowIndex), value: rowIndex, type: 'number' as const } },
            updatedAt: stale,
          });
        }
        await db.insert(sheetRows).values(values);
      }
    }

    /** How many of a tab's rows were written since `marker`. */
    const rowsWrittenSince = async (tabId: string, marker: Date) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sheetRows)
        .where(and(eq(sheetRows.tabId, tabId), gt(sheetRows.updatedAt, marker)));
      return count;
    };

    const revisionOf = async (pageId: string) => {
      const [row] = await db
        .select({ revision: pages.revision, stateHash: pages.stateHash })
        .from(pages)
        .where(eq(pages.id, pageId));
      return row;
    };

    it('formats one row of a 50,000-row sheet by writing one row', { timeout: 30_000 }, async () => {
      // Kills: selecting or persisting rows by anything other than the plan's
      // row indexes. "A1 is bold" afterwards is identical under a whole-sheet
      // rewrite, so the assertion is on the MECHANISM — the reported count and
      // the number of rows whose `updatedAt` moved.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 50_000 });
      await seedRows(tabId, pageId, 50_000);
      const marker = new Date();

      const result = await applyFormatOps(
        { pageId },
        [{ type: 'setCellFormat', range: 'A1:H1', patch: BOLD }],
        { userId: ownerId }
      );

      expect(result.rowsTouched).toBe(1);
      expect(result.cellsFormatted).toBe(8);
      expect(await rowsWrittenSince(tabId, marker)).toBe(1);

      const rows = await readRows(tabId, { limit: 2 });
      expect(cellAt(rows, 0, 'A')?.format).toEqual(BOLD);
      expect(cellAt(rows, 0, 'H')?.format).toEqual(BOLD);
      // The value the row already held survives beside the new format.
      expect(cellAt(rows, 0, 'A')?.value).toBe(0);
    });

    it('formats C2:C5001 by writing exactly those 5,000 rows', async () => {
      // Kills: a span read that over-reaches (rows 5002+ untouched) and a
      // per-row write that misses part of a chunked range.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 6_000 });
      await seedRows(tabId, pageId, 6_000);
      const marker = new Date();

      const result = await applyFormatOps(
        { pageId },
        [{ type: 'setCellFormat', range: 'C2:C5001', patch: { italic: true } }],
        { userId: ownerId }
      );

      expect(result.rowsTouched).toBe(5_000);
      expect(await rowsWrittenSince(tabId, marker)).toBe(5_000);

      const [{ untouched }] = await db
        .select({ untouched: sql<number>`count(*)::int` })
        .from(sheetRows)
        .where(
          and(
            eq(sheetRows.tabId, tabId),
            sql`${sheetRows.rowIndex} >= 5001`,
            gt(sheetRows.updatedAt, marker)
          )
        );
      expect(untouched).toBe(0);
    });

    it('keeps a concurrent value write to the same row, as a real transaction pair', async () => {
      // Kills: `persistRows` in replace mode, or any write that upserts a
      // whole `cells` object rather than the columns this call touched.
      //
      // The interleaving that loses the update: the row does not exist yet,
      // so there is no row lock to take; the format write reads nothing, a
      // `setCells` to column A of the same row commits, and then the format
      // write upserts column C. Sequentially those two calls prove nothing —
      // the second reads the first's row. So the format write runs inside an
      // open transaction whose first `sheet_rows` insert is held back until
      // the value write has committed on another connection.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });

      let valueWrite: Promise<unknown> | null = null;
      const gated = await db.transaction(async (tx) =>
        applyFormatOps(
          { pageId },
          [{ type: 'setCellFormat', range: 'C5', patch: BOLD }],
          { userId: ownerId },
          holdBeforeInsert(tx, async () => {
            valueWrite ??= setCells({ pageId }, [{ address: 'A5', value: 'kept' }], { userId: ownerId });
            await valueWrite;
          })
        )
      );
      expect(gated.rowsTouched).toBe(1);
      await valueWrite;

      const rows = await readRows(tabId, { limit: 10 });
      expect(cellAt(rows, 4, 'A')?.value).toBe('kept');
      expect(cellAt(rows, 4, 'C')?.format).toEqual(BOLD);
    });

    it('composes a value write and a format write to the SAME empty cell in either order', async () => {
      // Kills: a column-level merge. An empty cell has no row to lock, so a
      // value write and a format write to it can both read nothing and both
      // upsert; if the cell object under the column is replaced whole, the
      // second commit either drops the format or overwrites the just-entered
      // value with `raw: ''`. Both orders are forced, the same way as above.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });

      // Format commits second.
      let value: Promise<unknown> | null = null;
      await db.transaction(async (tx) =>
        applyFormatOps(
          { pageId },
          [{ type: 'setCellFormat', range: 'C5', patch: BOLD }],
          { userId: ownerId },
          holdBeforeInsert(tx, async () => {
            value ??= setCells({ pageId }, [{ address: 'C5', value: '=1+1' }], { userId: ownerId });
            await value;
          })
        )
      );
      await value;
      let cell = cellAt(await readRows(tabId, { limit: 10 }), 4, 'C');
      expect(cell).toMatchObject({ raw: '=1+1', value: 2, type: 'number', format: BOLD });

      // Value commits second — `setCells`'s own merge must leave the format.
      // A different row: row 5 now exists, so a write to it would take its
      // lock and the held transaction would block the one it is waiting for.
      let format: Promise<unknown> | null = null;
      await db.transaction(async (tx) =>
        setCells(
          { pageId },
          [{ address: 'D7', value: 'typed' }],
          { userId: ownerId },
          holdBeforeInsert(tx, async () => {
            format ??= applyFormatOps({ pageId }, [{ type: 'setCellFormat', range: 'D7', patch: { italic: true } }], { userId: ownerId });
            await format;
          })
        )
      );
      await format;
      cell = cellAt(await readRows(tabId, { limit: 10 }), 6, 'D');
      expect(cell).toMatchObject({ raw: 'typed', value: 'typed', format: { italic: true } });
    });

    it('does not bump the revision or log when a request changes nothing', async () => {
      // Kills: an unconditional `touchPage`. A retried or redundant request —
      // the width a column already has, a bold that is already bold — is not
      // an edit, and bumping for it forces an open editor into a conflict over
      // a sheet that did not move.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });
      const ops = [
        { type: 'setCellFormat' as const, range: 'A1:B2', patch: BOLD },
        { type: 'setColumnWidth' as const, column: 'B', width: 240 },
      ];
      await applyFormatOps({ pageId }, ops, { userId: ownerId });
      const before = await revisionOf(pageId);
      const logged = (await db.select({ id: sheetChanges.id }).from(sheetChanges).where(eq(sheetChanges.tabId, tabId))).length;

      const again = await applyFormatOps({ pageId }, ops, { userId: ownerId });

      expect(again.rowsTouched).toBe(0);
      expect(again.cellsFormatted).toBe(0);
      expect(again.tabFieldsChanged).toEqual([]);
      expect(await revisionOf(pageId)).toEqual(before);
      expect((await db.select({ id: sheetChanges.id }).from(sheetChanges).where(eq(sheetChanges.tabId, tabId))).length).toBe(logged);
    });

    it('leaves a formula cell’s raw, value and type untouched', async () => {
      // Kills: fabricating a `StoredCell` instead of spreading the loaded one.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });
      await setCells({ pageId }, [
        { address: 'B1', value: '1' },
        { address: 'B2', value: '2' },
        { address: 'B3', value: '3' },
        { address: 'A1', value: '=SUM(B1:B9)' },
      ], { userId: ownerId });

      await applyFormatOps(
        { pageId },
        [{ type: 'setCellFormat', range: 'A1', patch: { number: { kind: 'currency', currency: 'USD' } } }],
        { userId: ownerId }
      );

      const cell = cellAt(await readRows(tabId, { limit: 1 }), 0, 'A');
      expect(cell?.raw).toBe('=SUM(B1:B9)');
      expect(cell?.value).toBe(6);
      expect(cell?.type).toBe('number');
      expect(cell?.format).toEqual({ number: { kind: 'currency', currency: 'USD' } });
    });

    it('formats an empty cell so it projects as a format and not as a cell', async () => {
      // Kills: writing an empty cell with any `raw` other than '', which the
      // projection would then surface as content.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });

      await applyFormatOps(
        { pageId },
        [{ type: 'setCellFormat', range: 'D9', patch: { background: '#fee2e2' } }],
        { userId: ownerId }
      );

      const sheet = (await readSheetData({ pageId }))!;
      expect(sheet.formats?.D9).toEqual({ background: '#fee2e2' });
      expect(sheet.cells.D9).toBeUndefined();
    });

    it('clears a format into a tombstone the projection ignores', async () => {
      // Documents, rather than fixes, the `{ raw: '' }` left behind: the jsonb
      // merge cannot delete a key, and the alternative is the lost update the
      // merge exists to prevent.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });
      await applyFormatOps({ pageId }, [{ type: 'setCellFormat', range: 'D9', patch: BOLD }], { userId: ownerId });

      const cleared = await applyFormatOps(
        { pageId },
        [{ type: 'clearCellFormat', range: 'D9' }],
        { userId: ownerId }
      );
      expect(cleared.cellsFormatted).toBe(1);

      expect(cellAt(await readRows(tabId, { fromRow: 8, limit: 1 }), 8, 'D')).toEqual({ raw: '' });
      const sheet = (await readSheetData({ pageId }))!;
      expect(sheet.formats?.D9).toBeUndefined();
      expect(sheet.cells.D9).toBeUndefined();

      // Clearing a cell that never existed writes nothing at all.
      const noop = await applyFormatOps({ pageId }, [{ type: 'clearCellFormat', range: 'E9' }], { userId: ownerId });
      expect(noop.rowsTouched).toBe(0);
    });

    it('writes every tab-level change of one call in one UPDATE and one revision bump', async () => {
      // Kills: a per-op `UPDATE sheet_tabs`, and a per-op `touchPage`. An
      // editor holding the sheet open sees one conflict per revision bump, so
      // N bumps for one request is N conflicts. The count is taken by a
      // trigger: a stored value cannot distinguish one statement from four.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 20, columnCount: 6 });
      const audit = await countTabUpdates(tabId);
      const before = await revisionOf(pageId);

      try {
        const result = await applyFormatOps(
          { pageId },
          [
            { type: 'setColumnWidth', column: 'B', width: 240 },
            { type: 'setFrozen', rows: 1, columns: null },
            { type: 'addConditionalRule', rule: FORMAT_RULE },
            { type: 'setRegions', regions: [REGION] },
          ],
          { userId: ownerId }
        );

        expect(result.tabFieldsChanged.sort()).toEqual(
          ['columnWidths', 'conditionalFormats', 'frozenRows', 'regions'].sort()
        );
        expect(await audit.count()).toBe(1);
      } finally {
        await audit.drop();
      }

      const after = await revisionOf(pageId);
      expect(after.revision).toBe(before.revision + 1);

      const tab = (await getTab({ pageId }))!;
      expect(tab.columnWidths).toEqual({ B: 240 });
      expect(tab.frozenRows).toBe(1);
      expect(tab.conditionalFormats).toEqual([FORMAT_RULE]);
      expect(tab.regions).toEqual([REGION]);
    });

    it('bumps the page revision and stateHash — the silent-revert guard', async () => {
      // Kills: a missing `touchPage`. Without it `replaceFromDocument` from a
      // stale editor passes its revision check and rewrites every tab-level
      // field from the old document, reverting the formatting.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      const before = await revisionOf(pageId);

      await applyFormatOps({ pageId }, [{ type: 'setCellFormat', range: 'A1', patch: BOLD }], { userId: ownerId });

      const after = await revisionOf(pageId);
      expect(after.revision).toBe(before.revision + 1);
      expect(after.stateHash).not.toBe(before.stateHash);
    });

    it('refuses before writing anything, so a bad op bumps nothing', async () => {
      // Kills: validating after a lock or a write. The plan throws first.
      const { pageId, ownerId } = await makeSheet({ rowCount: 10 });
      const before = await revisionOf(pageId);

      await expect(
        applyFormatOps(
          { pageId },
          [
            { type: 'setCellFormat', range: 'A1', patch: BOLD },
            { type: 'removeConditionalRule', id: 'missing' },
          ],
          { userId: ownerId }
        )
      ).rejects.toBeInstanceOf(SheetFormatError);

      expect((await revisionOf(pageId)).revision).toBe(before.revision);
      expect((await readSheetData({ pageId }))?.formats).toBeUndefined();
    });

    it('materialises an unmigrated sheet with the document’s rows intact', async () => {
      // Kills: `getTab` where `ensureTab` belongs — the write would throw for
      // every sheet nobody had backfilled — and a materialisation that loses
      // the document's content.
      const { pageId, ownerId } = await makeUnmigratedSheet(
        '#%PAGESPACE_SHEETDOC v1\npage_id = "x"\n\n[[sheets]]\nname = "Sheet1"\norder = 0\n\n[sheets.meta]\nrowCount = 5\ncolumnCount = 3\n\n[sheets.cells.A1]\nvalue = "existing"\n'
      );

      await applyFormatOps({ pageId }, [{ type: 'setCellFormat', range: 'B1', patch: BOLD }], { userId: ownerId });

      const tab = await getTab({ pageId });
      expect(tab).not.toBeNull();
      const rows = await readRows(tab!.id, { limit: 10 });
      expect(cellAt(rows, 0, 'A')?.value).toBe('existing');
      expect(cellAt(rows, 0, 'B')?.format).toEqual(BOLD);
    });

    it('lands both rules when two calls add different ones concurrently', async () => {
      // Kills: skipping the tab `FOR UPDATE`, and taking it but writing the
      // rule list planned BEFORE it — either way the second writer overwrites
      // the first's rule with a list that never had it.
      //
      // Deterministic rather than a `Promise.all` race: the first call is
      // held just before its `UPDATE sheet_tabs`, with the tab lock already
      // taken, until the second call is observed waiting on that lock.
      const { pageId, ownerId } = await makeSheet({ rowCount: 20 });
      // A different RANGE, not just a different id: the store refuses a rule
      // whose content matches one already on the tab (SheetDuplicateRuleError,
      // keyed by everything but `id`), and this case is about the lock, not
      // the dedup — two distinct rules must both land.
      const second = { ...FORMAT_RULE, id: 'second', ranges: ['B1:B9'] };

      let other: Promise<unknown> | null = null;
      await db.transaction(async (tx) =>
        applyFormatOps(
          { pageId },
          [{ type: 'addConditionalRule', rule: FORMAT_RULE }],
          { userId: ownerId },
          holdBeforeUpdate(tx, async () => {
            other ??= applyFormatOps({ pageId }, [{ type: 'addConditionalRule', rule: second }], { userId: ownerId });
            await waitForLockWaiter(other);
          })
        )
      );
      await other;

      const tab = (await getTab({ pageId }))!;
      expect((tab.conditionalFormats as { id: string }[]).map((rule) => rule.id).sort()).toEqual(
        ['over-100', 'second']
      );
    });

    it('refuses under the lock when a concurrent call took the rule id first', async () => {
      // Kills: writing the pre-lock plan (which would silently overwrite the
      // first rule with a same-id twin) and any re-plan that does not refuse.
      // The second call passes validation on its snapshot, waits on the tab
      // lock, and is refused by the plan it makes once it holds it.
      const { pageId, ownerId } = await makeSheet({ rowCount: 20 });

      let other: Promise<unknown> | null = null;
      await db.transaction(async (tx) =>
        applyFormatOps(
          { pageId },
          [{ type: 'addConditionalRule', rule: FORMAT_RULE }],
          { userId: ownerId },
          holdBeforeUpdate(tx, async () => {
            other ??= applyFormatOps(
              { pageId },
              [{ type: 'addConditionalRule', rule: { ...FORMAT_RULE, format: { bold: true } } }],
              { userId: ownerId }
            );
            await waitForLockWaiter(other);
          })
        )
      );

      await expect(other).rejects.toBeInstanceOf(SheetFormatError);
      expect((await getTab({ pageId }))?.conditionalFormats).toEqual([FORMAT_RULE]);
    });

    it('treats a set that is cleared again in the same request as no change', async () => {
      // Kills: staging patches per step rather than from the net change —
      // which would create a tombstone row, bump the revision and log an
      // entry whose before and after agree.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });
      const before = await revisionOf(pageId);

      const result = await applyFormatOps(
        { pageId },
        [
          { type: 'setCellFormat', range: 'B2', patch: BOLD },
          { type: 'clearCellFormat', range: 'B2' },
        ],
        { userId: ownerId }
      );

      expect(result).toMatchObject({ cellsFormatted: 0, rowsTouched: 0 });
      expect(await revisionOf(pageId)).toEqual(before);
      expect(await readRows(tabId, { limit: 10 })).toEqual([]);
    });

    it('does not count freezing nothing on a tab that stores a zero freeze', async () => {
      // The document path stores `frozenRows: 0`; `setFrozen` normalises 0 to
      // "none". They must compare equal or the request counts as an edit.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 10 });
      await db.update(sheetTabs).set({ frozenRows: 0, frozenColumns: 0 }).where(eq(sheetTabs.id, tabId));
      const before = await revisionOf(pageId);

      const result = await applyFormatOps({ pageId }, [{ type: 'setFrozen', rows: 0, columns: null }], { userId: ownerId });

      expect(result.tabFieldsChanged).toEqual([]);
      expect(await revisionOf(pageId)).toEqual(before);
    });

    it('re-evaluates open-ended range formulas when the extent grows', async () => {
      // `rowCount` is an input to a formula over an open range —
      // `evaluateClosure` resolves `rect.rowEnd ?? rowCount - 1` — and a
      // format write past the extent grows it, so a stored total would be
      // wrong and presented as correct.
      //
      // HONEST SCOPE: the parser rejects `A:A` today (see `deps.ts`), so no
      // formula can put an open edge into `sheet_range_deps` through the
      // write path. The edge is seeded directly, and the input the recompute
      // must pick up is a row past the extent whose value the stale
      // materialisation never saw. What this kills: skipping the open-edge
      // query, skipping the closure walk, or evaluating with the old extent
      // (which would never load row 10).
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 3, columnCount: 3 });
      await setCells({ pageId }, [
        { address: 'A1', value: '1' },
        { address: 'A2', value: '2' },
        { address: 'A3', value: '3' },
        { address: 'B1', value: '=SUM(A1:A10)' },
      ], { userId: ownerId });
      expect(cellAt(await readRows(tabId, { limit: 1 }), 0, 'B')?.value).toBe(6);

      // A row past the extent, and the open edge the parser cannot yet write.
      await db.insert(sheetRows).values({
        tabId,
        pageId,
        rowIndex: 9,
        cells: { A: { raw: '100', value: 100, type: 'number' } },
      });
      await db.delete(sheetRangeDeps).where(eq(sheetRangeDeps.tabId, tabId));
      await db.insert(sheetRangeDeps).values({
        tabId,
        formulaAddress: 'B1',
        rowStart: 0,
        rowEnd: null,
        colStart: 0,
        colEnd: 0,
      });

      // No growth: no recompute, and the stale total stands.
      const inside = await applyFormatOps(
        { pageId },
        [{ type: 'setCellFormat', range: 'C3', patch: BOLD }],
        { userId: ownerId }
      );
      expect(inside.recomputed).toEqual([]);
      expect(cellAt(await readRows(tabId, { limit: 1 }), 0, 'B')?.value).toBe(6);

      // Growth: the formula is re-evaluated against the taller sheet.
      const grown = await applyFormatOps(
        { pageId },
        [{ type: 'setCellFormat', range: 'C10', patch: BOLD }],
        { userId: ownerId }
      );
      expect(grown.rowCount).toBe(10);
      expect(grown.recomputed).toEqual(['B1']);
      expect((await getTab({ pageId }))?.rowCount).toBe(10);
      expect(cellAt(await readRows(tabId, { limit: 1 }), 0, 'B')?.value).toBe(106);
    });

    it('round-trips regions through the document and back', async () => {
      // Kills: writing regions somewhere the projection does not read, or a
      // shape the parser drops on the way back in.
      const { pageId, ownerId } = await makeSheet({ rowCount: 20, columnCount: 6 });

      await applyFormatOps({ pageId }, [{ type: 'setRegions', regions: [REGION] }], { userId: ownerId });

      const document = (await readSheetDocument(pageId))!;
      expect(parseSheetContent(document).regions).toEqual([REGION]);

      await replaceFromDocument({ pageId }, document, { userId: ownerId });

      expect((await readTabFormatting({ pageId }))?.regions).toEqual([REGION]);
    });

    it('logs a large range as one summary entry and a small one per cell', async () => {
      // Kills: per-cell log rows past `CHANGE_LOG_SUMMARY_THRESHOLD` — the
      // write amplification the row store removed, back in the audit trail.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 1_000 });

      await applyFormatOps({ pageId }, [{ type: 'setCellFormat', range: 'A1:A600', patch: BOLD }], { userId: ownerId });
      const bulk = await db
        .select({ address: sheetChanges.address, after: sheetChanges.after })
        .from(sheetChanges)
        .where(and(eq(sheetChanges.tabId, tabId), eq(sheetChanges.op, 'format')));
      expect(bulk).toHaveLength(1);
      expect(bulk[0].address).toBeNull();
      expect(bulk[0].after).toMatchObject({ cells: 600, firstAddress: 'A1', lastAddress: 'A600' });

      await applyFormatOps({ pageId }, [{ type: 'setCellFormat', range: 'B1:B2', patch: BOLD }], { userId: ownerId });
      const small = await db
        .select({ address: sheetChanges.address, before: sheetChanges.before, after: sheetChanges.after })
        .from(sheetChanges)
        .where(and(eq(sheetChanges.tabId, tabId), inArray(sheetChanges.address, ['B1', 'B2'])));
      expect(small.map((entry) => entry.address).sort()).toEqual(['B1', 'B2']);
      expect(small[0].before).toBeNull();
      expect(small[0].after).toEqual(BOLD);
    });
  });

  describe('readTabFormatting', () => {
    it('returns null for an unmigrated sheet without materialising it', async () => {
      // A read must never write. The `null` alone passes vacuously — a read
      // that materialised and then failed would also return it — so the
      // assertion that matters is that no tab row appeared.
      const { pageId } = await makeUnmigratedSheet(
        '#%PAGESPACE_SHEETDOC v1\npage_id = "x"\n\n[[sheets]]\nname = "Sheet1"\norder = 0\n\n[sheets.meta]\nrowCount = 5\ncolumnCount = 3\n\n[sheets.cells.A1]\nvalue = "existing"\n'
      );

      expect(await readTabFormatting({ pageId }, { ranges: ['A1:C5'] })).toBeNull();

      const tabs = await db.select({ id: sheetTabs.id }).from(sheetTabs).where(eq(sheetTabs.pageId, pageId));
      expect(tabs).toHaveLength(0);
    });

    it('returns tab fields, parsed rules and regions, and per-cell formats inside the ranges', async () => {
      // Kills: returning the raw rule column (the bogus entry would come back
      // and be written again by any caller that round-trips), and returning
      // formats outside the requested rectangles.
      const { pageId, tabId, ownerId } = await makeSheet({ rowCount: 20, columnCount: 6 });
      await applyFormatOps(
        { pageId },
        [
          { type: 'setCellFormat', range: 'B2:C3', patch: BOLD },
          { type: 'setCellFormat', range: 'E9', patch: { italic: true } },
          { type: 'setColumnFormat', column: 'A', patch: { align: 'right' } },
          { type: 'setRowHeight', row: 2, height: 40 },
          { type: 'setFrozen', rows: 1, columns: 1 },
          { type: 'setRegions', regions: [REGION] },
        ],
        { userId: ownerId }
      );
      await db
        .update(sheetTabs)
        .set({ conditionalFormats: [FORMAT_RULE, { id: 'bogus', kind: 'formula', formula: '' }] })
        .where(eq(sheetTabs.id, tabId));

      const formatting = (await readTabFormatting({ pageId }, { ranges: ['B2:B9', 'C3'] }))!;

      expect(formatting.conditionalFormats).toEqual([FORMAT_RULE]);
      expect(formatting.regions).toEqual([REGION]);
      expect(formatting.columnFormats).toEqual({ A: { align: 'right' } });
      expect(formatting.rowHeights).toEqual({ '2': 40 });
      expect(formatting.frozenRows).toBe(1);
      expect(formatting.frozenColumns).toBe(1);
      // B2, B3 and C3 are inside; C2 is outside both ranges and E9 is far away.
      expect(Object.keys(formatting.cellFormats).sort()).toEqual(['B2', 'B3', 'C3']);
      expect(formatting.cellFormats.B2).toEqual(BOLD);

      // No ranges: no per-cell read at all.
      expect((await readTabFormatting({ pageId }))?.cellFormats).toEqual({});
    });

    it('refuses a range it cannot address or that is too large to expand', async () => {
      const { pageId } = await makeSheet({ rowCount: 20 });
      await expect(readTabFormatting({ pageId }, { ranges: ['A0:B2'] })).rejects.toBeInstanceOf(SheetFormatError);
      await expect(readTabFormatting({ pageId }, { ranges: ['A1:ZZ50000'] })).rejects.toThrow(/cells between them/);
    });
  });
});
