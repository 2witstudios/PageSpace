import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, asc, and, count, isNotNull, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks';
import { channelMessages } from '@pagespace/db/schema/chat';
import { fetchEnrichedTasks, serializeTaskItem } from '@/lib/ai/tools/task-helpers';
import { backfillMissingTaskItems, ensureTaskListForPage, seedInheritedTaskStatusConfigs } from '@/services/api/task-sync-service';
import { computeHasContent } from '@/app/api/pages/[pageId]/tasks/task-utils';
import { PageType } from '@pagespace/lib/utils/enums';
import { isSheetType, isValidCellAddress } from '@pagespace/lib/sheets/sheet';
import { setCells, readSheetDocument, SheetAddressError } from '@pagespace/lib/sheets/store';
import { logSheetCellActivity } from '@/services/api/sheet-activity';
import { z } from 'zod/v4';
import { deleteLines, insertLines, LineRangeError, replaceLines, type LineEditResult } from '@/lib/editor/line-edit';
import { describeContentModeMismatch, isRawTextPage, serializePageContentForAI } from '@/lib/ai/core/page-serializer';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult, getPrincipalAccessLevel } from '@/lib/auth';
import { writeDeniedDetails } from '../write-denied-details';
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


type LineEditOutcome =
  | { ok: true; edit: LineEditResult }
  | { ok: false; response: NextResponse };

/**
 * Run a line edit, turning its failures into the right HTTP answer. A crippled
 * edit that reports success is the worst outcome here (#2463): an out-of-range
 * address is a 400, and an edit addressed against a document length the caller
 * no longer has is a 409 naming both counts. Anything else is a real fault and
 * rethrows to the 500 handler.
 */
