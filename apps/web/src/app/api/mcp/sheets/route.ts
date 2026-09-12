import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { z } from 'zod/v4';
import { PageType } from '@pagespace/lib/utils/enums';
import { isSheetType, MAX_FORMAT_OPS, SheetFormatError } from '@pagespace/lib/sheets/sheet';
import type { SheetFormatOp } from '@pagespace/lib/sheets/sheet';
import {
  queryRows,
  appendRows,
  setCells,
  deleteRows,
  readRows,
  getTab,
  ensureTab,
  listTabs,
  applyFormatOps,
  readTabFormatting,
  MAX_ROW_PAGE_SIZE,
} from '@pagespace/lib/sheets/store';
import { SHEET_FILTER_OPS, SheetQueryError } from '@pagespace/lib/sheets/query';
import { SheetAddressError } from '@pagespace/lib/sheets/store';
import { logSheetCellActivity } from '@/services/api/sheet-activity';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult, getPrincipalAccessLevel } from '@/lib/auth';
import { writeDeniedDetails } from '../write-denied-details';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';

/**
 * Structured access to sheet rows, for agents.
 *
 * The document endpoint can only hand back a whole sheet as text and edit it by
 * A1 address, so an agent asking "which rows are still open" had to pull the
 * entire document into context and filter in the model — untenable once a sheet
 * is a real dataset. These operations read and write rows.
 *
 * `edit-cells` stays on `/api/mcp/documents` for spreadsheet-style editing;
 * this route is the tabular view of the same data.
 *
 * `read-formatting` and `apply-format` are the other half: how the sheet LOOKS.
 * They exist because the in-process AI tools (`read_sheet` with
 * `includeFormatting`, `format_sheet`, `set_conditional_format`) could already
 * read and write regions, conditional rules, freezes and cell formats, while an
 * SDK or CLI caller could do none of it — so a sheet built programmatically was
 * a grid of bare numbers with no call available to change that.
 *
 * `apply-format` takes the `SheetFormatOp` union straight through to
 * `planFormatOps`, which is where EVERY formatting refusal is defined — shape,
 * unknown field, unknown op type, colour, range, cap — and which refuses naming
 * the op's index before any lock is taken. This route deliberately does not
 * restate any of that as a zod union: a second copy would start refusing ops
 * the store accepts the first time one is added to the union. Its only local
 * checks are the two the store cannot make cheaply — that `ops` is present and
 * within `MAX_FORMAT_OPS` — mirroring the payload pre-checks the row writes do
 * for the same reason (see the materialisation note below).
 */

// Seven letters, matching `assertColumn`. A three-letter cap here silently
// re-imposed the limit that was removed there: every column past ZZZ becomes
// unfilterable, unsortable and unprojectable, as a 400 on valid input.
const columnSchema = z.string().regex(/^[A-Za-z]{1,7}$/, 'Column must be letters, e.g. "A" or "AB"');

/**
 * `where` is recursive, and `z.lazy` needs the annotation to terminate. Depth
 * and breadth are bounded again inside `compileWhere` — this shape check is the
 * outer guard, not the only one.
 */
const conditionSchema = z.object({
  column: columnSchema,
  // From the store's own list, not a copy of it — see `SHEET_FILTER_OPS`.
  op: z.enum(SHEET_FILTER_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).optional(),
});

type WhereInput =
  | z.infer<typeof conditionSchema>
  | { and: WhereInput[] }
  | { or: WhereInput[] }
  | { not: WhereInput };

const whereSchema: z.ZodType<WhereInput> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ and: z.array(whereSchema).min(1).max(64) }),
    z.object({ or: z.array(whereSchema).min(1).max(64) }),
    z.object({ not: whereSchema }),
  ])
);

