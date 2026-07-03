import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, asc, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks';
import { fetchEnrichedTasks, serializeTaskItem } from '@/lib/ai/tools/task-helpers';
import { backfillMissingTaskItems, ensureTaskListForPage } from '@/services/api/task-sync-service';
import { computeHasContent } from '@/app/api/pages/[pageId]/tasks/task-utils';
import { PageType } from '@pagespace/lib/utils/enums';
import { isSheetType, parseSheetContent, serializeSheetContent, updateSheetCells, isValidCellAddress } from '@pagespace/lib/sheets/sheet';
import { z } from 'zod/v4';
import { addLineBreaksForAI } from '@/lib/editor/line-breaks';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult, getPrincipalAccessLevel } from '@/lib/auth';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';

// Get the current page ID for the user
async function getCurrentPageId(userId: string): Promise<string | null> {
  try {
    // For now, we'll get the user's most recently modified page
    // In a future iteration, we might track the "active" page differently
    const userPage = await db.query.pages.findFirst({
      where: (pages, { isNull }) => isNull(pages.isTrashed),
      with: {
        drive: true,
      },
      orderBy: (pages, { desc }) => [desc(pages.updatedAt)],
    });
    
    // Filter for pages owned by the user
    if (userPage && userPage.drive.ownerId === userId) {
      return userPage.id;
    }
    
    return null;
  } catch (error) {
    loggers.api.error('Error getting current page:', error as Error);
    return null;
  }
}

// Get drive slug from page for socket broadcasting
async function getDriveIdFromPage(pageId: string): Promise<string | null> {
  try {
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: true,
      },
    });
    
    return page?.drive?.id || null;
  } catch (error) {
    loggers.api.error('Error getting drive id:', error as Error);
    return null;
  }
}


// Split content into lines and add line numbers
function getNumberedLines(content: string): string[] {
  const lines = content.split('\n');
  return lines.map((line, index) => `${(index + 1).toString().padStart(4, ' ')} | ${line}`);
}

// Schema for cell updates
const cellUpdateSchema = z.object({
  address: z.string(),
  value: z.string(),
});

// Schema for line/cell operations
const lineOperationSchema = z.object({
  operation: z.enum(['read', 'replace', 'insert', 'delete', 'edit-cells']),
  pageId: z.string().optional(), // Optional page ID, will use current page if not provided
  startLine: z.number().min(1).optional(),
  endLine: z.number().min(1).optional(),
  content: z.string().optional(),
  cells: z.array(cellUpdateSchema).optional(), // For edit-cells operation
});

