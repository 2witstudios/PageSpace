import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import {
  sheetTabs,
  sheetRows,
  sheetCellDeps,
  sheetRangeDeps,
} from '@pagespace/db/schema';
import { and, asc, eq, gt, sql } from '@pagespace/db/operators';
import {
  parseSheetContentSafe,
  sheetDataFromSheetDoc,
  parseSheetDocString,
  isSheetDocString,
  rowsFromSheetData,
} from '@pagespace/lib/sheets/sheet';
import type { SheetData } from '@pagespace/lib/sheets/sheet';

/**
 * One-shot backfill: move every SHEET page out of the `pages.content` document
 * and into the sheet row tables.
 *
 * A sheet used to be a `#%PAGESPACE_SHEETDOC v1` string that every cell edit
 * parsed and re-serialised whole, which made a write O(document) — ~17s of CPU
 * for one cell on a 100k-row sheet. Rows are now the source of truth and the
 * document form is generated on demand, so this moves the existing data across.
 *
 * Deliberately a script rather than SQL: the document can only be read by the
 * TypeScript parser, and a migration cannot call it.
 *
 * Safe to re-run. Idempotence comes from the tab pointer, not a stamp — a page
 * that already has tabs is skipped, so a partially-completed run resumes rather
 * than duplicating rows.
 *
 * A page whose content will not parse is REPORTED AND SKIPPED, never emptied.
 * Blanking `pages.content` for a sheet we could not read would destroy the only
 * copy of it; the same refuse-on-unparseable stance the write paths already
 * take. Re-run after fixing, or leave it on the document path.
 *
 * Usage:
 *   bun scripts/backfill-sheet-rows.ts --dry-run
 *   bun scripts/backfill-sheet-rows.ts                  # copy rows across
 *   bun scripts/backfill-sheet-rows.ts --page <pageId>
 *   bun scripts/backfill-sheet-rows.ts --clear-content  # AFTER cutover only
 */

const BATCH_SIZE = 50;

interface Options {
  dryRun: boolean;
  clearContent: boolean;
  pageId?: string;
}

interface Report {
  scanned: number;
  migrated: number;
  skippedExisting: number;
  /** Pages already migrated whose document `--clear-content` emptied. */
  clearedExisting: number;
  skippedEmpty: number;
  unparseable: { pageId: string; title: string; reason: string }[];
  /** Pages whose migration threw. Reported, not fatal — see the loop. */
  failed: { pageId: string; title: string; error: string }[];
  rowsWritten: number;
}

function parseArgs(argv: string[]): Options {
  const pageFlag = argv.indexOf('--page');
  let pageId: string | undefined;

  if (pageFlag >= 0) {
    const value = argv[pageFlag + 1];
    // Refuse rather than fall through. `--page` with nothing after it used to
    // yield `undefined`, which took the "every SHEET in the database" branch —
    // a whole-table backfill from a command that asked for one page. `--page
    // --dry-run` was worse: it took '--dry-run' as the id, matched nothing, and
    // reported a clean run.
    if (!value || value.startsWith('--')) {
      throw new Error('--page requires a page id, e.g. --page abc123');
    }
    pageId = value;
  }

  return {
    dryRun: argv.includes('--dry-run'),
    clearContent: argv.includes('--clear-content'),
    pageId,
  };
}

/**
 * Every tab of a stored document.
 *
 * `parseSheetContentSafe` returns only the first sheet as `SheetData`; a
 * multi-tab document keeps the rest in `extraSheets`. Migrating just the first
 * would silently delete every other tab, which is exactly the failure the
 * document format's `extraSheets` field exists to prevent.
 */