const requestSchema = z.object({
  operation: z.enum([
    'query-rows', 'append-rows', 'update-cells', 'delete-rows', 'get-rows', 'describe',
    'read-formatting', 'apply-format',
  ]),
  pageId: z.string().min(1),
  tabIndex: z.number().int().min(0).optional(),

  where: whereSchema.optional(),
  orderBy: z.array(z.object({
    column: columnSchema,
    direction: z.enum(['asc', 'desc']).optional(),
    numeric: z.boolean().optional(),
  })).max(8).optional(),
  select: z.array(columnSchema).max(64).optional(),
  /** Page size for `query-rows` AND `get-rows`. Not to be confused with `count`. */
  limit: z.number().int().min(1).max(MAX_ROW_PAGE_SIZE).optional(),
  /** `query-rows` only: rows to skip. `get-rows` pages with `fromRow`. */
  offset: z.number().int().min(0).optional(),

  /** append-rows: each entry maps column letter → cell text. */
  rows: z.array(z.record(columnSchema, z.string())).max(5_000).optional(),

  /** update-cells: A1-addressed edits. */
  cells: z.array(z.object({
    address: z.string().regex(/^[A-Za-z]+\d+$/, 'Use A1-style addresses'),
    value: z.string(),
  })).max(10_000).optional(),

  /**
   * `get-rows`: the row index to start at (its page SIZE is `limit`). Named `fromRow` rather than
   * `offset` because it is a POSITION, not a count of skipped rows — a sparse
   * tab (rows 0-9, then 500-509) would make an agent advancing `offset +=
   * rows.length` loop forever on the same rows. `query-rows` takes a true
   * `offset`. Also `delete-rows`.
   */
  fromRow: z.number().int().min(0).optional(),
  /** `delete-rows` only: how many rows to remove. Never a page size. */
  count: z.number().int().min(1).max(100_000).optional(),

  /**
   * `read-formatting`: A1 rectangles whose PER-CELL formats to return. Omitted,
   * none are read — they live on the rows, and reading them for a whole sheet
   * is the O(sheet) read the row store exists to avoid. `readTabFormatting`
   * bounds the total cells across all of them.
   */
  ranges: z.array(z.string().min(1)).max(MAX_FORMAT_OPS).optional(),

  /**
   * `apply-format`: the ordered `SheetFormatOp` list.
   *
   * Deliberately unvalidated HERE beyond its length. `planFormatOps` is the
   * validator — it refuses a non-object, an op with no `type`, an unknown
   * `type`, a field the op does not take, a colour that is not one, a range
   * past the sheet, and every cap, each naming the op's index, all before any
   * lock is taken. A shape check here would decide a subset of that a second
   * time, and would be the copy that starts refusing ops the store accepts.
   *
   * Order is preserved and load-bearing: a `clearCellFormat` after a
   * `setCellFormat` over the same cells means something different from the
   * reverse.
   */
  ops: z.array(z.unknown()).max(MAX_FORMAT_OPS).optional(),
});

const WRITE_OPERATIONS = new Set(['append-rows', 'update-cells', 'delete-rows', 'apply-format']);

