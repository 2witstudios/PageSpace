/**
 * `read_sheet` — the structured read that makes a spreadsheet usable to an agent.
 *
 * Before this tool, the only way an agent could read a SHEET was `read_page`,
 * which reconstructed the whole sheet as a SheetDoc TOML document and numbered
 * it line by line: ~24,000 lines for 500 rows x 16 columns, addressed cell by
 * cell. There was no way to say "rows 5-10, columns B-D" or "the row where
 * memid = 28605", so verifying a bulk write meant streaming megabytes back
 * through ranged reads. Agents worked around it by keeping a copy of the data
 * outside the platform entirely — the storage was write-only in practice
 * (issue #2467).
 *
 * The row store already answers all of those questions; `/api/mcp/sheets` has
 * exposed them to SDK and CLI callers as `get-rows` / `query-rows` / `describe`
 * since the sheets re-architecture. This tool is the in-process facade over the
 * SAME functions — `readRows` and `queryRows` from `@pagespace/lib/sheets/store`
 * — and deliberately implements no filtering, ordering or projection of its
 * own. Everything it does not format, it hands straight to the store.
 *
 * Two things it does NOT copy from the MCP route, on purpose:
 *
 *  - Row numbers are 1-BASED here, because they are the numbers the model reads
 *    in the rendered table and the numbers in the A1 addresses it writes back.
 *    `/api/mcp/sheets` speaks 0-based `fromRow` to programmatic callers; mixing
 *    the two conventions under one name would be an off-by-one waiting to
 *    happen, so this tool's parameter has a different NAME (`startRow`) as well
 *    as a different base.
 *  - The filter is a flat condition list, not the route's recursive and/or/not
 *    tree. A recursive zod schema becomes a `$ref` cycle in the JSON Schema
 *    handed to a model, which several providers reject outright. Nesting is
 *    still available over `/api/mcp/sheets` for programmatic callers.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { PageType } from '@pagespace/lib/utils/enums';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import { ensureTab, queryRows, listTabs, getTab } from '@pagespace/lib/sheets/store';
import { SheetQueryError, type SheetWhere } from '@pagespace/lib/sheets/query';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';
import type { ToolExecutionContext } from '../core/types';
import { canActorViewPage, canActorEditPage } from './actor-permissions';
import { resolveOrThrowPageId } from './page-context-defaults';
import {
  DEFAULT_SHEET_READ_ROWS,
  MAX_SHEET_READ_ROWS,
  columnsInRows,
  loadSheetWindow,
  renderSheetTable,
  toSheetViewRow,
  type SheetViewRow,
} from './sheet-view';

const sheetReadLogger = loggers.ai.child({ module: 'sheet-read-tools' });

/**
 * Seven letters, matching `assertColumn` in the store and the MCP route's
 * `columnSchema`. Capping shorter would make every column past the cap
 * unreadable as a 400 on input that the sheet itself accepts.
 */
const columnSchema = z
  .string()
  .regex(/^[A-Za-z]{1,7}$/, 'Column must be letters, e.g. "A" or "AB"')
  .describe('A column letter as shown in the sheet header, e.g. "A", "B", "AB".');

