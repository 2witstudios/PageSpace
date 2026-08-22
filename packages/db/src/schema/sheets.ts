import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  bigserial,
  index,
  unique,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { pages } from './core';
import { users } from './auth';
import type { CellFormat, StoredCell } from './sheets-types';

/**
 * Sheets are stored as rows, not as a document.
 *
 * The previous model kept a whole `#%PAGESPACE_SHEETDOC v1` string in
 * `pages.content` and rewrote all of it on every cell edit, which made a write
 * O(document): a 100k-row sheet cost ~17s of parse+serialize CPU per cell and
 * persisted the document roughly four times over (page content, a version blob,
 * and both activity-log value payloads). These tables make a cell write touch
 * one row, and leave the SHEETDOC form as an on-demand projection for export,
 * publishing and download rather than the storage format.
 *
HISTORY: a sheet's version history is `page_versions`, same as every other
 * page type — one content-addressed blob of the projected document per
 * DOCUMENT save. That is what drive backup, drive restore and page rollback
 * read. Addressed cell writes (MCP, SDK, form submissions) do not create a
 * version; they are attributed per cell in `sheet_changes`.
 *
 * MIGRATION STATE — read this before assuming where a sheet's truth lives.
 *
 * The destination is that `pages.content` is empty for SHEET pages and the
 * SHEETDOC form is generated on demand for export, publish and download. That
 * is NOT yet true: the editor, `/api/mcp/documents` `edit-cells`, the AI write
 * tools and `page-payload-service` still read and write that column, so a sheet
 * has two representations until they are cut over. `ensureTab` materialises the
 * document into rows on first row-store access, and the backfill script
 * deliberately leaves `pages.content` in place unless `--clear-content` is
 * passed, so the document remains the fallback until nothing depends on it.
 */

/**
 * One tab of a sheet. Replaces `SheetDoc.sheets[]` / `SheetData.extraSheets`.
 *
 * Grid-wide presentation (column widths, row heights, freezes, named ranges)
 * lives here rather than on the rows: it is O(columns) not O(rows), and keeping
 * it off the row records means a column resize does not rewrite every row.
 */
export const sheetTabs = pgTable('sheet_tabs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  /** 0-based position. Tab 0 is the one the editor shows today. */
  tabIndex: integer('tabIndex').notNull(),
  name: text('name').notNull(),

  /**
   * The sheet's declared extent. Deliberately stored rather than derived from
   * `max(rowIndex)`: a sheet has a size even where its trailing rows are empty,
   * and the editor renders that extent.
   */
  rowCount: integer('rowCount').notNull(),
  columnCount: integer('columnCount').notNull(),

  frozenRows: integer('frozenRows'),
  frozenColumns: integer('frozenColumns'),

  /** Column defaults / widths keyed by column letter ("A", "AB"). */
  columnFormats: jsonb('columnFormats').$type<Record<string, CellFormat>>(),
  columnWidths: jsonb('columnWidths').$type<Record<string, number>>(),
  /** Row heights keyed by 1-based row number as a string. */
  rowHeights: jsonb('rowHeights').$type<Record<string, number>>(),

  /**
   * Named/defined ranges, carried verbatim. Nothing resolves them yet, but
   * dropping what we do not understand turns a save into silent data loss for
   * anything written by a newer build.
   */
  ranges: jsonb('ranges').$type<Record<string, Record<string, unknown>>>(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pageTabUnique: unique('sheet_tabs_page_tab_unique').on(table.pageId, table.tabIndex),
  pageIdx: index('sheet_tabs_page_id_idx').on(table.pageId),
  extentNonNegative: check(
    'sheet_tabs_extent_non_negative',
    sql`${table.rowCount} >= 0 AND ${table.columnCount} >= 0`
  ),
}));

/**
 * One spreadsheet row.
 *
 * `cells` is keyed by column letter — `{"A": {raw, value, type, ...}}` — so a
 * row carries only the columns it actually uses. One DB row per spreadsheet row
 * (rather than per cell) is the grain both dominant reads want: a UI viewport
 * and an agent query both fetch runs of rows, where a cell-per-row table would
 * turn a 50-row viewport into 400 lookups and an eight-fold index overhead.
 *
 * `pageId` is denormalised off `sheet_tabs` so permission filtering and
 * cross-tab queries do not need a join.
 */
export const sheetRows = pgTable('sheet_rows', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tabId: text('tabId').notNull().references(() => sheetTabs.id, { onDelete: 'cascade' }),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  /** 0-based row position within the tab. */
  rowIndex: integer('rowIndex').notNull(),

  /**
   * `Record<columnLetter, StoredCell>` — see `StoredCell` in sheets-types.
   * Holds both the authored `raw` text and the materialised computed `value`,
   * so a read never has to evaluate.
   */
  cells: jsonb('cells').$type<Record<string, StoredCell>>().notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  tabRowUnique: unique('sheet_rows_tab_row_unique').on(table.tabId, table.rowIndex),
  pageRowIdx: index('sheet_rows_page_row_idx').on(table.pageId, table.rowIndex),
  tabRowIdx: index('sheet_rows_tab_row_idx').on(table.tabId, table.rowIndex),
  /** Supports `query-rows` predicates over cell contents. */
  cellsGin: index('sheet_rows_cells_gin').using('gin', table.cells),
  rowIndexNonNegative: check('sheet_rows_row_index_non_negative', sql`${table.rowIndex} >= 0`),
}));