export async function POST(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  // Get allowed drive IDs from token scope (empty means no restrictions)
  let allowedDriveIds: string[] = [];
  if (isMCPAuthResult(auth)) {
    allowedDriveIds = auth.allowedDriveIds ?? [];
  }

  try {
    const body = await req.json();
    const { operation, pageId: providedPageId, startLine, endLine, content, cells } = lineOperationSchema.parse(body);

    // Get the page ID (use provided or get current)
    const pageId = providedPageId || await getCurrentPageId(userId);

    if (!pageId) {
      return NextResponse.json({ error: 'No active document found' }, { status: 404 });
    }

    // Check drive scope restrictions before permission check
    if (allowedDriveIds.length > 0) {
      // Get the page's drive ID to check scope
      const pageInfo = await db.query.pages.findFirst({
        where: eq(pages.id, pageId),
        columns: { driveId: true },
      });

      if (!pageInfo) {
        return NextResponse.json({ error: 'Page not found' }, { status: 404 });
      }

      if (!allowedDriveIds.includes(pageInfo.driveId)) {
        loggers.api.warn('MCP document access denied - drive not in token scope', {
          userId,
          pageId,
          pageDriveId: pageInfo.driveId,
          allowedDriveIds,
        });
        return NextResponse.json(
          { error: 'This token does not have access to this drive' },
          { status: 403 }
        );
      }
    }

    // Scoped tokens use their own drive membership role; unscoped tokens fall back to user permissions.
    const accessLevel = await getPrincipalAccessLevel(auth, pageId);
    if (!accessLevel || !accessLevel.canView) {
      loggers.api.warn('MCP document access denied - no view permission', {
        userId,
        pageId,
        hasAccessLevel: !!accessLevel,
        canView: accessLevel?.canView ?? false
      });
      return new NextResponse('Forbidden', { status: 403 });
    }

    // Validate write permissions for mutating operations
    if (operation === 'replace' || operation === 'insert' || operation === 'delete' || operation === 'edit-cells') {
      if (!accessLevel.canEdit) {
        loggers.api.warn('MCP write operation denied - insufficient permissions', {
          userId,
          pageId,
          operation,
          permissions: accessLevel
        });
        return NextResponse.json(
          {
            error: 'Write permission required',
            details: `The '${operation}' operation requires edit access to this document`
          },
          { status: 403 }
        );
      }
    }

    // Fetch the page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });
    
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
    
    const currentContent = page.content || '';
    const lines = currentContent.split('\n');
    
    switch (operation) {
      case 'read': {
        auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation: 'read' } });

        if (page.type === PageType.TASK_LIST) {
          const taskList = await ensureTaskListForPage(db, {
            pageId,
            title: page.title,
            userId,
            metadata: {
              createdAt: new Date().toISOString(),
              autoCreated: true,
            },
          });

          // Self-heal: ensure every child TASK_LIST page has a task_items row.
          // Mirrors the same call in /api/pages/[pageId]/tasks/route.ts:143.
          const childPages = await db
            .select({ id: pages.id })
            .from(pages)
            .where(and(
              eq(pages.parentId, pageId),
              eq(pages.type, PageType.TASK_LIST),
              eq(pages.isTrashed, false),
            ));
          const childPageIds = childPages.map(p => p.id);
          if (childPageIds.length > 0) {
            await backfillMissingTaskItems(db, { parentId: pageId, childPageIds, userId });
          }

          const [tasks, statusConfigs] = await Promise.all([
            fetchEnrichedTasks(pageId),
            db.query.taskStatusConfigs.findMany({
              where: eq(taskStatusConfigs.taskListId, taskList.id),
              orderBy: [asc(taskStatusConfigs.position)],
            }),
          ]);

          const availableStatuses = statusConfigs.length > 0
            ? statusConfigs.map(c => ({ slug: c.slug, label: c.name, group: c.group, position: c.position, color: c.color }))
            : DEFAULT_TASK_STATUSES.map(s => ({ slug: s.slug, label: s.name, group: s.group, position: s.position, color: s.color }));

          const slugToGroup = new Map(availableStatuses.map(s => [s.slug, s.group]));

          const totalTasks = tasks.length;
          const byGroup: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
          const bySlug: Record<string, number> = {};
          for (const t of tasks) {
            bySlug[t.status] = (bySlug[t.status] || 0) + 1;
            const group = slugToGroup.get(t.status)
              || (t.completedAt ? 'done' : t.status === 'in_progress' || t.status === 'blocked' ? 'in_progress' : 'todo');
            byGroup[group] = (byGroup[group] || 0) + 1;
          }
          const completedCount = byGroup.done || 0;
          const progressPercentage = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0;

          // A TASK_LIST page also has its own content body (e.g. an
          // individual task page whose body holds the description / sub-tasks).
          // This body belongs to `pageId` itself — already authorized above —
          // so it is safe to return. Render both the body and the task view.
          const numberedLines = getNumberedLines(currentContent);

          // Each task is a child TASK_LIST page. Page permissions do NOT inherit
          // to children, and this route only authorizes `pageId`, so we must NOT
          // return child page bodies here. Mirror the canonical task-list API
          // (GET /api/pages/[pageId]/tasks) which exposes only a `hasContent`
          // boolean — read_page the individual task to view its description.
          return NextResponse.json({
            pageId,
            pageTitle: page.title,
            pageType: 'TASK_LIST',
            taskListId: taskList.id,
            totalLines: lines.length,
            numberedLines,
            content: currentContent,
            tasks: tasks.map(t => ({ ...serializeTaskItem(t), hasContent: computeHasContent(t.page?.content) })),
            availableStatuses,
            progress: {
              total: totalTasks,
              percentage: progressPercentage,
              byGroup,
              bySlug,
            },
          });
        }

        const numberedLines = getNumberedLines(currentContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: lines.length,
          numberedLines,
          content: currentContent,
        });
      }
      
      case 'replace': {
        if (!startLine || !content) {
          return NextResponse.json({ error: 'startLine and content are required for replace' }, { status: 400 });
        }
        
        const actualEndLine = endLine || startLine;
        
        if (startLine > lines.length || actualEndLine > lines.length) {
          return NextResponse.json({ error: 'Line number out of range' }, { status: 400 });
        }
        
        // Replace lines (convert to 0-based index)
        const newLines = [
          ...lines.slice(0, startLine - 1),
          ...content.split('\n'),
          ...lines.slice(actualEndLine),
        ];
        
        const newContent = addLineBreaksForAI(newLines.join('\n'));
        
        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            metadata: {
              source: 'mcp',
              mcpOperation: 'replace',
              affectedLines: `${startLine}-${actualEndLine}`,
            },
          },
        });
        
        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }

        auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation: 'replace' } });

        const numberedLines = getNumberedLines(newContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: newLines.length,
          numberedLines,
          operation: 'replace',
          affectedLines: `${startLine}-${actualEndLine}`,
        });
      }
      
      case 'insert': {
        if (!startLine || !content) {
          return NextResponse.json({ error: 'startLine and content are required for insert' }, { status: 400 });
        }

        // Insert at line (convert to 0-based index)
        const insertIndex = Math.min(startLine - 1, lines.length);
        const newLines = [
          ...lines.slice(0, insertIndex),
          ...content.split('\n'),
          ...lines.slice(insertIndex),
        ];

        const newContent = addLineBreaksForAI(newLines.join('\n'));

        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            metadata: {
              source: 'mcp',
              mcpOperation: 'insert',
              insertedAt: startLine,
              linesInserted: content.split('\n').length,
            },
          },
        });

        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }

        auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation: 'insert' } });

        const numberedLines = getNumberedLines(newContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: newLines.length,
          numberedLines,
          operation: 'insert',
          insertedAt: startLine,
        });
      }
      
      case 'delete': {
        if (!startLine) {
          return NextResponse.json({ error: 'startLine is required for delete' }, { status: 400 });
        }

        const actualEndLine = endLine || startLine;

        if (startLine > lines.length || actualEndLine > lines.length) {
          return NextResponse.json({ error: 'Line number out of range' }, { status: 400 });
        }

        // Delete lines (convert to 0-based index)
        const newLines = [
          ...lines.slice(0, startLine - 1),
          ...lines.slice(actualEndLine),
        ];

        const newContent = addLineBreaksForAI(newLines.join('\n'));

        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            metadata: {
              source: 'mcp',
              mcpOperation: 'delete',
              deletedLines: `${startLine}-${actualEndLine}`,
            },
          },
        });

        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }

        auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation: 'delete' } });

        const numberedLines = getNumberedLines(newContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: newLines.length,
          numberedLines,
          operation: 'delete',
          deletedLines: `${startLine}-${actualEndLine}`,
        });
      }

      case 'edit-cells': {
        // Validate this is a SHEET type page
        if (!isSheetType(page.type as PageType)) {
          return NextResponse.json({
            error: 'Page is not a sheet',
            message: `This page is a ${page.type}. Use edit-cells only on SHEET pages.`,
            pageType: page.type,
          }, { status: 400 });
        }

        if (!cells || cells.length === 0) {
          return NextResponse.json({ error: 'cells array is required for edit-cells operation' }, { status: 400 });
        }

        // Validate all cell addresses
        const invalidAddresses = cells.filter(cell => !isValidCellAddress(cell.address));
        if (invalidAddresses.length > 0) {
          const examples = invalidAddresses.slice(0, 3).map(c => `"${c.address}"`).join(', ');
          return NextResponse.json({
            error: `Invalid cell addresses: ${examples}. Use A1-style format (e.g., A1, B2, AA100).`,
          }, { status: 400 });
        }

        // Parse existing sheet content
        const sheetData = parseSheetContent(currentContent);

        // Apply cell updates
        const updatedSheet = updateSheetCells(sheetData, cells);

        // Serialize back to TOML format
        const newContent = serializeSheetContent(updatedSheet, { pageId });

        // Summarize changes for response and metadata
        const formulaCount = cells.filter(c => c.value.trim().startsWith('=')).length;
        const valueCount = cells.filter(c => c.value.trim() !== '' && !c.value.trim().startsWith('=')).length;
        const clearCount = cells.filter(c => c.value.trim() === '').length;

        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName,
            metadata: {
              source: 'mcp',
              mcpOperation: 'edit-cells',
              cellsUpdated: cells.length,
              valuesSet: valueCount,
              formulasSet: formulaCount,
              cellsCleared: clearCount,
            },
          },
        });

        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }

        auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation: 'edit-cells', cellsUpdated: cells.length } });

        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          cellsUpdated: cells.length,
          operation: 'edit-cells',
          stats: {
            valuesSet: valueCount,
            formulasSet: formulaCount,
            cellsCleared: clearCount,
            sheetDimensions: {
              rows: updatedSheet.rowCount,
              columns: updatedSheet.columnCount,
            },
          },
          updatedCells: cells.map(c => ({
            address: c.address.toUpperCase(),
            type: c.value.trim() === '' ? 'cleared' : c.value.trim().startsWith('=') ? 'formula' : 'value',
          })),
        });
      }

      default:
        return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
    }
  } catch (error) {
    loggers.api.error('Error in MCP document operation:', error as Error);
    if (error instanceof PageRevisionMismatchError) {
      return NextResponse.json(
        {
          error: error.message,
          currentRevision: error.currentRevision,
          expectedRevision: error.expectedRevision,
        },
        { status: error.expectedRevision === undefined ? 428 : 409 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to perform document operation' }, { status: 500 });
  }
}