const conditionSchema = z.object({
  column: columnSchema,
  op: z
    .enum([
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
      'contains', 'startsWith', 'endsWith',
      'isEmpty', 'isNotEmpty', 'in',
    ])
    .describe('Comparison to apply. "in" takes an array value; "isEmpty"/"isNotEmpty" take none.'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
    .optional()
    .describe('Value to compare against. Omit for isEmpty/isNotEmpty. Use an array for "in".'),
});

const whereSchema = z
  .object({
    match: z
      .enum(['all', 'any'])
      .optional()
      .describe('How to combine conditions: "all" (AND, the default) or "any" (OR).'),
    conditions: z.array(conditionSchema).min(1).max(32),
  })
  .describe(
    'Filter rows in the database instead of reading them all. Conditions compare the ' +
    "cell's COMPUTED value, so a formula column filters on its result."
  );

const orderBySchema = z.object({
  column: columnSchema,
  direction: z.enum(['asc', 'desc']).optional(),
  numeric: z
    .boolean()
    .optional()
    .describe('Sort as numbers rather than text. Without it "10" sorts before "9".'),
});

/**
 * The flat `{match, conditions}` shape a model sees, translated to the store's
 * recursive `SheetWhere`. One condition needs no wrapper — `and: [x]` and `x`
 * compile identically, and the plain form is what the store's own tests read
 * like.
 */
function toSheetWhere(where: z.infer<typeof whereSchema> | undefined): SheetWhere | undefined {
  if (!where || where.conditions.length === 0) return undefined;
  const conditions: SheetWhere[] = where.conditions;
  if (conditions.length === 1) return conditions[0];
  return where.match === 'any' ? { or: conditions } : { and: conditions };
}

export const sheetReadTools = {
  read_sheet: tool({
    description:
      'Read rows from a SHEET page as structured data — the way to read a spreadsheet. ' +
      'Three ways to use it: (1) omit everything for the first ' + DEFAULT_SHEET_READ_ROWS + ' rows plus the sheet\'s dimensions; ' +
      '(2) pass startRow/limit to read a row RANGE; (3) pass where/orderBy/select to look rows up by ' +
      'value (e.g. the row where column C equals "28605") and project only the columns you need. ' +
      'Filters run in the database against each cell\'s COMPUTED value, so formula columns match on their results. ' +
      'Returns at most ' + MAX_SHEET_READ_ROWS + ' rows per call — page with startRow (range) or offset (filtered). ' +
      'Prefer this over read_page for any sheet with real data in it. Omit pageId to read the sheet currently in view.',
    inputSchema: z.object({
      pageId: z.string().optional().describe('The unique ID of the SHEET page. Defaults to the page currently in view if omitted.'),
      tabIndex: z.number().int().min(0).optional().describe('Which tab to read, 0-based. Defaults to the first tab. The response lists every tab.'),
      startRow: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'RANGE reads only: 1-based sheet row number to start at — the same number shown in front of ' +
          'each row and used in its A1 addresses (row 417 is where C417 lives). Cannot be combined with where/orderBy.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SHEET_READ_ROWS)
        .optional()
        .describe(`How many rows to return. Default ${DEFAULT_SHEET_READ_ROWS}, maximum ${MAX_SHEET_READ_ROWS}.`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('FILTERED reads only: how many matching rows to skip, for paging through results. Cannot be combined with startRow.'),
      where: whereSchema.optional(),
      orderBy: z.array(orderBySchema).max(8).optional().describe('Sort the matching rows. Applied in the database, before limit/offset.'),
      select: z
        .array(columnSchema)
        .max(64)
        .optional()
        .describe('Only return these columns. Omit for every column each row has.'),
    }),
    execute: async (
      { pageId: pageIdArg, tabIndex, startRow, limit, offset, where, orderBy, select },
      { experimental_context: context }
    ) => {
      const toolContext = context as ToolExecutionContext;
      const userId = toolContext?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, toolContext);

      try {
        const page = await pageRepository.findById(pageId);
        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        if (!isSheetType(page.type as PageType)) {
          return {
            success: false,
            error: 'Page is not a sheet',
            message: `This page is a ${page.type}. read_sheet only reads SHEET pages.`,
            suggestion: 'Use read_page for documents, notes and code.',
            pageInfo: { pageId: page.id, title: page.title, type: page.type },
          };
        }

        if (!(await canActorViewPage(toolContext, page.id))) {
          throw new Error('Insufficient permissions to read this sheet');
        }

        const isFiltered = where !== undefined || orderBy !== undefined || offset !== undefined;

        // The two paging models are different coordinate systems, and silently
        // ignoring the one that doesn't apply is exactly the failure this tool
        // exists to remove: an agent that passes startRow with a filter and
        // gets matches starting from the top would believe it had paged.
        if (isFiltered && startRow !== undefined) {
          return {
            success: false,
            error: 'startRow cannot be combined with where/orderBy/offset',
            message:
              'startRow is a POSITION in the sheet; a filtered read returns matches, which are paged with ' +
              'offset instead. Filtered results are not at their sheet positions.',
            suggestion:
              'Either drop where/orderBy/offset to read the range starting at startRow, or drop startRow and page ' +
              'the matches with offset. Each returned row still carries its own rowNumber.',
          };
        }

        const pageSize = limit ?? DEFAULT_SHEET_READ_ROWS;

        if (!isFiltered) {
          // Positional range. Works on an unmigrated sheet too — `loadSheetWindow`
          // falls back to parsing the stored document, which is a pure read.
          const window = await loadSheetWindow(page.id, {
            tabIndex,
            fromRow: startRow !== undefined ? startRow - 1 : 0,
            limit: pageSize,
            documentContent: page.content,
          });

          return buildResult({
            page,
            mode: 'range' as const,
            tabIndex: window.tabIndex,
            tabName: window.tabName,
            rowCount: window.rowCount,
            columnCount: window.columnCount,
            tabs: window.tabs,
            materialized: window.materialized,
            rows: window.rows,
            hasMore: window.hasMore,
            nextStartRow: window.nextFromRow !== null ? window.nextFromRow + 1 : null,
            select,
          });
        }

        // Filtered reads compile to SQL over the row store, so they need the
        // sheet materialised. Materialising is a WRITE (it inserts tabs, rows
        // and dependency edges), so a view-only actor must not trigger it —
        // mirroring `/api/mcp/sheets`, which draws the same line. Falling back
        // to an unfiltered document read would answer a different question
        // than the one asked, which is worse than saying so.
        const materialized = (await listTabs(page.id)).length > 0;
        if (!materialized) {
          if (!(await canActorEditPage(toolContext, page.id))) {
            return {
              success: false,
              error: 'Sheet not migrated to row storage',
              message:
                'Filtering and sorting run in the database, and this sheet\'s rows have not been migrated there yet. ' +
                'Read-only access cannot trigger the migration.',
              suggestion:
                'Read it positionally instead (drop where/orderBy/offset and use startRow/limit), or ask someone with ' +
                'edit access to open or edit the sheet once.',
              pageInfo: { pageId: page.id, title: page.title, type: page.type },
            };
          }
          await ensureTab({ pageId: page.id, tabIndex: 0 });
        }

        const ref = { pageId: page.id, tabIndex: tabIndex ?? 0 };
        const tab = await getTab(ref);
        if (!tab) {
          return {
            success: false,
            error: `Sheet tab ${ref.tabIndex} not found`,
            message: `"${page.title}" has no tab at index ${ref.tabIndex}.`,
            suggestion: 'Call read_sheet without tabIndex to see the tabs this sheet has.',
          };
        }

        const result = await queryRows(ref, {
          where: toSheetWhere(where),
          orderBy,
          select,
          limit: pageSize,
          offset,
        });

        const rows = result.rows.map((row) => toSheetViewRow(row.rowIndex, row.cells));
        const tabs = (await listTabs(page.id)).map((entry) => ({
          tabIndex: entry.tabIndex,
          name: entry.name,
          rowCount: entry.rowCount,
          columnCount: entry.columnCount,
        }));

        return buildResult({
          page,
          mode: 'filter' as const,
          tabIndex: ref.tabIndex,
          tabName: tab.name,
          rowCount: tab.rowCount,
          columnCount: tab.columnCount,
          tabs,
          materialized: true,
          rows,
          hasMore: result.hasMore,
          matchedRows: result.total,
          nextOffset: result.hasMore ? (offset ?? 0) + rows.length : null,
          select,
        });
      } catch (error) {
        // A bad column letter or an `in` with no values is the caller's
        // mistake, and it can fix it — say what was wrong instead of throwing a
        // generic failure it can only retry verbatim.
        if (error instanceof SheetQueryError) {
          return {
            success: false,
            error: 'Invalid filter or sort',
            message: error.message,
            suggestion: 'Correct the where/orderBy/select arguments and call read_sheet again.',
          };
        }
        sheetReadLogger.error('Failed to read sheet', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
        });
        throw new Error(`Failed to read sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};

interface BuildResultParams {
  page: { id: string; title: string };
  mode: 'range' | 'filter';
  tabIndex: number;
  tabName: string;
  rowCount: number;
  columnCount: number;
  tabs: { tabIndex: number; name: string; rowCount: number; columnCount: number }[];
  materialized: boolean;
  rows: SheetViewRow[];
  hasMore: boolean;
  matchedRows?: number;
  nextStartRow?: number | null;
  nextOffset?: number | null;
  select?: string[];
}

function buildResult(params: BuildResultParams) {
  const {
    page, mode, tabIndex, tabName, rowCount, columnCount, tabs,
    materialized, rows, hasMore, matchedRows, nextStartRow, nextOffset, select,
  } = params;

  // With `select`, the projected columns are the answer even when every
  // matching row happens to leave one of them empty — reporting only the
  // columns that came back would make an all-empty column look absent.
  const columns = select && select.length > 0
    ? [...select].map((column) => column.toUpperCase())
    : columnsInRows(rows);

  const scope = mode === 'filter'
    ? `${matchedRows ?? rows.length} matching row${(matchedRows ?? rows.length) === 1 ? '' : 's'}`
    : `${rowCount} row${rowCount === 1 ? '' : 's'}`;

  return {
    success: true as const,
    pageId: page.id,
    title: page.title,
    tabIndex,
    tabName,
    mode,
    dimensions: { rowCount, columnCount },
    tabs,
    materialized,
    columns,
    rows,
    rowsReturned: rows.length,
    ...(matchedRows !== undefined && { matchedRows }),
    hasMore,
    ...(nextStartRow !== undefined && { nextStartRow }),
    ...(nextOffset !== undefined && { nextOffset }),
    table: renderSheetTable(rows, columns),
    summary: `Read ${rows.length} row${rows.length === 1 ? '' : 's'} from sheet "${page.title}" (${scope}, ${columnCount} columns)`,
    nextSteps: [
      ...(hasMore
        ? [
            mode === 'filter'
              ? `More matches remain — call read_sheet again with offset: ${nextOffset} and the same where/orderBy.`
              : `More rows remain — call read_sheet again with startRow: ${nextStartRow}.`,
          ]
        : []),
      ...(mode === 'range'
        ? ['Pass where to look rows up by value instead of paging, and select to return only the columns you need.']
        : []),
      'Each row\'s rowNumber is its A1 row — write to it with edit_sheet_cells using addresses like C<rowNumber>.',
    ],
  };
}