export async function POST(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  const allowedDriveIds = isMCPAuthResult(auth) ? auth.allowedDriveIds ?? [] : [];

  try {
    const body = await req.json();
    const input = requestSchema.parse(body);
    const { operation, pageId } = input;

    const page = await db.query.pages.findFirst({ where: eq(pages.id, pageId) });
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // Drive scope before permissions, mirroring the documents route.
    if (allowedDriveIds.length > 0 && !allowedDriveIds.includes(page.driveId)) {
      loggers.api.warn('MCP sheet access denied - drive not in token scope', {
        userId, pageId, pageDriveId: page.driveId, allowedDriveIds,
      });
      return NextResponse.json(
        { error: 'This token does not have access to this drive' },
        { status: 403 }
      );
    }

    const accessLevel = await getPrincipalAccessLevel(auth, pageId);
    if (!accessLevel || !accessLevel.canView) {
      loggers.api.warn('MCP sheet access denied - no view permission', {
        userId, pageId, hasAccessLevel: !!accessLevel, canView: accessLevel?.canView ?? false,
      });
      return new NextResponse('Forbidden', { status: 403 });
    }

    if (WRITE_OPERATIONS.has(operation) && !accessLevel.canEdit) {
      loggers.api.warn('MCP sheet write denied - insufficient permissions', {
        userId, pageId, operation,
      });
      return NextResponse.json(
        {
          error: 'Write permission required',
          details: writeDeniedDetails(operation, 'sheet'),
        },
        { status: 403 }
      );
    }

    if (!isSheetType(page.type as PageType)) {
      return NextResponse.json({
        error: 'Page is not a sheet',
        message: `This page is a ${page.type}. Use /api/mcp/documents for non-sheet pages.`,
        pageType: page.type,
      }, { status: 400 });
    }

    // Payload validation BEFORE any materialisation.
    //
    // `ensureTab` is a write — it can create tabs, rows and dependency edges
    // for a sheet still living in `pages.content`. Running it ahead of the
    // per-operation checks meant a malformed request against an unmigrated
    // sheet mutated storage and then returned 400, with no write audit and no
    // notification for the mutation it had just made.
    if (operation === 'append-rows' && (!input.rows || input.rows.length === 0)) {
      return NextResponse.json({ error: 'rows is required for append-rows' }, { status: 400 });
    }
    if (operation === 'update-cells' && (!input.cells || input.cells.length === 0)) {
      return NextResponse.json({ error: 'cells is required for update-cells' }, { status: 400 });
    }
    if (operation === 'delete-rows' && (input.fromRow === undefined || input.count === undefined)) {
      return NextResponse.json({ error: 'fromRow and count are required for delete-rows' }, { status: 400 });
    }
    if (operation === 'apply-format' && (!input.ops || input.ops.length === 0)) {
      return NextResponse.json({ error: 'ops is required for apply-format' }, { status: 400 });
    }

    const ref = { pageId, tabIndex: input.tabIndex ?? 0 };

    // Reads materialise too, not only writes.
    //
    // A sheet whose data still lives in `pages.content` — created before the
    // row store, or never re-saved, and not covered by the backfill — would
    // otherwise answer `query-rows`/`get-rows`/`describe` with a 409 saying it
    // has no data. An agent reads that as "the spreadsheet is empty" while the
    // data sits intact in the document column, which is a worse answer than
    // being slow. `ensureTab` is idempotent and only does work once.
    let tab = await getTab(ref);
    if (!tab) {
      // Materialising is a WRITE — it inserts tabs, rows and dependency edges
      // and locks the page row. A view-only principal must not trigger it, so
      // a reader without edit rights gets the document-backed answer instead of
      // silently provisioning storage on someone else's sheet.
      if (accessLevel.canEdit) {
        try {
          tab = await ensureTab({ pageId, tabIndex: 0 });
        } catch (error) {
          // `materializeFromDocument` throws deliberately when the stored
          // document cannot be read. Swallowing that produced "this sheet has
          // not been initialised — append rows to create it", advice which then
          // hits the same throw inside `appendRows` and returns 500. Report the
          // real reason so it is actionable.
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('could not be read')) {
            return NextResponse.json({
              error: 'Sheet content could not be read',
              message: `${message} The stored document needs repair before this sheet can be used.`,
            }, { status: 409 });
          }
          throw error;
        }
        if (tab && (ref.tabIndex ?? 0) !== 0) {
          tab = await getTab(ref);
        }
      } else if (!WRITE_OPERATIONS.has(operation)) {
        return NextResponse.json({
          error: 'Sheet not materialised',
          message:
            'This sheet has not been migrated to row storage yet, and read-only access cannot ' +
            'trigger the migration. Read it through /api/mcp/documents, or ask someone with ' +
            'edit access to open it once.',
        }, { status: 409 });
      }
    }
    if (!tab) {
      return NextResponse.json({
        error: operation === 'describe' ? 'Sheet has no tabs yet' : `Sheet tab ${ref.tabIndex} not found`,
        message: 'This sheet has not been initialised. Append rows or edit a cell to create it.',
      }, { status: 409 });
    }

    switch (operation) {
      case 'describe': {
        auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation } });
        const tabs = await listTabs(pageId);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          tabs: tabs.map((entry) => ({
            tabIndex: entry.tabIndex,
            name: entry.name,
            rowCount: entry.rowCount,
            columnCount: entry.columnCount,
            frozenRows: entry.frozenRows,
          })),
        });
      }

      case 'get-rows': {
        auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation } });
        const fromRow = input.fromRow ?? 0;
        const rows = await readRows(tab.id, { fromRow, limit: input.limit });
        const nextFromRow = rows.length > 0 ? rows[rows.length - 1].rowIndex + 1 : null;

        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          tabIndex: ref.tabIndex,
          rows,
          rowCount: tab.rowCount,
          columnCount: tab.columnCount,
          // Where to continue from, so paging a sparse tab terminates instead
          // of returning the same rows forever.
          nextFromRow,
          hasMore: nextFromRow !== null && nextFromRow < tab.rowCount,
        });
      }

      case 'query-rows': {
        auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation } });
        const result = await queryRows(ref, {
          where: input.where,
          orderBy: input.orderBy,
          select: input.select,
          limit: input.limit,
          offset: input.offset,
        });
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          tabIndex: ref.tabIndex,
          ...result,
        });
      }

      case 'append-rows': {
        if (!input.rows || input.rows.length === 0) {
          return NextResponse.json({ error: 'rows is required for append-rows' }, { status: 400 });
        }
        const actorInfo = await getActorInfo(userId);
        const result = await appendRows(ref, input.rows, {
          userId,
          actorEmail: actorInfo.actorEmail,
        });
        await notify(page.driveId, pageId, page.title, page.parentId);
        await logSheetCellActivity({
          pageId, driveId: page.driveId, pageTitle: page.title, userId,
          actorEmail: actorInfo.actorEmail, actorDisplayName: actorInfo.actorDisplayName,
          metadata: { source: 'mcp', mcpOperation: operation, rows: input.rows.length, firstRowIndex: result.firstRowIndex },
        });
        auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation, rows: input.rows.length } });
        return NextResponse.json({ pageId, pageTitle: page.title, ...result });
      }

      case 'update-cells': {
        if (!input.cells || input.cells.length === 0) {
          return NextResponse.json({ error: 'cells is required for update-cells' }, { status: 400 });
        }
        const actorInfo = await getActorInfo(userId);
        const result = await setCells(ref, input.cells, {
          userId,
          actorEmail: actorInfo.actorEmail,
        });
        await notify(page.driveId, pageId, page.title, page.parentId);
        await logSheetCellActivity({
          pageId, driveId: page.driveId, pageTitle: page.title, userId,
          actorEmail: actorInfo.actorEmail, actorDisplayName: actorInfo.actorDisplayName,
          metadata: { source: 'mcp', mcpOperation: operation, cells: input.cells.length, recomputed: result.recomputed.length },
        });
        auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation, cells: input.cells.length } });
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          cellsUpdated: input.cells.length,
          recomputed: result.recomputed.length,
          rowCount: result.rowCount,
          columnCount: result.columnCount,
        });
      }

      case 'delete-rows': {
        if (input.fromRow === undefined || input.count === undefined) {
          return NextResponse.json({ error: 'fromRow and count are required for delete-rows' }, { status: 400 });
        }
        const actorInfo = await getActorInfo(userId);
        const result = await deleteRows(ref, input.fromRow, input.count, {
          userId,
          actorEmail: actorInfo.actorEmail,
        });
        await notify(page.driveId, pageId, page.title, page.parentId);
        await logSheetCellActivity({
          pageId, driveId: page.driveId, pageTitle: page.title, userId,
          actorEmail: actorInfo.actorEmail, actorDisplayName: actorInfo.actorDisplayName,
          metadata: { source: 'mcp', mcpOperation: operation, fromRow: input.fromRow, deleted: result.deleted },
        });
        auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation, fromRow: input.fromRow, count: input.count } });
        return NextResponse.json({ pageId, pageTitle: page.title, ...result });
      }

      case 'read-formatting': {
        auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation } });
        // A pure read: `getTab` rather than `ensureTab`, so an unmigrated
        // sheet is never materialised on the way past. The 409 below should be
        // unreachable — the tab was already resolved for this same ref above —
        // but it is the answer if another writer removed the tab in between,
        // and it matches the 409 the resolution block returns rather than
        // reading as a 500.
        const formatting = await readTabFormatting(ref, { ranges: input.ranges });
        if (!formatting) {
          return NextResponse.json({
            error: `Sheet tab ${ref.tabIndex} not found`,
            message: 'This sheet has not been initialised. Append rows or edit a cell to create it.',
          }, { status: 409 });
        }
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          tabIndex: ref.tabIndex,
          ...formatting,
        });
      }

      case 'apply-format': {
        if (!input.ops || input.ops.length === 0) {
          return NextResponse.json({ error: 'ops is required for apply-format' }, { status: 400 });
        }
        const actorInfo = await getActorInfo(userId);
        // Cast from `unknown[]`, not a narrowing: see the `ops` field's note.
        // `planFormatOps` inside `applyFormatOps` refuses anything that is not
        // an op in the union, by name and by index, before any lock is taken.
        const result = await applyFormatOps(ref, input.ops as readonly SheetFormatOp[], {
          userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName,
          driveId: page.driveId,
          resourceTitle: page.title,
          metadata: { source: 'mcp', mcpOperation: operation, ops: input.ops.length },
        });

        // The store reports a request that changed nothing — a retried call, a
        // bold that was already bold — with no rows touched and no tab field
        // changed, and deliberately bumps no revision for it. Logging an
        // activity entry and broadcasting `content-updated` for that would turn
        // a harmless retry into an observable edit, which is why the AI tool's
        // `applyPlanned` returns early on the same condition.
        const changed = result.rowsTouched > 0 || result.tabFieldsChanged.length > 0;
        if (changed) {
          await notify(page.driveId, pageId, page.title, page.parentId);
          await logSheetCellActivity({
            pageId, driveId: page.driveId, pageTitle: page.title, userId,
            actorEmail: actorInfo.actorEmail, actorDisplayName: actorInfo.actorDisplayName,
            metadata: {
              source: 'mcp', mcpOperation: operation, ops: input.ops.length,
              cellsFormatted: result.cellsFormatted,
              tabFieldsChanged: result.tabFieldsChanged,
              rulesAdded: result.ruleIdsAdded.length,
              rulesRemoved: result.ruleIdsRemoved.length,
              regionsAdded: result.regionIdsAdded.length,
              regionsRemoved: result.regionIdsRemoved.length,
            },
          });
        }
        // Audited either way: the request was authorised and served, and an
        // audit trail that omits the no-op cannot show the attempt was made.
        auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation, ops: input.ops.length, changed } });
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          tabIndex: ref.tabIndex,
          changed,
          ...result,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown operation: ${operation}` }, { status: 400 });
    }
  } catch (error) {
    // A malformed filter is the caller's problem, not a server fault; saying so
    // lets an agent correct itself instead of retrying the same bad query.
    // Every formatting refusal — a bad op shape, an unknown field, a colour
    // that is not one, a range past the sheet, a rule id that does not exist, a
    // cap — arrives as this one class, carrying the op index the caller sent.
    // `SheetDuplicateRuleError` is a subclass and is caught here with it.
    if (error instanceof SheetFormatError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SheetQueryError || error instanceof SheetAddressError) {
      // Caller's problem, not a server fault — an agent that gets 500 has no
      // way to correct itself. `A0` and `A9999999999` both clear the route's
      // address regex and only fail deeper in the store.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    loggers.api.error(
      'MCP sheet operation failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    return NextResponse.json({ error: 'Sheet operation failed' }, { status: 500 });
  }
}

async function notify(
  driveId: string,
  pageId: string,
  title: string,
  parentId: string | null
): Promise<void> {
  await broadcastPageEvent(
    createPageEventPayload(driveId, pageId, 'content-updated', { title, parentId })
  ).catch(() => {
    // A missed live update must not fail the write that already succeeded.
  });
}