function tabsOf(content: string): { ok: true; tabs: SheetData[] } | { ok: false; reason: string } {
  const parsed = parseSheetContentSafe(content);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const tabs: SheetData[] = [parsed.sheet];

  if (isSheetDocString(content)) {
    try {
      const doc = parseSheetDocString(content);
      for (let index = 1; index < doc.sheets.length; index++) {
        tabs.push(sheetDataFromSheetDoc({ ...doc, sheets: [doc.sheets[index]] }));
      }
    } catch (error) {
      return { ok: false, reason: `multi-tab read failed: ${(error as Error).message}` };
    }
  }

  return { ok: true, tabs };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = getMigrationDb();
  const report: Report = {
    scanned: 0,
    migrated: 0,
    skippedExisting: 0,
    clearedExisting: 0,
    skippedEmpty: 0,
    unparseable: [],
    failed: [],
    rowsWritten: 0,
  };

  let cursor = '';
  for (;;) {
    const batch = await db
      .select({ id: pages.id, title: pages.title, content: pages.content, driveId: pages.driveId })
      .from(pages)
      .where(
        // The SHEET predicate applies to BOTH branches. Without it,
        // `--page <id>` on a non-sheet page would insert a `sheet_tabs` row for
        // it and, with `--clear-content`, blank a document this script has no
        // business touching.
        options.pageId
          ? and(eq(pages.id, options.pageId), eq(pages.type, 'SHEET'))
          : and(eq(pages.type, 'SHEET'), gt(pages.id, cursor))
      )
      .orderBy(asc(pages.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const page of batch) {
      report.scanned++;

      const [existing] = await db
        .select({ id: sheetTabs.id })
        .from(sheetTabs)
        .where(eq(sheetTabs.pageId, page.id))
        .limit(1);

      if (existing) {
        // Already migrated — but `--clear-content` still has work to do here.
        //
        // Clearing is a deliberate SECOND pass, run after the read paths are
        // cut over, and by then every sheet has been materialised. Skipping
        // outright meant the flag cleared nothing on exactly the pages it was
        // meant for, and reported a clean run.
        if (options.clearContent && !options.dryRun && (page.content ?? '') !== '') {
          await db.update(pages).set({ content: '' }).where(eq(pages.id, page.id));
          report.clearedExisting++;
        }
        report.skippedExisting++;
        continue;
      }

      const content = page.content ?? '';
      if (!content.trim()) {
        // An empty sheet still needs a tab, or the editor has nothing to open.
        if (!options.dryRun) {
          await db.insert(sheetTabs).values({
            pageId: page.id,
            tabIndex: 0,
            name: 'Sheet1',
            rowCount: 20,
            columnCount: 10,
          });
        }
        report.skippedEmpty++;
        continue;
      }

      const parsed = tabsOf(content);
      if (!parsed.ok) {
        report.unparseable.push({ pageId: page.id, title: page.title, reason: parsed.reason });
        continue;
      }

      if (options.dryRun) {
        report.migrated++;
        report.rowsWritten += parsed.tabs.reduce(
          (total, tab) => total + rowsFromSheetData(tab).rows.length,
          0
        );
        continue;
      }

      try {
        await db.transaction(async (tx) => {
        for (const [tabIndex, sheet] of parsed.tabs.entries()) {
          const materialized = rowsFromSheetData(sheet, tabIndex);

          const [tab] = await tx
            .insert(sheetTabs)
            .values({
              pageId: page.id,
              tabIndex,
              name: materialized.tab.name,
              rowCount: materialized.tab.rowCount,
              columnCount: materialized.tab.columnCount,
              frozenRows: materialized.tab.frozenRows,
              frozenColumns: materialized.tab.frozenColumns,
              columnFormats: materialized.tab.columnFormats,
              columnWidths: materialized.tab.columnWidths,
              rowHeights: materialized.tab.rowHeights,
              ranges: materialized.tab.ranges,
            })
            .returning({ id: sheetTabs.id });

          await insertChunked(tx, sheetRows, materialized.rows.map((row) => ({
            tabId: tab.id,
            pageId: page.id,
            rowIndex: row.rowIndex,
            cells: row.cells,
          })));

          await insertChunked(tx, sheetCellDeps, materialized.cellDeps.map((dep) => ({
            tabId: tab.id,
            address: dep.address,
            dependsOn: dep.dependsOn,
            dependents: dep.dependents,
          })));

          await insertChunked(tx, sheetRangeDeps, materialized.rangeDeps.map((dep) => ({
            tabId: tab.id,
            formulaAddress: dep.formulaAddress,
            rowStart: dep.rowStart,
            rowEnd: dep.rowEnd,
            colStart: dep.colStart,
            colEnd: dep.colEnd,
          })));

          report.rowsWritten += materialized.rows.length;
        }

        // Opt-in, and only after every tab landed.
        //
        // Copying the rows across is safe at any time; emptying the document is
        // not, because it is destructive the moment anything still reads it.
        // Until the editor, exporters and publisher are cut over to the row
        // store, clearing content would leave every sheet rendering blank — so
        // the default is to migrate and leave the document in place, and
        // `--clear-content` is a deliberate second step run after cutover.
        //
        // `pages.content` is NOT NULL, so a cleared sheet holds the empty
        // string rather than NULL.
        if (options.clearContent) {
          await tx.update(pages).set({ content: '' }).where(eq(pages.id, page.id));
        }
        });

        report.migrated++;
      } catch (error) {
        // One page must not abort the run.
        //
        // Each page migrates in its own transaction, so a failure here leaves
        // that page untouched and every other page already committed. Aborting
        // the whole backfill on the first bad row would mean an operator
        // restarts from the beginning and hits the same page again; recording
        // it lets the run finish and the failures be dealt with by id.
        report.failed.push({
          pageId: page.id,
          title: page.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (options.pageId) break;
  }

  if (options.pageId && report.scanned === 0) {
    console.error(`No SHEET page found with id ${options.pageId}.`);
    process.exitCode = 1;
  }

  console.log(JSON.stringify(report, null, 2));

  if (report.failed.length > 0) {
    console.error(
      `\n${report.failed.length} sheet(s) failed to migrate and were left untouched. ` +
        `Re-run with --page <id> after investigating.`
    );
    process.exitCode = 1;
  }

  if (report.unparseable.length > 0) {
    console.error(
      `\n${report.unparseable.length} sheet(s) could not be read and were left on the document ` +
        `path with their content intact. Investigate before dropping the fallback.`
    );
    process.exitCode = 1;
  }
}

/**
 * Postgres refuses a statement with more than 65535 bind parameters, and
 * reports it as an opaque protocol error rather than a size complaint. A wide
 * table reaches that in a few thousand rows.
 */
async function insertChunked<T>(
  tx: ReturnType<typeof getMigrationDb>,
  table: Parameters<ReturnType<typeof getMigrationDb>['insert']>[0],
  values: T[],
  chunk = 500
): Promise<void> {
  for (let index = 0; index < values.length; index += chunk) {
    const slice = values.slice(index, index + chunk);
    if (slice.length === 0) continue;
    await tx.insert(table).values(slice as never);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
