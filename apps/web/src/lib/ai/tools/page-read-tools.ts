import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db'
import { decryptField } from '@pagespace/lib/encryption/field-crypto'
import { eq, and, ne, asc, isNotNull, count, max, min, inArray } from '@pagespace/db/operators'
import { pages, chatMessages } from '@pagespace/db/schema/core'
import { taskItems, taskLists, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks'
import { channelMessages } from '@pagespace/db/schema/chat';
import { buildTree } from '@pagespace/lib/content/tree-utils';
import { getActorAccessiblePagesInDrive, canActorViewPage, canActorAccessDrive, canActorManageDrive } from './actor-permissions';
import { getPageTypeEmoji, isFolderPage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import type { ToolExecutionContext } from '../core/types';
import { getSuggestedVisionModels } from '../core/model-capabilities';
import { serializePageContentForAI, isTextSerializablePageType } from '../core/page-serializer';
import { fetchCachedImagePreset } from '../core/image-preset-fetch';
import { toModelOutputForReadPage, buildVisualContentMetadata } from './read-page-vision-output';
import { ensureTaskListForPage, seedDefaultTaskStatusConfigs } from '@/services/api/task-sync-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveOrThrowPageId } from './page-context-defaults';

const pageReadLogger = loggers.ai.child({ module: 'page-read-tools' });

// Batching raw content onto list_pages has no pagination to lean on (recursive
// listing is already unbounded), so this caps how many pages can have content
// fetched in one call. Chosen to comfortably cover a single small-to-medium
// folder/audit pass while keeping the batched content query and payload size bounded.
const MAX_CONTENT_INCLUDE_PAGES = 50;

// The page-count cap above bounds how many pages get content, but not how
// large any single page is — a folder of 50 long CODE/DOCUMENT pages could
// still return a multi-megabyte response. Clip each page's content (in the
// same truncate-and-report spirit as read_conversation's message truncation,
// though the mechanics differ — see the newline-boundary cut below) so one
// huge page can't blow up the whole batch; callers needing the rest can
// resume with read_page's lineStart/lineEnd.
const MAX_CONTENT_CHARS_PER_PAGE = 8000;

export const pageReadTools = {
  /**
   * Explore the folder structure and find content within a workspace
   */
  list_pages: tool({
    description: 'List pages at a location in a workspace. Defaults to direct children of the drive root (ls-style). Pass parentId to navigate into a folder. Set recursive: true to return the full subtree. Each result includes hasChildren so you know whether to drill in further. Pass include: "content" to batch each page\'s content into the response instead of calling read_page per page — capped at ' + MAX_CONTENT_INCLUDE_PAGES + ' pages per call.',
    inputSchema: z.object({
      driveSlug: z.string().optional().describe('The human-readable slug of the drive (for semantic understanding)'),
      driveId: z.string().describe('The unique ID of the drive (used for operations)'),
      parentId: z.string().optional().describe('Page ID to list children of. Omit for drive root.'),
      recursive: z.boolean().optional().describe('Set true to return the full subtree instead of direct children only. Default: false.'),
      include: z.enum(['content']).optional().describe(`Set to "content" to batch each page's content into the response instead of calling read_page per page. Content over ${MAX_CONTENT_CHARS_PER_PAGE} characters is clipped (contentClipped: true) — resume with read_page's lineStart at contentClippedAfterLine + 1. CHANNEL/TASK_LIST/FILE pages get a short summary instead of content.`),
    }),
    execute: async ({ driveSlug, driveId, parentId, recursive = false, include }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const normalizedParentId = parentId ? parentId : undefined;

      try {
        if (!await canActorAccessDrive(context as ToolExecutionContext, driveId)) {
          return { success: false, error: `You don't have access to the "${driveSlug}" workspace` };
        }
        const visiblePages = await getActorAccessiblePagesInDrive(context as ToolExecutionContext, driveId);

        // Sort by position to maintain order
        visiblePages.sort((a, b) => a.position - b.position);

        const pageMap = new Map(visiblePages.map(p => [p.id, p]));

        if (normalizedParentId && !pageMap.has(normalizedParentId)) {
          return { success: false, error: `Page "${normalizedParentId}" not found or not accessible in this workspace` };
        }

        // Get task-linked page IDs to mark them
        const taskLinkedPageIds = await db.selectDistinct({ pageId: taskItems.pageId })
          .from(taskItems)
          .where(isNotNull(taskItems.pageId));
        const taskLinkedSet = new Set(taskLinkedPageIds.map(t => t.pageId));

        // Build full path for a page by walking up through the map
        const buildPath = (pageId: string | null): string => {
          if (!pageId) return `/${driveSlug || driveId}`;
          const page = pageMap.get(pageId);
          if (!page) return `/${driveSlug || driveId}`;
          return `${buildPath(page.parentId)}/${page.title}`;
        };

        // Build breadcrumb from drive root down to a given page
        const buildBreadcrumb = (id: string | undefined): { id: string; title: string }[] => {
          if (!id) return [];
          const crumbs: { id: string; title: string }[] = [];
          let current = pageMap.get(id);
          while (current) {
            crumbs.unshift({ id: current.id, title: current.title });
            current = current.parentId ? pageMap.get(current.parentId) : undefined;
          }
          return crumbs;
        };

        interface PageEntry {
          id: string;
          title: string;
          type: string;
          emoji: string;
          hasChildren: boolean;
          isTaskLinked: boolean;
          path: string;
          content?: string;
          contentOmitted?: string;
          contentClipped?: boolean;
          contentClippedAfterLine?: number;
        }

        let resultPages: PageEntry[];

        if (!recursive) {
          const target = normalizedParentId ?? null;
          const children = visiblePages.filter(p => p.parentId === target);
          resultPages = children.map(p => ({
            id: p.id,
            title: p.title,
            type: p.type,
            emoji: getPageTypeEmoji(p.type as PageType),
            hasChildren: visiblePages.some(c => c.parentId === p.id),
            isTaskLinked: taskLinkedSet.has(p.id),
            path: buildPath(p.id),
          }));
        } else {
          const collectSubtree = (startParentId: string | null): PageEntry[] => {
            const result: PageEntry[] = [];
            const children = visiblePages.filter(p => p.parentId === startParentId);
            for (const p of children) {
              result.push({
                id: p.id,
                title: p.title,
                type: p.type,
                emoji: getPageTypeEmoji(p.type as PageType),
                hasChildren: visiblePages.some(c => c.parentId === p.id),
                isTaskLinked: taskLinkedSet.has(p.id),
                path: buildPath(p.id),
              });
              result.push(...collectSubtree(p.id));
            }
            return result;
          };
          resultPages = collectSubtree(normalizedParentId ?? null);
        }

        // Batch content onto the result set in one additional query, rather than
        // making callers do N read_page calls. There's no pagination anywhere on
        // this endpoint to lean on for a size limit, so cap explicitly here and
        // report what was dropped instead of silently truncating.
        let contentTruncated = false;
        let contentClippedCount = 0;
        if (include === 'content' && resultPages.length > 0) {
          const pagesForContent = resultPages.slice(0, MAX_CONTENT_INCLUDE_PAGES);
          contentTruncated = resultPages.length > MAX_CONTENT_INCLUDE_PAGES;

          // Type is already known from resultPages, so split up front: structured
          // types (CHANNEL/TASK_LIST/FILE) never need their content column fetched
          // at all, and the query below only runs for the text-serializable subset.
          const textEntries = pagesForContent.filter(entry => {
            if (isTextSerializablePageType(entry.type)) return true;
            entry.contentOmitted = `${entry.type} pages return structured data, not inline text — use read_page with this page's ID instead.`;
            return false;
          });

          if (textEntries.length > 0) {
            const contentRows = await db
              .select({ id: pages.id, content: pages.content, contentMode: pages.contentMode })
              .from(pages)
              .where(inArray(pages.id, textEntries.map(p => p.id)));
            const contentMap = new Map(contentRows.map(r => [r.id, r]));

            for (const entry of textEntries) {
              const row = contentMap.get(entry.id);
              if (!row) continue;
              const fullContent = serializePageContentForAI({ type: entry.type, ...row });
              if (fullContent.length > MAX_CONTENT_CHARS_PER_PAGE) {
                // Cut at the last newline within the budget rather than an arbitrary
                // character offset, so we don't split a UTF-16 surrogate pair or sever
                // an HTML tag mid-way. Falls back to a hard cut only when the window
                // has no newline at all (e.g. one huge minified line).
                const hardCut = fullContent.slice(0, MAX_CONTENT_CHARS_PER_PAGE);
                const lastNewline = hardCut.lastIndexOf('\n');
                const clipped = lastNewline > 0 ? hardCut.slice(0, lastNewline) : hardCut;
                entry.content = clipped;
                entry.contentClipped = true;
                entry.contentClippedAfterLine = clipped.split('\n').length;
                contentClippedCount++;
              } else {
                entry.content = fullContent;
              }
            }
          }
        }

        const driveLabel = driveSlug || driveId;
        const breadcrumb = buildBreadcrumb(normalizedParentId);
        const location = normalizedParentId ? buildPath(normalizedParentId) : `/${driveLabel}`;
        const locationLabel = breadcrumb.length > 0 ? breadcrumb.map(c => c.title).join(' / ') : driveLabel;

        return {
          success: true,
          driveSlug: driveLabel,
          location,
          breadcrumb,
          pages: resultPages,
          count: resultPages.length,
          totalInDrive: visiblePages.length,
          ...(include === 'content' && {
            contentIncluded: true,
            contentPageCap: MAX_CONTENT_INCLUDE_PAGES,
            contentTruncated,
            contentCharCapPerPage: MAX_CONTENT_CHARS_PER_PAGE,
            contentClippedCount,
          }),
          summary: recursive
            ? `Found ${resultPages.length} page${resultPages.length === 1 ? '' : 's'} in "${driveLabel}" (full tree)`
            : `Found ${resultPages.length} page${resultPages.length === 1 ? '' : 's'} in "${locationLabel}"`,
          nextSteps: resultPages.length > 0 ? [
            ...(include === 'content' ? [] : ['Use read_page with a page ID to read its content']),
            'Pass parentId with a folder ID to navigate into it',
            'Use create_page to add new content',
            ...(contentTruncated ? [
              `Content was only included for the first ${MAX_CONTENT_INCLUDE_PAGES} of ${resultPages.length} pages — the rest have no "content" field. Narrow with parentId or call read_page directly for the remaining pages.`,
            ] : []),
            ...(contentClippedCount > 0 ? [
              `${contentClippedCount} page${contentClippedCount === 1 ? '' : 's'} had content clipped near the ${MAX_CONTENT_CHARS_PER_PAGE}-character mark (contentClipped: true) — each clipped entry's contentClippedAfterLine tells you where it stopped, so call read_page with lineStart: contentClippedAfterLine + 1 on that page to continue.`,
            ] : []),
          ] : [`"${locationLabel}" is empty — use create_page to add content`],
        };
      } catch (error) {
        console.error('Error reading drive tree:', error);
        throw new Error(`Failed to read drive tree for ${driveSlug || driveId}`);
      }
    },
  }),

  /**
   * Read existing documents to understand context and content
   */
  read_page: tool({
    description: 'Read the content of any page (document, AI chat, channel, etc.) using its ID. Returns content with line numbers. For CHANNEL pages, returns a message transcript. Use lineStart/lineEnd to read specific line ranges. Omit pageId to read the page currently in view.',
    inputSchema: z.object({
      title: z.string().describe('The document title for display context'),
      pageId: z.string().optional().describe('The unique ID of the page to read. Defaults to the page currently in view if omitted.'),
      lineStart: z.number().int().optional().describe('Start line number (1-indexed, inclusive). Omit to start from beginning.'),
      lineEnd: z.number().int().optional().describe('End line number (1-indexed, inclusive). Omit to read to end.'),
    }),
    toModelOutput: ({ output }) => toModelOutputForReadPage(output),
    execute: async ({ title, pageId: pageIdArg, lineStart, lineEnd }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, context as ToolExecutionContext);

      try {
        // Get the page directly by ID
        const page = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, pageId),
            eq(pages.isTrashed, false)
          ),
        });

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        if (!await canActorViewPage(context as ToolExecutionContext, page.id)) {
          throw new Error('Insufficient permissions to read this document');
        }

        // Check if this page is linked to a task
        const taskLink = await db.query.taskItems.findFirst({
          where: eq(taskItems.pageId, page.id),
          columns: { id: true },
        });
        const isTaskLinked = !!taskLink;

        // Handle FILE type pages
        if (page.type === 'FILE') {
          // Check processing status
          switch (page.processingStatus) {
            case 'pending':
            case 'processing':
              return {
                success: false,
                error: 'File is still being processed',
                status: page.processingStatus,
                title: page.title,
                type: page.type,
                suggestion: 'Please try again in a moment'
              };
            
            case 'visual':
              // Pure visual content - check if current model supports vision
              const modelCapabilities = (context as ToolExecutionContext)?.modelCapabilities;
              
              if (!modelCapabilities?.hasVision) {
                // Model doesn't support vision - provide helpful guidance
                return {
                  success: true,
                  type: 'visual_requires_vision_model',
                  title: page.title,
                  mimeType: page.mimeType,
                  message: `This is a visual file (${page.mimeType || 'image'}). To view its content, please switch to a vision-capable model.`,
                  suggestedModels: getSuggestedVisionModels(),
                  metadata: {
                    fileType: page.mimeType,
                    requiresVision: true
                  }
                };
              }
              
              // Model supports vision - try to deliver actual image bytes from the
              // processor's cached presets. Falls back to metadata-only (today's
              // behavior) when no preset in the fallback chain is usable.
              if (page.contentHash) {
                const deliveredImage = await fetchCachedImagePreset(
                  page.contentHash,
                  page.mimeType || 'application/octet-stream'
                );
                if (deliveredImage) {
                  return {
                    success: true,
                    type: 'visual_content_delivered',
                    pageId: page.id,
                    title: page.title,
                    mimeType: deliveredImage.mediaType,
                    originalMimeType: page.mimeType || 'application/octet-stream',
                    message: `Delivered visual content: "${page.title}" (${deliveredImage.mediaType})`,
                    imageBase64: deliveredImage.base64,
                    sizeBytes: page.fileSize || 0,
                    metadata: {
                      processingStatus: 'visual',
                      originalFileName: page.originalFileName,
                      presetUsed: deliveredImage.preset
                    }
                  };
                }
              }

              // Use page metadata instead of loading the full content
              return buildVisualContentMetadata({
                pageId: page.id,
                title: page.title,
                mimeType: page.mimeType || 'unknown',
                sizeBytes: page.fileSize || 0,
                metadata: {
                  requiresVisionModel: true,
                  processingStatus: 'visual',
                  originalFileName: page.originalFileName
                }
              });
            
            case 'failed':
              return {
                success: false,
                error: 'Failed to extract content from this file',
                processingError: page.processingError,
                title: page.title,
                type: page.type,
                suggestion: 'Try reprocessing the file or contact support'
              };
            
            case 'completed':
              // Normal text content available - continue to process below
              break;
          }
        }

        // Handle TASK_LIST pages - return structured task data
        if (page.type === 'TASK_LIST') {
          // Find or create task_list record for this page, seeding default status
          // configs alongside it so the DB is never left half-initialized.
          const taskList = await ensureTaskListForPage(db, {
            pageId: page.id,
            title: page.title,
            userId,
            metadata: {
              createdAt: new Date().toISOString(),
              autoCreated: true,
            },
          });

          // Get all non-trashed tasks ordered by pages.position — the single ordering
          // rail users reorder against (#2143). Title lives on the linked page too.
          const tasks = await db
            .select({
              id: taskItems.id,
              title: pages.title,
              status: taskItems.status,
              priority: taskItems.priority,
              position: pages.position,
              assigneeId: taskItems.assigneeId,
              dueDate: taskItems.dueDate,
              completedAt: taskItems.completedAt,
              pageId: taskItems.pageId,
            })
            .from(taskItems)
            .innerJoin(pages, eq(pages.id, taskItems.pageId))
            .where(and(
              eq(pages.parentId, taskList.pageId!),
              eq(pages.isTrashed, false),
            ))
            .orderBy(asc(pages.position), asc(taskItems.id));

          // Resolve available statuses for this task list. Falls back to
          // documented defaults when no custom configs are present so the
          // AI always sees a concrete list.
          // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
          const statusConfigs = await db.query.taskStatusConfigs.findMany({
            where: eq(taskStatusConfigs.taskListId, taskList.id),
            orderBy: [asc(taskStatusConfigs.position)],
          });

          // Legacy task_lists row (e.g. seeded by a pre-fix lazy-init path) with no
          // configs — backfill now instead of leaving it half-initialized forever.
          // Best-effort: this read already has a correct in-memory fallback
          // (DEFAULT_TASK_STATUSES below), so a transient backfill failure must not
          // fail the whole read — it'll simply retry on the next read of this page.
          if (statusConfigs.length === 0) {
            try {
              await seedDefaultTaskStatusConfigs(db, taskList.id);
            } catch (error) {
              pageReadLogger.error('Failed to backfill default task status configs', error as Error);
            }
          }

          const availableStatuses = statusConfigs.length > 0
            ? statusConfigs.map(c => ({
                slug: c.slug,
                label: c.name,
                group: c.group,
                position: c.position,
                color: c.color,
              }))
            : DEFAULT_TASK_STATUSES.map(s => ({
                slug: s.slug,
                label: s.name,
                group: s.group,
                position: s.position,
                color: s.color,
              }));

          const slugToGroup = new Map(availableStatuses.map(s => [s.slug, s.group]));

          // Resolve parent task list (if this list is nested under another task)
          let parentTaskList: { pageId: string; title: string; taskListId: string } | null = null;
          if (page.parentId) {
            const parentPage = await db.query.pages.findFirst({
              where: and(eq(pages.id, page.parentId), eq(pages.isTrashed, false)),
              columns: { id: true, title: true, type: true },
            });
            if (parentPage?.type === 'TASK_LIST') {
              const parentList = await db.query.taskLists.findFirst({
                where: eq(taskLists.pageId, parentPage.id),
                columns: { id: true },
              });
              if (parentList) {
                parentTaskList = { pageId: parentPage.id, title: parentPage.title, taskListId: parentList.id };
              }
            }
          }

          // Batch sub-task counts (total + completed) per task page
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

          // Dynamic progress breakdown — keyed by both group and slug so
          // custom statuses surface alongside the standard groups.
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

          const todoCount = byGroup.todo || 0;

          return {
            success: true,
            title: page.title,
            description: page.content || null,
            type: 'TASK_LIST',
            taskListId: taskList.id,
            parentTaskList,
            tasks: tasks.map(t => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              position: t.position,
              assigneeId: t.assigneeId,
              dueDate: t.dueDate,
              completedAt: t.completedAt,
              linkedPageId: t.pageId,
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
            summary: totalTasks > 0
              ? `Task list "${page.title}" is ${progressPercentage}% complete (${completedCount}/${totalTasks} tasks done)`
              : `Task list "${page.title}" has no tasks yet`,
            nextSteps: totalTasks === 0 ? [
              'Use create_task with this pageId to add tasks',
            ] : todoCount > 0 ? [
              'Use update_task with taskId to update task status (see availableStatuses for valid slugs)',
              'Each task has a linked document page for notes',
              'Use delete_task with a taskId to remove a task',
            ] : [
              'All tasks are completed or in progress',
            ],
          };
        }

        // Validate line range parameters
        if (lineStart !== undefined && lineStart < 1) {
          return {
            success: false,
            error: 'Invalid line range: line numbers must be positive integers',
          };
        }
        if (lineEnd !== undefined && lineEnd < 1) {
          return {
            success: false,
            error: 'Invalid line range: line numbers must be positive integers',
          };
        }
        if (lineStart !== undefined && lineEnd !== undefined && lineStart > lineEnd) {
          return {
            success: false,
            error: `Invalid line range: lineStart (${lineStart}) cannot be greater than lineEnd (${lineEnd})`,
          };
        }

        // Handle CHANNEL pages - return message transcript (lineStart/lineEnd map to message numbers)
        if (page.type === 'CHANNEL') {
          // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
          const messagesRaw = await db.query.channelMessages.findMany({
            where: and(
              eq(channelMessages.pageId, page.id),
              eq(channelMessages.isActive, true)
            ),
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: [asc(channelMessages.createdAt)],
          });
          // Decrypt PII at the edge (GDPR #965) so sender names in the tool output
          // are plaintext (legacy plaintext passes through unchanged).
          const messages = await Promise.all(messagesRaw.map(async (m) => ({
            ...m,
            user: m.user ? { ...m.user, name: await decryptField(m.user.name) } : m.user,
          })));

          const totalMessages = messages.length;
          const isRangeRequest = lineStart !== undefined || lineEnd !== undefined;

          const extractMessageText = (content: string): string => {
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
          };

          const getSenderInfo = (message: typeof messages[number]) => {
            const senderName = message.aiMeta?.senderName || message.user?.name || 'Unknown';

            if (message.aiMeta?.senderType === 'agent') {
              return { senderType: 'agent' as const, senderName, prefix: '[agent]' };
            }

            if (message.aiMeta?.senderType === 'global_assistant') {
              return { senderType: 'global_assistant' as const, senderName, prefix: '[assistant]' };
            }

            return { senderType: 'user' as const, senderName, prefix: '[user]' };
          };

          if (totalMessages === 0) {
            return {
              success: true,
              pageId: page.id,
              title: page.title,
              type: page.type,
              contentMode: page.contentMode || 'html',
              isTaskLinked,
              content: '',
              rawContent: '',
              lineCount: 0,
              totalLines: 0,
              messageCount: 0,
              totalMessages: 0,
              channelMessages: [],
              summary: `Channel "${page.title}" has no messages yet`,
              stats: {
                documentType: page.type,
                lineCount: 0,
                messageCount: 0,
                totalMessages: 0,
                wordCount: 0,
                characterCount: 0,
              },
              nextSteps: [
                'Use send_channel_message to post the first update',
                'Use list_pages to find related documents for context',
              ],
            };
          }

          const effectiveStart = lineStart ?? 1;
          const effectiveEnd = lineEnd !== undefined ? Math.min(lineEnd, totalMessages) : totalMessages;

          if (effectiveStart > totalMessages) {
            return {
              success: true,
              pageId: page.id,
              title: page.title,
              type: page.type,
              isTaskLinked,
              content: '',
              rawContent: '',
              lineCount: 0,
              totalLines: totalMessages,
              messageCount: 0,
              totalMessages,
              channelMessages: [],
              rangeStart: effectiveStart,
              rangeEnd: effectiveEnd,
              rangeMessage: `Requested range (${effectiveStart}-${lineEnd ?? totalMessages}) is beyond channel length (${totalMessages} messages)`,
              summary: `Channel "${page.title}" has ${totalMessages} message${totalMessages === 1 ? '' : 's'}, but requested range starts at message ${effectiveStart}`,
            };
          }

          const selectedMessages = messages.slice(effectiveStart - 1, effectiveEnd);

          const transcriptLines = selectedMessages.map((message, index) => {
            const lineNumber = effectiveStart + index;
            const sender = getSenderInfo(message);
            const timestamp = message.createdAt.toISOString();
            const messageText = extractMessageText(message.content);
            return `${lineNumber}→${sender.prefix} ${sender.senderName} (${timestamp}): ${messageText}`;
          });

          const rawTranscriptLines = selectedMessages.map(message => {
            const sender = getSenderInfo(message);
            const timestamp = message.createdAt.toISOString();
            const messageText = extractMessageText(message.content);
            return `${sender.prefix} ${sender.senderName} (${timestamp}): ${messageText}`;
          });

          const rawContent = rawTranscriptLines.join('\n');
          const content = transcriptLines.join('\n');

          return {
            success: true,
            pageId: page.id,
            title: page.title,
            type: page.type,
            contentMode: page.contentMode || 'html',
            isTaskLinked,
            totalLines: totalMessages,
            totalMessages,
            lineCount: selectedMessages.length,
            messageCount: selectedMessages.length,
            content,
            rawContent,
            channelMessages: selectedMessages.map((message, index) => {
              const sender = getSenderInfo(message);
              const messageText = extractMessageText(message.content);
              return {
                id: message.id,
                lineNumber: effectiveStart + index,
                createdAt: message.createdAt.toISOString(),
                senderId: message.userId,
                senderName: sender.senderName,
                senderType: sender.senderType,
                content: messageText,
              };
            }),
            ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
            summary: isRangeRequest
              ? `Read messages ${effectiveStart}-${effectiveEnd} of channel "${page.title}" (${selectedMessages.length} of ${totalMessages} messages)`
              : `Read channel "${page.title}" (${totalMessages} messages)`,
            stats: {
              documentType: page.type,
              lineCount: selectedMessages.length,
              messageCount: selectedMessages.length,
              totalMessages,
              wordCount: rawContent.split(/\s+/).filter(Boolean).length,
              characterCount: rawContent.length,
            },
            nextSteps: [
              'Use send_channel_message to post a response in this channel',
              'Use these messages as context before drafting updates',
            ],
          };
        }

        // Format content for AI line-based editing, then split into lines.
        // Shared with command injection (page-serializer) so both surfaces
        // serialize page content identically.
        const formattedContent = serializePageContentForAI(page);
        const allLines = formattedContent.split('\n');
        const totalLines = allLines.length;

        // Calculate effective range (1-indexed, inclusive)
        const effectiveStart = lineStart ?? 1;
        const effectiveEnd = lineEnd !== undefined ? Math.min(lineEnd, totalLines) : totalLines;

        // Check if requested range is beyond document
        if (effectiveStart > totalLines) {
          return {
            success: true,
            title: page.title,
            type: page.type,
            isTaskLinked,
            content: '',
            lineCount: 0,
            totalLines,
            rangeStart: effectiveStart,
            rangeEnd: effectiveEnd,
            rangeMessage: `Requested range (${effectiveStart}-${lineEnd ?? totalLines}) is beyond document length (${totalLines} lines)`,
            summary: `Document "${page.title}" has ${totalLines} lines, but requested range starts at line ${effectiveStart}`,
          };
        }

        // Extract lines in range (convert to 0-indexed for slice)
        const selectedLines = allLines.slice(effectiveStart - 1, effectiveEnd);
        const numberedContent = selectedLines
          .map((line, index) => `${effectiveStart + index}→${line}`)
          .join('\n');

        // Add file-specific metadata if it's a FILE type
        const metadata = page.type === 'FILE' ? {
          mimeType: page.mimeType,
          fileSize: page.fileSize,
          originalFileName: page.originalFileName,
          processingStatus: page.processingStatus,
          extractionMethod: page.extractionMethod,
          extractionMetadata: page.extractionMetadata
        } : undefined;

        const isRangeRequest = lineStart !== undefined || lineEnd !== undefined;

        // Raw content for rich rendering (without line numbers)
        const rawContent = selectedLines.join('\n');

        return {
          success: true,
          pageId: page.id,
          title: page.title,
          type: page.type,
          contentMode: page.contentMode || 'html',
          isTaskLinked,
          totalLines,
          lineCount: selectedLines.length,
          ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
          content: numberedContent,
          rawContent,
          summary: isRangeRequest
            ? `Read lines ${effectiveStart}-${effectiveEnd} of "${page.title}" (${selectedLines.length} of ${totalLines} lines)`
            : `Read "${page.title}" (${totalLines} lines, ${page.type.toLowerCase()})${isTaskLinked ? ' - linked to task' : ''}`,
          stats: {
            documentType: page.type,
            lineCount: selectedLines.length,
            wordCount: selectedLines.join('\n').split(/\s+/).length,
            characterCount: selectedLines.join('\n').length
          },
          ...(metadata && { fileMetadata: metadata }),
          nextSteps: isTaskLinked ? [
            'This page is linked to a task - use task management tools to update the task status',
            'DO NOT delete this page directly - it would break the task link',
            'Use the content for context in task progress tracking'
          ] : [
            'Use the content for context in creating related documents',
            'Use edit tools to modify this document if needed',
            'Reference this content when answering user questions'
          ]
        };
      } catch (error) {
        console.error('Error reading document:', error);
        throw new Error(`Failed to read document "${title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }),

  /**
   * List all trashed pages in a drive
   */
  list_trash: tool({
    description: 'List all trashed pages in a workspace. Returns page titles and metadata for restoration.',
    inputSchema: z.object({
      driveSlug: z.string().describe('The human-readable slug of the drive (for semantic understanding)'),
      driveId: z.string().describe('The unique ID of the drive (used for operations)'),
    }),
    execute: async ({ driveSlug, driveId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Trash listing requires drive owner/admin — mirrors GET
        // /api/drives/[driveId]/trash, which gates on the same bar.
        if (!await canActorManageDrive(context as ToolExecutionContext, driveId)) {
          throw new Error(`Only drive owners and admins can view the "${driveSlug}" workspace's trash`);
        }

        // Get all trashed pages in the drive (flat list)
        const trashedPages = await db
          .select()
          .from(pages)
          .where(and(
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, true)
          ))
          .orderBy(asc(pages.position));

        // Build a tree from the flat list of trashed pages
        const tree = buildTree(trashedPages);

        // Define proper type for formatted output
        interface FormattedTrashNode {
          id: string;
          title: string;
          type: string;
          trashedAt: Date | null;
          parentId: string | null;
          isFolder: boolean;
          hasChildren: boolean;
          children: FormattedTrashNode[];
          depth: number;
        }

        // Type for tree nodes (pages with children)
        type TreeNode = typeof trashedPages[0] & { children: TreeNode[] };

        // Helper function to format the tree for AI understanding
        const formatForAI = (nodes: TreeNode[], depth = 0): FormattedTrashNode[] => {
          return nodes.map(node => ({
            id: node.id,
            title: node.title,
            type: node.type,
            trashedAt: node.trashedAt,
            parentId: node.parentId,
            isFolder: isFolderPage(node.type as PageType),
            hasChildren: node.children && node.children.length > 0,
            children: node.children ? formatForAI(node.children, depth + 1) : [],
            depth,
          }));
        };

        const formattedTree = formatForAI(tree as TreeNode[]);

        return {
          success: true,
          driveSlug,
          trashedPages: formattedTree,
          count: trashedPages.length,
          hasHierarchy: formattedTree.some(page => page.hasChildren),
        };
      } catch (error) {
        console.error('Error listing trash:', error);
        throw new Error(`Failed to list trash for ${driveSlug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * List all conversations for an AI_CHAT page
   */
  list_conversations: tool({
    description: 'List all conversations for an AI agent (AI_CHAT page). Returns conversation metadata including message counts and last activity. Use to locate a conversation ID before calling read_conversation to recover condensed or elided history.',
    inputSchema: z.object({
      pageId: z.string().describe('The unique ID of the AI_CHAT page'),
      title: z.string().describe('The agent title for display context'),
    }),
    execute: async ({ pageId, title }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the page by ID
        const page = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, pageId),
            eq(pages.isTrashed, false)
          ),
        });

        if (!page) {
          return {
            success: false,
            error: `Page with ID "${pageId}" not found`,
          };
        }

        // Verify it's an AI_CHAT page
        if (page.type !== 'AI_CHAT') {
          return {
            success: false,
            error: `Page "${title}" is type ${page.type}, not AI_CHAT. Conversations only exist on AI_CHAT pages.`,
          };
        }

        if (!await canActorViewPage(context as ToolExecutionContext, page.id)) {
          return { success: false, error: 'Insufficient permissions to access this agent' };
        }

        // Query conversations grouped by conversationId
        const conversationData = await db
          .select({
            conversationId: chatMessages.conversationId,
            messageCount: count(chatMessages.id),
            lastActivity: max(chatMessages.createdAt),
            firstMessageTime: min(chatMessages.createdAt),
          })
          .from(chatMessages)
          .where(and(
            eq(chatMessages.pageId, pageId),
            eq(chatMessages.isActive, true)
          ))
          .groupBy(chatMessages.conversationId);

        // Get first message preview for each conversation
        const conversations = await Promise.all(
          conversationData.map(async (conv) => {
            // Get first message for preview - include pageId to use composite index
            const firstMessage = await db.query.chatMessages.findFirst({
              where: and(
                eq(chatMessages.pageId, pageId),
                eq(chatMessages.conversationId, conv.conversationId),
                eq(chatMessages.isActive, true)
              ),
              orderBy: asc(chatMessages.createdAt),
              columns: {
                content: true,
                role: true,
                userId: true,
              },
            });

            // Get unique participants - include pageId to use composite index
            const participants = await db
              .selectDistinct({ userId: chatMessages.userId })
              .from(chatMessages)
              .where(and(
                eq(chatMessages.pageId, pageId),
                eq(chatMessages.conversationId, conv.conversationId),
                eq(chatMessages.isActive, true),
                isNotNull(chatMessages.userId)
              ));

            // Extract preview text - prefer originalContent, then parts, then textParts
            let previewText = '';
            if (firstMessage?.content) {
              try {
                const parsed = JSON.parse(firstMessage.content);
                if (parsed.originalContent) {
                  previewText = parsed.originalContent;
                } else if (Array.isArray(parsed.parts)) {
                  // Handle message parts structure: filter for text parts and join
                  const textParts = parsed.parts
                    .filter((p: { type?: string }) => p.type === 'text')
                    .map((p: { text?: string }) => p.text)
                    .filter(Boolean);
                  previewText = textParts.join('\n') || firstMessage.content;
                } else {
                  previewText = parsed.textParts?.join('\n') ?? firstMessage.content;
                }
              } catch {
                previewText = firstMessage.content;
              }
            }
            const preview = previewText.slice(0, 100) + (previewText.length > 100 ? '...' : '');

            return {
              conversationId: conv.conversationId,
              messageCount: Number(conv.messageCount),
              lastActivity: conv.lastActivity?.toISOString() ?? null,
              firstMessagePreview: preview,
              participants: participants.map(p => p.userId).filter(Boolean) as string[],
            };
          })
        );

        // Sort by last activity (most recent first)
        conversations.sort((a, b) => {
          if (!a.lastActivity) return 1;
          if (!b.lastActivity) return -1;
          return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
        });

        return {
          success: true,
          pageId,
          pageTitle: title,
          conversations,
          count: conversations.length,
          summary: conversations.length > 0
            ? `Found ${conversations.length} conversation${conversations.length === 1 ? '' : 's'} for agent "${title}"`
            : `No conversations found for agent "${title}"`,
        };
      } catch (error) {
        console.error('Error listing conversations:', error);
        throw new Error(`Failed to list conversations for "${title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Read messages from a specific conversation
   */
  read_conversation: tool({
    description: 'Read messages from a specific conversation. Use lineStart/lineEnd to read specific message ranges. Messages are formatted with attribution showing who sent them. Use to recover earlier context that has been condensed into a summary or elided from the active context window — the full transcript is always available here.',
    inputSchema: z.object({
      pageId: z.string().describe('The unique ID of the AI_CHAT page'),
      conversationId: z.string().describe('The conversation ID to read'),
      title: z.string().describe('The agent title for display context'),
      lineStart: z.number().int().optional().describe('Start message number (1-indexed, inclusive). Omit to start from beginning.'),
      lineEnd: z.number().int().optional().describe('End message number (1-indexed, inclusive). Omit to read to end.'),
    }),
    execute: async ({ pageId, conversationId, title, lineStart, lineEnd }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Validate line range parameters
        if (lineStart !== undefined && lineStart < 1) {
          return {
            success: false,
            error: 'Invalid line range: line numbers must be positive integers',
          };
        }
        if (lineEnd !== undefined && lineEnd < 1) {
          return {
            success: false,
            error: 'Invalid line range: line numbers must be positive integers',
          };
        }
        if (lineStart !== undefined && lineEnd !== undefined && lineStart > lineEnd) {
          return {
            success: false,
            error: `Invalid line range: lineStart (${lineStart}) cannot be greater than lineEnd (${lineEnd})`,
          };
        }

        // Get the page by ID
        const page = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, pageId),
            eq(pages.isTrashed, false)
          ),
        });

        if (!page) {
          return {
            success: false,
            error: `Page with ID "${pageId}" not found`,
          };
        }

        if (!await canActorViewPage(context as ToolExecutionContext, page.id)) {
          return { success: false, error: 'Insufficient permissions to access this conversation' };
        }

        // Get all messages for this conversation. Excludes 'streaming' placeholders — this
        // is delivered straight to the model as a tool result. See Server Stream Durability
        // epic PR 2.
        const messages = await db
          .select()
          .from(chatMessages)
          .where(and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.pageId, pageId),
            eq(chatMessages.isActive, true),
            ne(chatMessages.status, 'streaming')
          ))
          .orderBy(asc(chatMessages.createdAt));

        if (messages.length === 0) {
          return {
            success: false,
            error: `Conversation "${conversationId}" not found or has no messages`,
          };
        }

        const totalMessages = messages.length;

        // Calculate effective range (1-indexed, inclusive)
        const effectiveStart = lineStart ?? 1;
        const effectiveEnd = lineEnd !== undefined ? Math.min(lineEnd, totalMessages) : totalMessages;

        // Check if requested range is beyond conversation
        if (effectiveStart > totalMessages) {
          return {
            success: true,
            pageId,
            conversationId,
            content: '',
            messageCount: 0,
            totalMessages,
            rangeStart: effectiveStart,
            rangeEnd: effectiveEnd,
            rangeMessage: `Requested range (${effectiveStart}-${lineEnd ?? totalMessages}) is beyond conversation length (${totalMessages} messages)`,
          };
        }

        // Extract messages in range (convert to 0-indexed for slice)
        const selectedMessages = messages.slice(effectiveStart - 1, effectiveEnd);

        // Batch fetch all source agent names upfront to avoid N+1 queries
        const uniqueSourceAgentIds = [...new Set(
          selectedMessages
            .map(m => m.sourceAgentId)
            .filter((id): id is string => id !== null)
        )];

        const sourceAgentMap = new Map<string, string>();
        if (uniqueSourceAgentIds.length > 0) {
          // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
          const sourceAgents = await db.query.pages.findMany({
            where: inArray(pages.id, uniqueSourceAgentIds),
            columns: { id: true, title: true },
          });
          sourceAgents.forEach(agent => {
            sourceAgentMap.set(agent.id, agent.title);
          });
        }

        // Format messages with attribution
        const formattedLines = selectedMessages.map((msg, index) => {
          const lineNumber = effectiveStart + index;

          // Determine attribution prefix
          let prefix: string;
          if (msg.role === 'assistant') {
            prefix = '[assistant]';
          } else if (msg.sourceAgentId) {
            // Message was sent via another agent - look up from pre-fetched map
            const agentName = sourceAgentMap.get(msg.sourceAgentId) ?? 'Unknown Agent';
            prefix = `[user@${agentName}]`;
          } else {
            prefix = '[user]';
          }

          // Extract text content - prefer originalContent, then parts, then textParts
          let textContent = '';
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed.originalContent) {
              textContent = parsed.originalContent;
            } else if (Array.isArray(parsed.parts)) {
              // Handle message parts structure: filter for text parts and join
              const textParts = parsed.parts
                .filter((p: { type?: string }) => p.type === 'text')
                .map((p: { text?: string }) => p.text)
                .filter(Boolean);
              textContent = textParts.join('\n') || msg.content;
            } else {
              textContent = parsed.textParts?.join('\n') ?? msg.content;
            }
          } catch {
            textContent = msg.content;
          }

          // Truncate long messages for readability
          const displayContent = textContent.length > 500
            ? textContent.slice(0, 500) + '...'
            : textContent;

          return `${lineNumber}→${prefix} ${displayContent}`;
        });

        const content = formattedLines.join('\n');
        const isRangeRequest = lineStart !== undefined || lineEnd !== undefined;

        return {
          success: true,
          pageId,
          conversationId,
          totalMessages,
          messageCount: selectedMessages.length,
          ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
          content,
          summary: isRangeRequest
            ? `Read messages ${effectiveStart}-${effectiveEnd} of "${title}" conversation (${selectedMessages.length} of ${totalMessages} messages)`
            : `Read "${title}" conversation with ${totalMessages} messages`,
        };
      } catch (error) {
        console.error('Error reading conversation:', error);
        throw new Error(`Failed to read conversation: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