/**
 * Cell-level dependency edges, for incremental recompute.
 *
 * Sparse by construction: only cells that participate in a formula get a row,
 * so a sheet of pure data has none. Written from the same graph the SHEETDOC
 * format already computes and round-trips.
 */
export const sheetCellDeps = pgTable('sheet_cell_deps', {
  tabId: text('tabId').notNull().references(() => sheetTabs.id, { onDelete: 'cascade' }),
  /** A1 address of the cell holding the formula. */
  address: text('address').notNull(),
  /** Addresses this cell reads. */
  dependsOn: text('dependsOn').array().notNull(),
  /** Addresses that read this cell — the edge recompute actually walks. */
  dependents: text('dependents').array().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tabId, table.address] }),
  tabIdx: index('sheet_cell_deps_tab_idx').on(table.tabId),
}));

/**
 * Range dependency edges, for formulas over open or multi-cell ranges.
 *
 * `sheet_cell_deps` cannot express `SUM(D:D)`: a row inserted into that range
 * changes the formula's value without touching any cell the formula names, so
 * per-cell edges would miss it. Storing the rectangle lets a row write find
 * every formula whose range covers it with one indexed containment query.
 *
 * An open-ended reference stores its bound as NULL (`D:D` is
 * rowStart 0, rowEnd NULL), meaning "to the end of the sheet".
 */
export const sheetRangeDeps = pgTable('sheet_range_deps', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tabId: text('tabId').notNull().references(() => sheetTabs.id, { onDelete: 'cascade' }),
  /** A1 address of the cell holding the formula. */
  formulaAddress: text('formulaAddress').notNull(),
  /** 0-based, inclusive. NULL end means unbounded. */
  rowStart: integer('rowStart').notNull(),
  rowEnd: integer('rowEnd'),
  colStart: integer('colStart').notNull(),
  colEnd: integer('colEnd'),
}, (table) => ({
  tabIdx: index('sheet_range_deps_tab_idx').on(table.tabId),
  /** Containment lookups filter on tab then bounds. */
  coverIdx: index('sheet_range_deps_cover_idx').on(table.tabId, table.rowStart, table.rowEnd),
  formulaIdx: index('sheet_range_deps_formula_idx').on(table.tabId, table.formulaAddress),
  boundsOrdered: check(
    'sheet_range_deps_bounds_ordered',
    sql`(${table.rowEnd} IS NULL OR ${table.rowEnd} >= ${table.rowStart}) AND (${table.colEnd} IS NULL OR ${table.colEnd} >= ${table.colStart})`
  ),
}));

/**
 * Append-only change log — the replacement for a full `page_versions` blob per
 * cell edit.
 *
 * Every mutation appends here at near-zero cost, which is what makes per-cell
 * attribution and time travel affordable at all; `sheet_snapshots` exists so a
 * restore does not have to replay from origin.
 */
export const sheetChanges = pgTable('sheet_changes', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  /**
   * No FK: a change describing a tab's deletion must outlive the tab, which is
   * the whole point of an audit record.
   */
  tabId: text('tabId'),
  /** Commit-order sequence for the log. */
  seq: bigserial('seq', { mode: 'number' }).notNull(),

  /** Null where the actor is gone; the log survives user deletion. */
  actorUserId: text('actorUserId').references(() => users.id, { onDelete: 'set null' }),
  actorEmail: text('actorEmail'),
  /** Groups the cells of one logical edit, mirroring activity-log change groups. */
  changeGroupId: text('changeGroupId'),

  op: text('op', {
    enum: ['set_cells', 'insert_rows', 'delete_rows', 'update_rows', 'format', 'resize', 'tab'],
  }).notNull(),

  /** Present for cell-addressed ops. */
  address: text('address'),
  /** Present for row-addressed ops. */
  rowIndex: integer('rowIndex'),

  before: jsonb('before'),
  after: jsonb('after'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pageSeqIdx: index('sheet_changes_page_seq_idx').on(table.pageId, table.seq),
  tabSeqIdx: index('sheet_changes_tab_seq_idx').on(table.tabId, table.seq),
  createdAtIdx: index('sheet_changes_created_at_idx').on(table.createdAt),
}));

export const sheetTabsRelations = relations(sheetTabs, ({ one, many }) => ({
  page: one(pages, { fields: [sheetTabs.pageId], references: [pages.id] }),
  rows: many(sheetRows),
  cellDeps: many(sheetCellDeps),
  rangeDeps: many(sheetRangeDeps),
}));

export const sheetRowsRelations = relations(sheetRows, ({ one }) => ({
  tab: one(sheetTabs, { fields: [sheetRows.tabId], references: [sheetTabs.id] }),
  page: one(pages, { fields: [sheetRows.pageId], references: [pages.id] }),
}));

export const sheetCellDepsRelations = relations(sheetCellDeps, ({ one }) => ({
  tab: one(sheetTabs, { fields: [sheetCellDeps.tabId], references: [sheetTabs.id] }),
}));

export const sheetRangeDepsRelations = relations(sheetRangeDeps, ({ one }) => ({
  tab: one(sheetTabs, { fields: [sheetRangeDeps.tabId], references: [sheetTabs.id] }),
}));

export const sheetChangesRelations = relations(sheetChanges, ({ one }) => ({
  page: one(pages, { fields: [sheetChanges.pageId], references: [pages.id] }),
  actor: one(users, { fields: [sheetChanges.actorUserId], references: [users.id] }),
}));