function runLineEdit(compute: () => LineEditResult, totalLines: number): LineEditOutcome {
  try {
    return { ok: true, edit: compute() };
  } catch (error) {
    if (!(error instanceof LineRangeError)) throw error;
    return {
      ok: false,
      response: NextResponse.json({
        error: error.kind === 'stale' ? 'Document changed since it was read' : 'Line number out of range',
        message: error.message,
        totalLines,
        suggestion: 'Re-read the page with operation: "read" and re-address the edit.',
      }, { status: error.kind === 'stale' ? 409 : 400 }),
    };
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
  // Optional staleness guard for write operations: the totalLines the caller
  // read before addressing this edit. Supplying it turns "the document grew
  // since I looked" from a silent partial overwrite into a 409.
  expectedTotalLines: z.number().int().min(0).optional(),
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
    const { operation, pageId, startLine, endLine, content, cells, expectedTotalLines } = lineOperationSchema.parse(body);

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
            details: writeDeniedDetails(operation, 'document')
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

    // CODE and markdown pages have natural line structure (and CODE may
    // contain raw HTML/XML that addLineBreaksForAI would mangle); HTML
    // documents are normalized. Shared with the internal read_page/
    // replace_lines tools via serializePageContentForAI so both surfaces
    // agree on line numbers.
    const isRawText = isRawTextPage(page);

    // Sheets serialise from their rows — `pages.content` is empty for a
    // materialised sheet, so reading the column would return a blank grid.
    //
    // Only for operations that actually read the text. Building the projection
    // unconditionally made `edit-cells` stream every row and serialise the
    // whole document just to compute line numbers it never looks at,
    // reintroducing the O(document) cost per addressed write on exactly the
    // large sheets this exists to avoid.
    const needsDocumentText = operation !== 'edit-cells';
    const readablePage =
      needsDocumentText && isSheetType(page.type as PageType)
        ? { ...page, content: (await readSheetDocument(pageId)) ?? page.content }
        : page;
    const serializedContent = serializePageContentForAI(readablePage);
    const lines = serializedContent.split('\n');
    // Surfaced on every read and every write: an html-mode page that holds raw
    // JSON or markdown numbers its lines by its own newlines, and the agent
    // editing it deserves to know that before it writes HTML into it (#2463).
    const contentModeWarning = describeContentModeMismatch(readablePage);

    switch (operation) {
      case 'read': {
        auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { source: 'mcp', operation: 'read' } });

        if (page.type === PageType.TASK_LIST) {
          // In a transaction: ensureTaskListForPage's create branch seeds the
          // vocabulary and then conforms any rows already under the page, and a
          // page CAN hold task rows with no task_lists row of its own — there is
          // no foreign key between them, only pages.parentId. Committing the
          // configs without the conform is permanent, since the repair below
          // only fires while the vocabulary is empty.
          const taskList = await db.transaction((tx) => ensureTaskListForPage(tx, {
            pageId,
            title: page.title,
            userId,
            metadata: {
              createdAt: new Date().toISOString(),
              autoCreated: true,
            },
          }));

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

          // Both are re-read after the repair below, which writes twice.
          let [tasks, statusConfigs] = await Promise.all([
            fetchEnrichedTasks(pageId),
            // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
            db.query.taskStatusConfigs.findMany({
              where: eq(taskStatusConfigs.taskListId, taskList.id),
              orderBy: [asc(taskStatusConfigs.position)],
            }),
          ]);

          // Legacy task_lists row (e.g. seeded by a pre-fix lazy-init path) with no
          // configs — backfill now instead of leaving it half-initialized forever.
          //
          // INHERITED, not defaults, and the same call the web route makes. This
          // repair only fires while the vocabulary is empty, so whichever client
          // touches the page first decides it permanently: an agent reading a
          // sub-task before anyone opens it in the UI would otherwise stamp the
          // four built-ins onto a list whose ancestor defines its own, and every
          // later PATCH against an inherited slug 400s.
          //
          // In ONE transaction, as the create-path seed above now is too. Both
          // run the same two-write sequence, and "a list being created has no
          // rows to conform" — which stood here — is a claim about legacy data
          // that nothing establishes: task_items are tied to their list only
          // through pages.parentId, with no foreign key to task_lists, so a page
          // can hold task rows while its own task_lists row is missing. That is
          // precisely the half-initialised state these read paths exist to find.
          //
          // Here the seed inserts the configs and then conforms
          // any rows already in the list to them, and this repair only ever
          // runs while the vocabulary is empty — so a half-applied repair is a
          // permanent one: the configs commit, the rows keep slugs the list no
          // longer defines, and no later read comes back for them. There is no
          // "it'll retry next time" here, whatever an earlier comment claimed.
          //
          // Still best-effort at the outer level: this read has a correct
          // in-memory fallback, so a failed repair must not fail the read.
          if (statusConfigs.length === 0) {
            try {
              await db.transaction((tx) =>
                seedInheritedTaskStatusConfigs(tx, taskList.id, pageId));
              // Re-read BOTH. The repair seeds the vocabulary and then conforms
              // the rows to it, and everything above was read before either.
              // Reporting the new vocabulary beside the old statuses would name
              // slugs the response itself says do not exist.
              [tasks, statusConfigs] = await Promise.all([
                fetchEnrichedTasks(pageId),
                // eslint-disable-next-line no-restricted-syntax -- unbounded on purpose: the read it replaces is unbounded, and the seeding path it re-reads no longer caps either. Reporting 200 of a 260-status vocabulary beside rows the sweep just moved to a slug at position 259 names statuses the same response says do not exist.
                db.query.taskStatusConfigs.findMany({
                  where: eq(taskStatusConfigs.taskListId, taskList.id),
                  orderBy: [asc(taskStatusConfigs.position)],
                }),
              ]);
            } catch (error) {
              loggers.api.error('Failed to backfill inherited task status configs', error as Error);
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
          // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
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
          ...(contentModeWarning && { contentModeWarning }),
        });
      }

      case 'replace': {
        if (!startLine || !content) {
          return NextResponse.json({ error: 'startLine and content are required for replace' }, { status: 400 });
        }

        const actualEndLine = endLine || startLine;

        // One shared line-accounting rule with the in-app replace_lines tool
        // (`@/lib/editor/line-edit`): the content it returns is already the
        // canonical projection, so this route no longer re-normalizes what it
        // stores and no longer reports a count taken before that pass.
        const outcome = runLineEdit(() => replaceLines({
          content: serializedContent,
          startLine,
          endLine: actualEndLine,
          replacement: content,
          isRawText,
          expectedTotalLines,
        }), lines.length);
        if (!outcome.ok) return outcome.response;
        const { edit } = outcome;
        const newContent = edit.newContent;

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
          totalLines: edit.newLineCount,
          previousTotalLines: edit.previousLineCount,
          numberedLines,
          operation: 'replace',
          affectedLines: `${startLine}-${actualEndLine}`,
          ...(contentModeWarning && { contentModeWarning }),
        });
      }

      case 'insert': {
        if (!startLine || !content) {
          return NextResponse.json({ error: 'startLine and content are required for insert' }, { status: 400 });
        }

        const outcome = runLineEdit(() => insertLines({
          content: serializedContent,
          startLine,
          insertion: content,
          isRawText,
          expectedTotalLines,
        }), lines.length);
        if (!outcome.ok) return outcome.response;
        const { edit } = outcome;
        const newContent = edit.newContent;

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
          totalLines: edit.newLineCount,
          previousTotalLines: edit.previousLineCount,
          numberedLines,
          operation: 'insert',
          insertedAt: startLine,
          ...(contentModeWarning && { contentModeWarning }),
        });
      }

      case 'delete': {
        if (!startLine) {
          return NextResponse.json({ error: 'startLine is required for delete' }, { status: 400 });
        }

        const actualEndLine = endLine || startLine;

        const outcome = runLineEdit(() => deleteLines({
          content: serializedContent,
          startLine,
          endLine: actualEndLine,
          isRawText,
          expectedTotalLines,
        }), lines.length);
        if (!outcome.ok) return outcome.response;
        const { edit } = outcome;
        const newContent = edit.newContent;

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
          totalLines: edit.newLineCount,
          previousTotalLines: edit.previousLineCount,
          numberedLines,
          operation: 'delete',
          deletedLines: `${startLine}-${actualEndLine}`,
          ...(contentModeWarning && { contentModeWarning }),
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

        // Addressed cell writes, not a document rewrite.
        //
        // This used to parse the whole sheet, splice the cells in and
        // re-serialise all of it — O(document) per call, and it needed a guard
        // against an unreadable parse replacing the spreadsheet with just these
        // cells. `setCells` writes the named cells and recomputes only what
        // depended on them; there is no document to misread.
        const formulaCount = cells.filter(c => c.value.trim().startsWith('=')).length;
        const valueCount = cells.filter(c => c.value.trim() !== '' && !c.value.trim().startsWith('=')).length;
        const clearCount = cells.filter(c => c.value.trim() === '').length;

        const actorInfo = await getActorInfo(userId);
        const setResult = await setCells(
          { pageId },
          cells,
          { userId, actorEmail: actorInfo.actorEmail }
        );

        // Still an activity entry and still a workflow trigger. Dropping
        // `applyPageMutation` dropped both, so an agent's edit became invisible
        // to page history and silently stopped firing workflows on the sheet.
        await logSheetCellActivity({
          pageId,
          driveId: page.driveId,
          pageTitle: page.title,
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
            recomputed: setResult.recomputed.length,
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
              rows: setResult.rowCount,
              columns: setResult.columnCount,
            },
            recomputed: setResult.recomputed.length,
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
    // A caller-supplied address that cannot be stored is a 400, not a 500.
    // `isValidCellAddress` accepts `A0` and `A9999999999`, so both clear this
    // route's own validation and only fail inside the store — and an agent that
    // receives "Failed to perform document operation" cannot correct itself.
    if (error instanceof SheetAddressError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // The sheet's stored document could not be read. This used to be an
    // explicit 409 on `edit-cells` ("refusing to overwrite it"); the guard went
    // away with the read-modify-write, but the condition still exists inside
    // `materializeFromDocument` and deserves the same answer rather than a
    // generic 500.
    if (error instanceof Error && error.message.includes('could not be read')) {
      return NextResponse.json({
        error: error.message,
        message: 'The stored sheet document needs repair before this sheet can be edited.',
      }, { status: 409 });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to perform document operation' }, { status: 500 });
  }
}
