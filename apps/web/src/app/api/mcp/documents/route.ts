import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, asc, and, count, isNotNull, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks';
import { channelMessages } from '@pagespace/db/schema/chat';
import { fetchEnrichedTasks, serializeTaskItem } from '@/lib/ai/tools/task-helpers';
import { backfillMissingTaskItems, ensureTaskListForPage, seedDefaultTaskStatusConfigs } from '@/services/api/task-sync-service';
import { computeHasContent } from '@/app/api/pages/[pageId]/tasks/task-utils';
import { PageType } from '@pagespace/lib/utils/enums';
import { isCodePage } from '@pagespace/lib/content/page-types.config';
import { isSheetType, parseSheetContent, serializeSheetContent, updateSheetCells, isValidCellAddress } from '@pagespace/lib/sheets/sheet';
import { z } from 'zod/v4';
import { addLineBreaksForAI } from '@/lib/editor/line-breaks';
import { serializePageContentForAI } from '@/lib/ai/core/page-serializer';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult, getPrincipalAccessLevel } from '@/lib/auth';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';

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

// Extract display text from a channel message's JSON content, mirroring the
// internal read_page CHANNEL handling so MCP transcripts match exactly.
function extractChannelMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      originalContent?: unknown;
      parts?: Array<{ type?: string; text?: string }>;
      textParts?: string[];
    };

    if (typeof parsed.originalContent === 'string') {
      return parsed.originalContent;
    }

    if (Array.isArray(parsed.parts)) {
      const textParts = parsed.parts
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text as string);
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }

    if (Array.isArray(parsed.textParts)) {
      return parsed.textParts.join('\n');
    }
  } catch {
    // Fall through and return raw content
  }

  return content;
}

interface ChannelMessageForSender {
  userId: string | null;
  user?: { id: string; name: string | null } | null;
  aiMeta?: { senderType?: string; senderName?: string } | null;
}

function getChannelSenderInfo(message: ChannelMessageForSender) {
  const senderName = message.aiMeta?.senderName || message.user?.name || 'Unknown';

  if (message.aiMeta?.senderType === 'agent') {
    return { senderType: 'agent' as const, senderName, prefix: '[agent]' };
  }

  if (message.aiMeta?.senderType === 'global_assistant') {
    return { senderType: 'global_assistant' as const, senderName, prefix: '[assistant]' };
  }

  return { senderType: 'user' as const, senderName, prefix: '[user]' };
}

// Schema for cell updates
const cellUpdateSchema = z.object({
  address: z.string(),
  value: z.string(),
});

