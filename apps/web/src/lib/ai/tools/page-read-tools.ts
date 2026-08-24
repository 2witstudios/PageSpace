import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db'
import { decryptField } from '@pagespace/lib/encryption/field-crypto'
import { eq, and, ne, asc, isNotNull, count, max, min, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
// Aliased: `conversations` and `messages` are both used as local variable
// names inside the tools below.
import { conversations as conversationsTable, messages } from '@pagespace/db/schema/conversations'
import { taskItems, taskLists, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks'
import { channelMessages } from '@pagespace/db/schema/chat';
import { buildTree } from '@pagespace/lib/content/tree-utils';
import { getActorAccessiblePagesInDrive, canActorViewPage, canActorAccessDrive, canActorManageDrive } from './actor-permissions';
import { getPageTypeEmoji, isFolderPage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import type { ToolExecutionContext } from '../core/types';
import { getSuggestedVisionModels } from '../core/model-capabilities';
import { serializePageContentForAI, isTextSerializablePageType } from '../core/page-serializer';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import {
  loadSheetWindow,
  renderSheetTable,
  renderSheetTableWithinBudget,
  columnsInRows,
  SheetDocumentUnreadableError,
  SheetTabNotFoundError,
  type SheetWindow,
  SHEET_PREVIEW_ROWS,
  SHEET_LIST_PREVIEW_ROWS,
  MAX_SHEET_READ_ROWS,
  TABLE_CELL_CHAR_LIMIT,
} from './sheet-view';
import { fetchCachedImagePreset } from '../core/image-preset-fetch';
import { toModelOutputForReadPage, buildVisualContentMetadata } from './read-page-vision-output';
import { ensureTaskListForPage, seedInheritedTaskStatusConfigs } from '@/services/api/task-sync-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveOrThrowPageId } from './page-context-defaults';
import { resolveDriveScope } from './drive-context-defaults';

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

// Room reserved for the header and pointer sentence wrapped around a sheet
// preview, so the budget bounds the finished ENTRY rather than just its table.
const SHEET_PREVIEW_FRAMING_CHARS = 300;

/**
 * The window `read_page` shows for a SHEET, or `null` when the page turns out
 * not to hold a sheet document at all.
 *
 * Split out because the load has to happen BEFORE the branch decides whether
 * this is a sheet read or a text read, and an unreadable document has to refuse
 * rather than fall through — a document that cannot be parsed is not the same
 * as one that was never a sheet, and only the second may be shown as text.
 */
async function loadSheetWindowForRead(
  page: { id: string; content: string | null },
  lineStart: number | undefined,
  lineEnd: number | undefined,
): Promise<SheetWindow> {
  const requestedStart = Math.max(1, lineStart ?? 1);
  const windowSize = lineEnd !== undefined
    ? Math.min(Math.max(0, lineEnd - requestedStart + 1), MAX_SHEET_READ_ROWS)
    : SHEET_PREVIEW_ROWS;

  // `limit` is at least 1 even for an empty range (lineEnd < lineStart): the
  // fetch is what carries the sheet's dimensions and tab list, and an empty
  // range must still report those rather than "0 rows x 0 columns", which reads
  // as an empty spreadsheet.
  return loadSheetWindow(page.id, {
    fromRow: requestedStart - 1,
    limit: Math.max(1, windowSize),
    documentContent: page.content,
  });
}

/**
 * One SHEET's entry in a `list_pages include: "content"` batch.
 *
 * Bounded by CHARACTERS, not by row count: five rows of a wide sheet is still a
 * lot of text and this call previews up to 50 pages at once, so the budget that
 * has to hold is the per-page cap every other page type obeys. Whole rows are
 * dropped until it fits, so the table is never cut mid-row into something that
 * reads like a real value, and the cap bounds the finished ENTRY — the header
 * and pointer are prepended after the table, so bounding the table alone let
 * the result run past the budget.
 */
function buildSheetPreviewContent(sheet: SheetWindow): string {
  // Budgeted against the framing too, not just the table: the header and the
  // pointer sentence are prepended, so bounding the table alone let the
  // finished entry run past the per-page cap.
  const rendered = renderSheetTableWithinBudget(sheet.rows, MAX_CONTENT_CHARS_PER_PAGE - SHEET_PREVIEW_FRAMING_CHARS);

  // The same truncation signal read_page and read_sheet surface: values cut at
  // the cell limit must not be copied back into a write, and an ellipsis alone
  // does not say how many.
  const cutNote = rendered.truncatedCells > 0
    ? ` ${rendered.truncatedCells} cell value(s) are cut at ${TABLE_CELL_CHAR_LIMIT} characters — read them with read_sheet, which carries the full text.`
    : '';
  const header = `SHEET: ${sheet.rowCount} rows x ${sheet.columnCount} columns.${cutNote}`;
  // The pointer rides in the content rather than in `contentClipped`, which
  // promises the rest is reachable with read_page's lineStart — the rest of a
  // sheet is reached with read_sheet. A wrong pointer is worse than none.
  const framing = `${header} First ${rendered.rowsShown} row(s) below; use read_sheet on this page for the rest, or to filter and project.\n`;

  return rendered.text ? `${framing}${rendered.text}` : `${header} No data yet.`;
}

export const pageReadTools = {
  /**
   * Explore the folder structure and find content within a workspace
   */
  list_pages: tool({
    description: 'List pages at a location in a workspace. Defaults to direct children of the drive root (ls-style). Pass parentId to navigate into a folder. Set recursive: true to return the full subtree. Each result includes hasChildren so you know whether to drill in further. Pass include: "content" to batch each page\'s content into the response instead of calling read_page per page — capped at ' + MAX_CONTENT_INCLUDE_PAGES + ' pages per call.',
    inputSchema: z.object({
      driveSlug: z.string().optional().describe('The human-readable slug of the drive (for semantic understanding)'),
      driveId: z.string().optional().describe('The unique ID of the drive (used for operations). Omit to list the workspace currently in view (see LOCATION context).'),
      parentId: z.string().optional().describe('Page ID to list children of. Omit for drive root.'),
      recursive: z.boolean().optional().describe('Set true to return the full subtree instead of direct children only. Default: false.'),
      include: z.enum(['content']).optional().describe(`Set to "content" to batch each page's content into the response instead of calling read_page per page. Content over ${MAX_CONTENT_CHARS_PER_PAGE} characters is clipped (contentClipped: true) — resume with read_page's lineStart at contentClippedAfterLine + 1. CHANNEL/TASK_LIST/FILE pages get a short summary instead of content, and SHEET pages get their dimensions plus their first ${SHEET_LIST_PREVIEW_ROWS} rows — use read_sheet for the rest.`),
    }),
    execute: async ({ driveSlug, driveId: driveIdArg, parentId, recursive = false, include }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const { driveId, scopeSource } = resolveDriveScope(driveIdArg, context as ToolExecutionContext);

      const normalizedParentId = parentId ? parentId : undefined;

      try {
        if (!await canActorAccessDrive(context as ToolExecutionContext, driveId)) {
          // driveSlug is absent whenever driveId was defaulted from location.
          return { success: false, error: `You don't have access to the "${driveSlug ?? driveId}" workspace` };
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

              // Sheets are rows, not text, and this batching surface is where
              // reading them as text hurts most: one 500-row sheet in a folder
              // used to reconstruct the whole SheetDoc document, then hand back
              // the first 8,000 characters of it — a clipped TOML header that
              // reaches roughly cell B3 and tells the reader nothing about the
              // sheet. It gets the same bounded row window read_page returns,
              // just fewer rows because this call previews many pages at once.
              if (isSheetType(entry.type as PageType)) {
                let sheet: SheetWindow;
                try {
                  sheet = await loadSheetWindow(entry.id, {
                    limit: SHEET_LIST_PREVIEW_ROWS,
                    documentContent: row.content,
                  });
                } catch (error) {
                  // One sheet that cannot be parsed must not blank itself out
                  // (an agent would read that as "empty" and overwrite it) and
                  // must not fail the other 49 pages in the batch either. Say
                  // what happened, in this entry only.
                  if (error instanceof SheetDocumentUnreadableError || error instanceof SheetTabNotFoundError) {
                    entry.contentOmitted = `SHEET could not be read: ${error.message} It is NOT empty — do not overwrite it.`;
                    continue;
                  }
                  throw error;
                }
                if (!sheet.documentIsNotASheet) {
                  entry.content = buildSheetPreviewContent(sheet);
                  continue;
                }
                // Otherwise the page holds legacy text rather than a sheet
                // document, and this deliberately does NOT `continue`: it drops
                // out of the sheet branch so the shared text handling below
                // answers. Reporting "no data yet" would lose the content, and
                // clipping it here would duplicate a cut the shared path does
                // better (last-newline, so no severed surrogate pair or tag).
              }

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
          driveId,
          scopeSource,
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
    description: 'Read the content of any page (document, AI chat, channel, etc.) using its ID. Returns content with line numbers. For CHANNEL pages, returns a message transcript. For SHEET pages, returns the sheet\'s dimensions and its first ' + SHEET_PREVIEW_ROWS + ' rows as a table (lineStart/lineEnd select ROW numbers there) — use read_sheet to read a row range, filter rows by column value, or project columns. Use lineStart/lineEnd to read specific line ranges. Omit pageId to read the page currently in view.',
    inputSchema: z.object({
      title: z.string().describe('The document title for display context'),
      pageId: z.string().optional().describe('The unique ID of the page to read. Defaults to the page currently in view if omitted.'),
      lineStart: z.number().int().optional().describe('Start line number (1-indexed, inclusive). Omit to start from beginning. On a SHEET this is a sheet ROW number.'),
      lineEnd: z.number().int().optional().describe('End line number (1-indexed, inclusive). Omit to read to end. On a SHEET this is a sheet ROW number.'),
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
          // In a transaction: ensureTaskListForPage's create branch seeds the
          // vocabulary and then conforms any rows already under the page, and a
          // page CAN hold task rows with no task_lists row of its own — there is
          // no foreign key between them, only pages.parentId. Committing the
          // configs without the conform is permanent, since the repair below
          // only fires while the vocabulary is empty.
          const taskList = await db.transaction((tx) => ensureTaskListForPage(tx, {
            pageId: page.id,
            title: page.title,
            userId,
            metadata: {
              createdAt: new Date().toISOString(),
              autoCreated: true,
            },
          }));

          // Get all non-trashed tasks ordered by pages.position — the single ordering
          // rail users reorder against (#2143). Title lives on the linked page too.
          const readTasks = () => db
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
          let tasks = await readTasks();

          // Resolve available statuses for this task list. Falls back to
          // documented defaults when no custom configs are present so the
          // AI always sees a concrete list.
          // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
          let statusConfigs = await db.query.taskStatusConfigs.findMany({
            where: eq(taskStatusConfigs.taskListId, taskList.id),
            orderBy: [asc(taskStatusConfigs.position)],
          });

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
                seedInheritedTaskStatusConfigs(tx, taskList.id, page.id));
              // Re-read BOTH. The repair writes twice — it seeds the vocabulary
              // and then conforms the rows to it — and everything above was read
              // before either. Re-reading only the configs would report statuses
              // the repair has just moved, on slugs absent from the vocabulary
              // named in the same response, which an agent then echoes back into
              // a 400.
              // Both in one destructuring, so a failure in the second cannot
              // leave the first assigned: the outer catch would then send the
              // NEW vocabulary beside the PRE-repair statuses, which is exactly
              // the pairing this block exists to prevent.
              [statusConfigs, tasks] = await Promise.all([
                // eslint-disable-next-line no-restricted-syntax -- unbounded on purpose: the read it replaces is unbounded, and the seeding path it re-reads no longer caps either. Reporting 200 of a 260-status vocabulary beside rows the sweep just moved to a slug at position 259 names statuses the same response says do not exist.
                db.query.taskStatusConfigs.findMany({
                  where: eq(taskStatusConfigs.taskListId, taskList.id),
                  orderBy: [asc(taskStatusConfigs.position)],
                }),
                readTasks(),
              ]);
            } catch (error) {
              pageReadLogger.error('Failed to backfill inherited task status configs', error as Error);
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

        // A SHEET is rows, and reading it as text was the single worst answer
        // this tool gave.
        //
        // The old path reconstructed the whole spreadsheet as a SheetDoc TOML
        // document and then numbered every line of it: a 500-row, 16-column
        // sheet came back as ~23,700 lines of `[sheets.cells.AB417]` tables,
        // one per cell, with no way to ask for a row range or look a row up by
        // value. Reading a real dataset was impossible, so agents kept a copy of
        // the data outside the platform instead — the storage was write-only in
        // practice (issue #2467).
        //
        // What comes back now is what makes a sheet legible and bounded: its
        // dimensions and tabs, then a window of rows as delimited text whose
        // line numbers ARE the sheet's row numbers, so reading row 417 tells you
        // where to write `C417`. lineStart/lineEnd select ROWS here rather than
        // lines of serialised TOML, which is the only reading of them that
        // survives the change with a useful meaning. Anything beyond a window —
        // filtering, sorting, column projection — is `read_sheet`, and this
        // result says so.
        // A SHEET page can hold legacy plain text or HTML rather than a sheet
        // document at all, and `parseSheetContentSafe` reports that as an EMPTY
        // sheet — correctly, since there is no sheet data to lose. Rendering it
        // as a grid would answer "20 rows x 10 columns, nothing stored" and hide
        // the content. Handling it INSIDE the sheet branch was not enough
        // either: that returned the whole document with no `N→` numbering, no
        // lineStart/lineEnd slicing and a row-count `totalLines`, so an agent
        // asking for lines 200-250 got everything and could not page. The whole
        // branch is skipped instead, and the ordinary text path below answers —
        // numbering, ranges and counts all correct.
        let sheetWindow: SheetWindow | null = null;
        if (isSheetType(page.type as PageType)) {
          try {
            sheetWindow = await loadSheetWindowForRead(page, lineStart, lineEnd);
          } catch (error) {
            // A sheet whose stored document will not PARSE is reported as
            // unreadable, never as blank and never as text: the data may be
            // intact and recoverable, and "empty" invites an overwrite.
            if (error instanceof SheetDocumentUnreadableError) {
              return {
                success: false,
                pageId: page.id,
                title: page.title,
                type: page.type,
                error: 'Sheet content could not be read',
                message: error.message,
                suggestion:
                  'Do not treat this sheet as empty and do not overwrite it. The stored document needs repair.',
              };
            }
            // The other two callers of this loader answer this one; leaving it
            // to the outer catch here made read_page the only surface where a
            // sheet with a non-zero-based tab set produced the generic
            // "Failed to read document" this change exists to eliminate.
            if (error instanceof SheetTabNotFoundError) {
              return {
                success: false,
                pageId: page.id,
                title: page.title,
                type: page.type,
                error: 'Sheet tab not found',
                message: error.message,
                suggestion: 'Use read_sheet with one of the tab indexes listed in the message.',
                tabs: error.availableTabs,
              };
            }
            throw error;
          }
        }

        if (sheetWindow && !sheetWindow.documentIsNotASheet) {
          const sheet = sheetWindow;
          const requestedStart = Math.max(1, lineStart ?? 1);
          const invertedRange = lineEnd !== undefined && lineEnd < requestedStart;

          // Rows are sparse — rows 1-10 then 500-509 is a normal shape — so a
          // window that starts inside the requested range can still run past
          // its end. Clip to what was actually asked for.
          const rows = sheet.rows.filter(
            (row) => lineEnd === undefined || row.rowNumber <= lineEnd
          );
          const columns = columnsInRows(rows);
          const rendered = renderSheetTable(rows, columns);
          const table = rendered.text;
          const rowCount = sheet.rowCount;
          const isRangeRequest = lineStart !== undefined || lineEnd !== undefined;

          // Formulas and errors, keyed by A1 address across the window. A sheet
          // read that shows only computed values cannot tell "5" from "=2+3",
          // and the spreadsheets skill documents reading a page back to confirm
          // a formula (and to see the expected cross-page-reference error).
          // Both stay sparse — only cells that have one appear.
          const formulas: Record<string, string> = {};
          const errors: Record<string, string> = {};
          for (const row of rows) {
            for (const [column, formula] of Object.entries(row.formulas ?? {})) {
              formulas[`${column}${row.rowNumber}`] = formula;
            }
            for (const [column, message] of Object.entries(row.errors ?? {})) {
              errors[`${column}${row.rowNumber}`] = message;
            }
          }

          const lastRow = rows.length > 0 ? rows[rows.length - 1].rowNumber : requestedStart - 1;
          // Whether anything FOLLOWS comes from the fetch, never from the tab's
          // declared rowCount.
          //
          // `readRows` selects `rowIndex >= from`, so a window that came back
          // empty proves nothing follows. Comparing `lastRow` (which collapses
          // to `requestedStart - 1` on an empty window) against `rowCount`
          // instead answered "more rows, resume at N" for the very call that
          // had just returned nothing — an agent looping on those fields would
          // never terminate. Both halves of that are real shapes: a tab can
          // declare 500 rows while storing rows only up to 60, and a new sheet
          // declares 20 while storing none. `loadSheetWindow` already gets this
          // right and `read_sheet` inherits it; only this path recomputed it.
          const clippedByLineEnd = sheet.rows.length > rows.length;
          // Where to resume comes from what the FETCH reached, never from the
          // request. Rows are sparse: a sheet storing rows 1-3 and 500-509
          // answers `lineStart: 4, lineEnd: 10` by fetching from index 3,
          // getting rows 500+, and clipping every one of them. `rows` is then
          // empty while the fetch was not, so falling back to `requestedStart`
          // pointed at the very call that had just returned nothing. The first
          // fix here only covered the empty-FETCH case; this is the empty-after
          // -CLIPPING case, and it loops the same way.
          // Resume at the first row this window DROPPED, not past the last one
          // it fetched. Same sparse example: rows 1-3 and 500-509, asked for
          // `lineStart: 4, lineEnd: 10`. The fetch returns rows 500-506 and
          // clipping removes all of them; pointing past the last fetched row
          // would resume at 507 and silently skip 500-506, which the agent had
          // never been shown. The first dropped row is always past `lineEnd`,
          // so it cannot reproduce the loop this guards against either.
          const resumeAt = rows.length > 0
            ? rows[rows.length - 1].rowNumber + 1
            : sheet.rows.length > 0 ? sheet.rows[0].rowNumber : null;
          // `clippedByLineEnd` means the fetch ran PAST lineEnd, which proves the
          // requested range is complete — it was being used as evidence of the
          // opposite. A bounded read also has to measure "more" against the
          // CALLER's range, not the sheet: `lineStart: 1, lineEnd: 10` on a
          // dense sheet fetches exactly 10 rows, so `sheet.hasMore` is true
          // (a full page) while the request is entirely satisfied. Both shapes
          // cost a guaranteed-empty extra call and, worse, contradicted the
          // `rangeMessage` in the same response.
          const moreRows =
            !invertedRange &&
            sheet.rows.length > 0 &&
            resumeAt !== null &&
            (lineEnd === undefined
              ? sheet.hasMore
              : !clippedByLineEnd && sheet.hasMore && lastRow < lineEnd);
          const nextStartRow = moreRows ? resumeAt : null;
          // An empty window is not the same as an empty sheet, and the two must
          // not read alike: a request past the last row, or into a gap in a
          // sparse sheet, still has to report the sheet's real size and say
          // which it was. The text path draws the same distinction with
          // `rangeMessage`.
          const emptyWindowReason = rows.length > 0
            ? undefined
            : invertedRange
              // Blaming sparsity here was simply false: rows 10-5 is an empty
              // REQUEST, not a gap in the data.
              ? `Requested range is inverted: lineEnd (${lineEnd}) is before lineStart (${requestedStart}), so it selects no rows.`
              : requestedStart > rowCount
                ? `Requested rows start at ${requestedStart}, past the last row of this ${rowCount}-row sheet.`
                : `No rows are stored in ${lineEnd === undefined ? `rows ${requestedStart} onward` : `rows ${requestedStart}-${lineEnd}`}, though the sheet has ${rowCount} rows — sheet rows can be sparse.`;

          return {
            success: true,
            pageId: page.id,
            title: page.title,
            type: page.type,
            contentMode: page.contentMode || 'html',
            isTaskLinked,
            // `totalLines` is a sheet's ROW count here, which is what
            // lineStart/lineEnd address on this page type.
            totalLines: rowCount,
            lineCount: rows.length,
            // No `rawContent` here: on this path it was byte-identical to
            // `content`, and the whole result — table AND structured rows — is
            // passed to the model as JSON. Sending the same window twice in a
            // tool whose purpose is cutting sheet-read context is the one waste
            // this branch cannot justify. The renderer reads
            // `rawContent ?? content`, so it is unaffected.
            content: table,
            ...(rendered.truncatedCells > 0 && { tableTruncatedCells: rendered.truncatedCells }),
            dimensions: { rowCount, columnCount: sheet.columnCount },
            tabs: sheet.tabs,
            tabIndex: sheet.tabIndex,
            tabName: sheet.tabName,
            columns,
            rows,
            rowsReturned: rows.length,
            ...(Object.keys(formulas).length > 0 && { formulas }),
            ...(Object.keys(errors).length > 0 && { errors }),
            ...(isRangeRequest && { rangeStart: requestedStart, rangeEnd: lastRow }),
            hasMoreRows: moreRows,
            ...(moreRows && nextStartRow !== null && { nextStartRow }),
            ...(emptyWindowReason && { rangeMessage: emptyWindowReason }),
            summary: emptyWindowReason
              ? `Sheet "${page.title}" has ${rowCount} rows x ${sheet.columnCount} columns. ${emptyWindowReason}`
              : isRangeRequest
                ? `Read rows ${requestedStart}-${lastRow} of sheet "${page.title}" (${rows.length} of ${rowCount} rows, ${sheet.columnCount} columns)`
                : `Sheet "${page.title}": ${rowCount} rows x ${sheet.columnCount} columns — showing the first ${rows.length}`,
            stats: {
              documentType: page.type,
              rowCount,
              columnCount: sheet.columnCount,
              rowsReturned: rows.length,
              characterCount: table.length,
            },
            nextSteps: [
              // Both continuations are named on purpose. `read_sheet` is the
              // right one, but an agent whose saved `enabledTools` allowlist
              // predates it cannot call it — and pointing only at a tool the
              // caller may not have would leave it with 25 rows and no way
              // forward. `lineStart`/`lineEnd` on THIS tool page the same
              // sheet and are always available.
              ...(moreRows && rows.length > 0
                ? [
                    `Only rows up to ${lastRow} of ${rowCount} are shown. Continue with read_sheet (startRow: ${lastRow + 1}), or with read_page again (lineStart: ${lastRow + 1}) if read_sheet is not available to you.`,
                  ]
                : []),
              ...(rendered.truncatedCells > 0
                ? [`${rendered.truncatedCells} cell value(s) are cut at ${TABLE_CELL_CHAR_LIMIT} characters in the content above — read them from "rows", which carries the full text.`]
                : []),
              'To find rows rather than page them — filter by column value, sort, or return only some columns — use read_sheet. Do not read a whole sheet to search it.',
              'Use edit_sheet_cells with A1 addresses to write; a row\'s number here is its A1 row.',
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

        // Query conversations grouped by conversationId.
        //
        // Reads the unified `messages` table since the message-table merge
        // (epic "Agent-Session Single Source of Truth", Phase 4 / D6). Page
        // scope is the JOIN (`conversations.type = 'page'` AND
        // `conversations.contextId = pageId`), not `messages.pageId` — the
        // former is the end-state authority and indexed, the latter is
        // transitional and dropped at the contract PR.
        const conversationData = await db
          .select({
            conversationId: messages.conversationId,
            messageCount: count(messages.id),
            lastActivity: max(messages.createdAt),
            firstMessageTime: min(messages.createdAt),
          })
          .from(messages)
          .innerJoin(conversationsTable, eq(conversationsTable.id, messages.conversationId))
          .where(and(
            eq(conversationsTable.type, 'page'),
            eq(conversationsTable.contextId, pageId),
            eq(messages.isActive, true)
          ))
          .groupBy(messages.conversationId);

        // Get first message preview for each conversation
        const conversations = await Promise.all(
          conversationData.map(async (conv) => {
            // Get first message for preview — scoped by conversationId, which
            // is globally unique (cuid2) and already implies the page.
            const [firstMessage] = await db
              .select({
                content: messages.content,
                role: messages.role,
                userId: messages.userId,
              })
              .from(messages)
              .where(and(
                eq(messages.conversationId, conv.conversationId),
                eq(messages.isActive, true)
              ))
              .orderBy(asc(messages.createdAt), asc(messages.id))
              .limit(1);

            // Get unique participants
            const participants = await db
              .selectDistinct({ userId: messages.userId })
              .from(messages)
              .where(and(
                eq(messages.conversationId, conv.conversationId),
                eq(messages.isActive, true),
                isNotNull(messages.userId)
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
        //
        // Unified `messages` table since the merge (Phase 4 / D6). The page
        // predicate is kept — it is what stops a caller pairing someone else's
        // conversation id with a page they can see — but it is now
        // `conversations.contextId`, the end-state authority, rather than the
        // transitional `messages.pageId`.
        const conversationMessages = await db
          .select({
            role: messages.role,
            content: messages.content,
            sourceAgentId: messages.sourceAgentId,
          })
          .from(messages)
          .innerJoin(conversationsTable, eq(conversationsTable.id, messages.conversationId))
          .where(and(
            eq(messages.conversationId, conversationId),
            eq(conversationsTable.type, 'page'),
            eq(conversationsTable.contextId, pageId),
            eq(messages.isActive, true),
            ne(messages.status, 'streaming')
          ))
          .orderBy(asc(messages.createdAt), asc(messages.id));

        if (conversationMessages.length === 0) {
          return {
            success: false,
            error: `Conversation "${conversationId}" not found or has no messages`,
          };
        }

        const totalMessages = conversationMessages.length;

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
        const selectedMessages = conversationMessages.slice(effectiveStart - 1, effectiveEnd);

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
