import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { z } from 'zod/v4';
import { PageType } from '@pagespace/lib/utils/enums';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import {
  queryRows,
  appendRows,
  setCells,
  deleteRows,
  readRows,
  getTab,
  ensureTab,
  listTabs,
  MAX_ROW_PAGE_SIZE,
} from '@pagespace/lib/sheets/store';
import { SheetQueryError } from '@pagespace/lib/sheets/query';
import { logSheetCellActivity } from '@/services/api/sheet-activity';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult, getPrincipalAccessLevel } from '@/lib/auth';
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
  op: z.enum([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'startsWith', 'endsWith',
    'isEmpty', 'isNotEmpty', 'in',
  ]),
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
  operation: z.enum(['query-rows', 'append-rows', 'update-cells', 'delete-rows', 'get-rows', 'describe']),
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
});

const WRITE_OPERATIONS = new Set(['append-rows', 'update-cells', 'delete-rows']);

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
          details: `The '${operation}' operation requires edit access to this sheet`,
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
        tab = await ensureTab({ pageId, tabIndex: 0 }).catch(() => null);
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

      default:
        return NextResponse.json({ error: `Unknown operation: ${operation}` }, { status: 400 });
    }
  } catch (error) {
    // A malformed filter is the caller's problem, not a server fault; saying so
    // lets an agent correct itself instead of retrying the same bad query.
    if (error instanceof SheetQueryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    loggers.api.error('MCP sheet operation failed', { error });
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