// Schema for line/cell operations. pageId is required — MCP tools must always
// name their target page explicitly (no silent "current page" fallback).
const lineOperationSchema = z.object({
  operation: z.enum(['read', 'replace', 'insert', 'delete', 'edit-cells']),
  pageId: z.string(),
  startLine: z.number().min(1).optional(),
  endLine: z.number().min(1).optional(),
  content: z.string().optional(),
  cells: z.array(cellUpdateSchema).optional(),
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
    const { operation, pageId, startLine, endLine, content, cells } = lineOperationSchema.parse(body);

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

    // Guardrails for line-based write operations, mirroring the internal
    // replace_lines tool exactly: FILE pages are read-only (system-managed
    // extraction), and SHEET pages use structured cell data, not lines.
    if (operation === 'replace' || operation === 'insert' || operation === 'delete') {
      if (page.type === PageType.FILE) {
        return NextResponse.json({
          error: 'Cannot edit FILE pages',
          message: 'This is an uploaded file. File content is read-only and managed by the system.',
          suggestion: 'To modify content, create a new document page instead of editing the uploaded file.',
          pageInfo: { pageId: page.id, title: page.title, type: page.type, mimeType: page.mimeType },
        }, { status: 400 });
      }

      if (isSheetType(page.type as PageType)) {
        return NextResponse.json({
          error: 'Cannot use line editing on sheets',
          message: 'Sheet pages use structured cell data. Use the edit-cells operation instead for cell-level edits.',
          suggestion: 'Use operation: "edit-cells" with cell addresses (A1, B2, etc.) to modify sheet content.',
          pageInfo: { pageId: page.id, title: page.title, type: page.type },
        }, { status: 400 });
      }
    }

    const rawContent = page.content || '';

    // CODE and markdown pages have natural line structure (and CODE may
    // contain raw HTML/XML that addLineBreaksForAI would mangle); HTML
    // documents are normalized. Shared with the internal read_page/
    // replace_lines tools via serializePageContentForAI so both surfaces
    // agree on line numbers.
    const isRawText = page.contentMode === 'markdown' || isCodePage(page.type as PageType);
    const serializedContent = serializePageContentForAI(page);
    const lines = serializedContent.split('\n');

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

          // Legacy task_lists row (e.g. seeded by a pre-fix lazy-init path) with no
          // configs — backfill now instead of leaving it half-initialized forever.
          // Best-effort: this read already has a correct in-memory fallback
          // (DEFAULT_TASK_STATUSES below), so a transient backfill failure must not
          // fail the whole read — it'll simply retry on the next read of this page.
          if (statusConfigs.length === 0) {
            try {
              await seedDefaultTaskStatusConfigs(db, taskList.id);
            } catch (error) {
              loggers.api.error('Failed to backfill default task status configs', error as Error);
            }
          }

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

          // Resolve parent task list (if this list is nested under another task).
          let parentTaskList: { pageId: string; title: string; taskListId: string } | null = null;
          if (page.parentId) {
            const parentPage = await db.query.pages.findFirst({
              where: and(eq(pages.id, page.parentId), eq(pages.isTrashed, false)),
              columns: { id: true, title: true, type: true },
            });
            if (parentPage?.type === PageType.TASK_LIST) {
              const parentList = await db.query.taskLists.findFirst({
                where: eq(taskLists.pageId, parentPage.id),
                columns: { id: true },
              });
              if (parentList) {
                parentTaskList = { pageId: parentPage.id, title: parentPage.title, taskListId: parentList.id };
              }
            }
          }

          // Batch sub-task counts (total + completed) per task page.
          const taskPageIds = tasks.map(t => t.pageId).filter((id): id is string => !!id);
          const subTaskCountMap = new Map<string, number>();
          const subTaskCompletedMap = new Map<string, number>();
          if (taskPageIds.length > 0) {
            const baseWhere = and(inArray(pages.parentId, taskPageIds), eq(pages.isTrashed, false));
            const [subTaskRows, completedRows] = await Promise.all([
              db
                .select({ parentId: pages.parentId, total: count() })
                .from(taskItems)
                .innerJoin(pages, eq(pages.id, taskItems.pageId))
                .where(baseWhere)
                .groupBy(pages.parentId),
              db
                .select({ parentId: pages.parentId, total: count() })
                .from(taskItems)
                .innerJoin(pages, eq(pages.id, taskItems.pageId))
                .where(and(baseWhere, isNotNull(taskItems.completedAt)))
                .groupBy(pages.parentId),
            ]);
            for (const row of subTaskRows) {
              if (row.parentId) subTaskCountMap.set(row.parentId, Number(row.total));
            }
            for (const row of completedRows) {
              if (row.parentId) subTaskCompletedMap.set(row.parentId, Number(row.total));
            }
          }

          // A TASK_LIST page also has its own content body (e.g. an
          // individual task page whose body holds the description / sub-tasks).
          // This body belongs to `pageId` itself — already authorized above —
          // so it is safe to return. Render both the body and the task view.
          const numberedLines = getNumberedLines(serializedContent);

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
            parentTaskList,
            totalLines: lines.length,
            numberedLines,
            content: serializedContent,
            tasks: tasks.map(t => ({
              ...serializeTaskItem(t),
              hasContent: computeHasContent(t.page?.content),
              subTaskCount: subTaskCountMap.get(t.pageId ?? '') ?? 0,
              subTaskCompletedCount: subTaskCompletedMap.get(t.pageId ?? '') ?? 0,
            })),
            availableStatuses,
            progress: {
              total: totalTasks,
              percentage: progressPercentage,
              byGroup,
              bySlug,
            },
          });
        }

        // Validate line range parameters (shared by CHANNEL and the generic
        // text path below).
        if (startLine !== undefined && startLine < 1) {
          return NextResponse.json({ error: 'Invalid line range: line numbers must be positive integers' }, { status: 400 });
        }
        if (endLine !== undefined && endLine < 1) {
          return NextResponse.json({ error: 'Invalid line range: line numbers must be positive integers' }, { status: 400 });
        }
        if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
          return NextResponse.json({ error: `Invalid line range: startLine (${startLine}) cannot be greater than endLine (${endLine})` }, { status: 400 });
        }

        const isRangeRequest = startLine !== undefined || endLine !== undefined;

        if (page.type === PageType.CHANNEL) {
          const messages = await db.query.channelMessages.findMany({
            where: and(
              eq(channelMessages.pageId, page.id),
              eq(channelMessages.isActive, true)
            ),
            with: {
              user: {
                columns: { id: true, name: true },
              },
            },
            orderBy: [asc(channelMessages.createdAt)],
          });

          const totalMessages = messages.length;

          if (totalMessages === 0) {
            return NextResponse.json({
              pageId,
              pageTitle: page.title,
              pageType: 'CHANNEL',
              totalLines: 0,
              numberedLines: [],
              content: '',
              messageCount: 0,
              totalMessages: 0,
            });
          }

          const effectiveStart = startLine ?? 1;
          const effectiveEnd = endLine !== undefined ? Math.min(endLine, totalMessages) : totalMessages;

          if (effectiveStart > totalMessages) {
            return NextResponse.json({
              pageId,
              pageTitle: page.title,
              pageType: 'CHANNEL',
              totalLines: totalMessages,
              numberedLines: [],
              content: '',
              messageCount: 0,
              totalMessages,
              rangeStart: effectiveStart,
              rangeEnd: effectiveEnd,
              rangeMessage: `Requested range (${effectiveStart}-${endLine ?? totalMessages}) is beyond channel length (${totalMessages} messages)`,
            });
          }

          const selectedMessages = messages.slice(effectiveStart - 1, effectiveEnd);

          const numberedLines = selectedMessages.map((message, index) => {
            const lineNumber = effectiveStart + index;
            const sender = getChannelSenderInfo(message);
            const timestamp = message.createdAt.toISOString();
            const text = extractChannelMessageText(message.content);
            return `${lineNumber.toString().padStart(4, ' ')} | ${sender.prefix} ${sender.senderName} (${timestamp}): ${text}`;
          });

          const channelContent = selectedMessages.map(message => {
            const sender = getChannelSenderInfo(message);
            const timestamp = message.createdAt.toISOString();
            const text = extractChannelMessageText(message.content);
            return `${sender.prefix} ${sender.senderName} (${timestamp}): ${text}`;
          }).join('\n');

          return NextResponse.json({
            pageId,
            pageTitle: page.title,
            pageType: 'CHANNEL',
            totalLines: totalMessages,
            numberedLines,
            content: channelContent,
            messageCount: selectedMessages.length,
            totalMessages,
            ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
          });
        }

        // FILE pages: surface processing status instead of falling through to
        // (empty/partial) raw content. 'completed' falls through to the
        // generic text path below, with fileMetadata attached.
        if (page.type === PageType.FILE) {
          if (page.processingStatus === 'pending' || page.processingStatus === 'processing') {
            return NextResponse.json({
              pageId,
              pageTitle: page.title,
              pageType: 'FILE',
              status: page.processingStatus,
              error: 'File is still being processed',
              suggestion: 'Please try again in a moment',
            });
          }

          if (page.processingStatus === 'failed') {
            return NextResponse.json({
              pageId,
              pageTitle: page.title,
              pageType: 'FILE',
              status: page.processingStatus,
              error: 'Failed to extract content from this file',
              processingError: page.processingError,
              suggestion: 'Try reprocessing the file or contact support',
            });
          }

          if (page.processingStatus === 'visual') {
            return NextResponse.json({
              pageId,
              pageTitle: page.title,
              pageType: 'FILE',
              status: page.processingStatus,
              message: `This is a visual file (${page.mimeType || 'image'}). Vision-capable processing is required to interpret its content.`,
              fileMetadata: {
                mimeType: page.mimeType,
                fileSize: page.fileSize,
                originalFileName: page.originalFileName,
                processingStatus: page.processingStatus,
              },
            });
          }
        }

        const fileMetadata = page.type === PageType.FILE ? {
          mimeType: page.mimeType,
          fileSize: page.fileSize,
          originalFileName: page.originalFileName,
          processingStatus: page.processingStatus,
          extractionMethod: page.extractionMethod,
          extractionMetadata: page.extractionMetadata,
        } : undefined;

        const totalLines = lines.length;
        const effectiveStart = startLine ?? 1;
        const effectiveEnd = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;

        if (effectiveStart > totalLines) {
          return NextResponse.json({
            pageId,
            pageTitle: page.title,
            totalLines,
            numberedLines: [],
            content: '',
            rangeStart: effectiveStart,
            rangeEnd: effectiveEnd,
            rangeMessage: `Requested range (${effectiveStart}-${endLine ?? totalLines}) is beyond document length (${totalLines} lines)`,
          });
        }

        const selectedLines = lines.slice(effectiveStart - 1, effectiveEnd);
        const numberedLines = selectedLines.map((line, index) => `${(effectiveStart + index).toString().padStart(4, ' ')} | ${line}`);
        const rangeContent = selectedLines.join('\n');

        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines,
          numberedLines,
          content: rangeContent,
          ...(fileMetadata && { fileMetadata }),
          ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
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

        const joined = newLines.join('\n');
        const newContent = isRawText ? joined : addLineBreaksForAI(joined);

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

        const joined = newLines.join('\n');
        const newContent = isRawText ? joined : addLineBreaksForAI(joined);

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

        const joined = newLines.join('\n');
        const newContent = isRawText ? joined : addLineBreaksForAI(joined);

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
        const sheetData = parseSheetContent(rawContent);

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
