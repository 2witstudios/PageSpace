import { tool } from 'ai';
import { z } from 'zod';
import { canActorEditPage, canActorDeletePage, canActorManageDrive, driveDeniedByAppToken } from './actor-permissions';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { PageType } from '@pagespace/lib/utils/enums';
import { isAIChatPage, isDocumentPage, isCodePage, getDefaultContent, getCreatablePageTypes, getPageTypeConfig } from '@pagespace/lib/content/page-types.config';
import { parseSheetContent, serializeSheetContent, updateSheetCells, isValidCellAddress, isSheetType } from '@pagespace/lib/sheets/sheet';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { logPageActivity, logDriveActivity, getActorInfo, type ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import { detectPageContentFormat } from '@pagespace/lib/content/page-content-format';
import { hashWithPrefix } from '@pagespace/lib/utils/hash-utils';
import { computePageStateHash, createPageVersion } from '@pagespace/lib/services/page-version-service';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { driveRepository } from '@pagespace/lib/repositories/drive-repository';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { db } from '@pagespace/db/db';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { applyPageMutation, type PageMutationContext } from '@/services/api/page-mutation-service';
import { broadcastPageEvent, createPageEventPayload, broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import type { ToolExecutionContext } from '../core/types';
import { maskIdentifier } from '@/lib/logging/mask';
import { ensureTaskListForPage } from '@/services/api/task-sync-service';
import { replaceLines } from '@/lib/editor/line-edit';
import { insertAtAnchor } from '@/lib/editor/text-edit';
import { resolveOrThrowPageId } from './page-context-defaults';

const pageWriteLogger = loggers.ai.child({ module: 'page-write-tools' });

// Helper: Non-blocking activity logging with AI context (fire-and-forget)
function logPageActivityAsync(
  userId: string,
  action: ActivityOperation,
  page: { id: string; title: string; driveId: string; content?: string },
  context: ToolExecutionContext,
  options?: {
    metadata?: Record<string, unknown>;
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    updatedFields?: string[];
    contentRef?: string;
    contentSize?: number;
    contentFormat?: 'text' | 'html' | 'json' | 'tiptap';
    streamId?: string;
    streamSeq?: number;
    changeGroupId?: string;
    changeGroupType?: 'user' | 'ai' | 'automation' | 'system';
    stateHashBefore?: string;
    stateHashAfter?: string;
  }
) {
  // Build metadata with agent chain context (Tier 1)
  const chainMetadata = {
    ...options?.metadata,
    ...(context.parentAgentId && { parentAgentId: context.parentAgentId }),
    ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
    ...(context.agentChain?.length && { agentChain: context.agentChain }),
    ...(context.requestOrigin && { requestOrigin: context.requestOrigin }),
  };

  getActorInfo(context.userId)
    .then(actorInfo => {
      logPageActivity(userId, action, page, {
        ...actorInfo,
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
        metadata: chainMetadata,
        previousValues: options?.previousValues,
        newValues: options?.newValues,
        updatedFields: options?.updatedFields,
        contentRef: options?.contentRef,
        contentSize: options?.contentSize,
        contentFormat: options?.contentFormat,
        streamId: options?.streamId,
        streamSeq: options?.streamSeq,
        changeGroupId: options?.changeGroupId,
        changeGroupType: options?.changeGroupType,
        stateHashBefore: options?.stateHashBefore,
        stateHashAfter: options?.stateHashAfter,
      });
    })
    .catch(err => {
      pageWriteLogger.warn('Failed to get actor info for logging', { error: err });
      // Still log the activity without actor info
      logPageActivity(userId, action, page, {
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
        metadata: chainMetadata,
        previousValues: options?.previousValues,
        newValues: options?.newValues,
        updatedFields: options?.updatedFields,
        contentRef: options?.contentRef,
        contentSize: options?.contentSize,
        contentFormat: options?.contentFormat,
        streamId: options?.streamId,
        streamSeq: options?.streamSeq,
        changeGroupId: options?.changeGroupId,
        changeGroupType: options?.changeGroupType,
        stateHashBefore: options?.stateHashBefore,
        stateHashAfter: options?.stateHashAfter,
      });
    });
}

async function buildAiMutationContext(
  context: ToolExecutionContext,
  options?: {
    metadata?: Record<string, unknown>;
    changeGroupId?: string;
    resourceType?: PageMutationContext['resourceType'];
  }
): Promise<PageMutationContext> {
  const chainMetadata = {
    ...options?.metadata,
    ...(context.parentAgentId && { parentAgentId: context.parentAgentId }),
    ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
    ...(context.agentChain?.length && { agentChain: context.agentChain }),
    ...(context.requestOrigin && { requestOrigin: context.requestOrigin }),
  };

  let actorEmail = 'unknown@system';
  let actorDisplayName: string | undefined;

  try {
    const actorInfo = await getActorInfo(context.userId);
    actorEmail = actorInfo.actorEmail;
    actorDisplayName = actorInfo.actorDisplayName ?? undefined;
  } catch (error) {
    pageWriteLogger.warn('Failed to get actor info for mutation context', { error });
  }

  return {
    userId: context.userId,
    actorEmail,
    actorDisplayName,
    isAiGenerated: true,
    aiProvider: context.aiProvider ?? 'unknown',
    aiModel: context.aiModel ?? 'unknown',
    aiConversationId: context.conversationId,
    metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
    changeGroupId: options?.changeGroupId,
    changeGroupType: 'ai',
    resourceType: options?.resourceType,
  };
}

// Helper: Non-blocking drive activity logging with AI context (fire-and-forget)
function logDriveActivityAsync(
  userId: string,
  action: 'create' | 'update' | 'delete' | 'restore' | 'trash' | 'ownership_transfer',
  drive: { id: string; name: string },
  context: ToolExecutionContext,
  options?: {
    metadata?: Record<string, unknown>;
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
  }
) {
  // Build metadata with agent chain context (Tier 1)
  const chainMetadata = {
    ...options?.metadata,
    ...(context.parentAgentId && { parentAgentId: context.parentAgentId }),
    ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
    ...(context.agentChain?.length && { agentChain: context.agentChain }),
    ...(context.requestOrigin && { requestOrigin: context.requestOrigin }),
  };

  getActorInfo(context.userId)
    .then(actorInfo => {
      logDriveActivity(userId, action, drive, {
        ...actorInfo,
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
        metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
        previousValues: options?.previousValues,
        newValues: options?.newValues,
      });
    })
    .catch(err => {
      pageWriteLogger.warn('Failed to get actor info for drive logging', { error: err });
      logDriveActivity(userId, action, drive, {
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
        metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
        previousValues: options?.previousValues,
        newValues: options?.newValues,
      });
    });
}

// Helper: Trash a single page or recursively with children
async function trashPage(
  userId: string,
  pageId: string,
  withChildren: boolean,
  context: ToolExecutionContext
): Promise<{ page: { id: string; title: string; type: string; driveId: string; parentId: string | null }; childrenCount: number }> {
  // Use repository seam for page lookup
  const page = await pageRepository.findById(pageId);

  if (!page) {
    throw new Error(`Page with ID "${pageId}" not found`);
  }

  if (withChildren) {
    const canDelete = await canActorDeletePage(context, page.id);
    if (!canDelete) {
      throw new Error('Insufficient permissions to trash this page and its children');
    }
  } else {
    const canEdit = await canActorEditPage(context as ToolExecutionContext, page.id);
    if (!canEdit) {
      throw new Error('Insufficient permissions to trash this page');
    }
  }

  let childrenCount = 0;

  const changeGroupId = createChangeGroupId();
  const baseContext = await buildAiMutationContext(context, {
    metadata: { trashChildren: withChildren },
    changeGroupId,
  });

  if (withChildren) {
    // Use repository seam for recursive child lookup
    const childPageIds = await pageRepository.getChildIds(page.driveId, page.id);
    childrenCount = childPageIds.length;
    const allPageIds = [page.id, ...childPageIds];

    for (const targetId of allPageIds) {
      const targetPage = targetId === page.id ? page : await pageRepository.findById(targetId);
      if (!targetPage) {
        continue;
      }

      await applyPageMutation({
        pageId: targetPage.id,
        operation: 'trash',
        updates: { isTrashed: true, trashedAt: new Date() },
        updatedFields: ['isTrashed', 'trashedAt'],
        expectedRevision: typeof targetPage.revision === 'number' ? targetPage.revision : undefined,
        context: baseContext,
      });
    }
  } else {
    // Re-home live children to the grandparent before trashing the parent, mirroring
    // pageService.trashPage's move-children-up branch. Without this, the children would
    // be stranded under a trashed parent and surface as bogus top-level sidebar items.
    const children = await pageRepository.getDirectChildren(page.driveId, page.id);
    for (const child of children) {
      await applyPageMutation({
        pageId: child.id,
        operation: 'move',
        updates: { parentId: page.parentId, originalParentId: page.id },
        updatedFields: ['parentId', 'originalParentId'],
        expectedRevision: typeof child.revision === 'number' ? child.revision : undefined,
        context: baseContext,
      });
    }

    await applyPageMutation({
      pageId: page.id,
      operation: 'trash',
      updates: { isTrashed: true, trashedAt: new Date() },
      updatedFields: ['isTrashed', 'trashedAt'],
      expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
      context: baseContext,
    });
  }

  await broadcastPageEvent(
    createPageEventPayload(page.driveId, page.id, 'trashed', { title: page.title, parentId: page.parentId })
  );

  return { page: { id: page.id, title: page.title, type: page.type, driveId: page.driveId, parentId: page.parentId }, childrenCount };
}

// Helper: Trash a drive
async function trashDrive(
  context: ToolExecutionContext,
  driveId: string,
  confirmDriveName: string
): Promise<{ id: string; name: string; slug: string }> {
  // Owner or admin — mirrors DELETE /api/drives/[driveId], which allows both,
  // not just the owner (canActorManageDrive handles MCP scope/app-token ceilings).
  if (!(await canActorManageDrive(context, driveId))) {
    throw new Error('Drive not found or you do not have permission to delete it');
  }

  const drive = await driveRepository.findById(driveId);

  if (!drive) {
    throw new Error('Drive not found or you do not have permission to delete it');
  }

  if (isHomeDrive(drive)) {
    throw new Error(homeDriveActionError(drive, 'trash')!);
  }

  if (drive.name !== confirmDriveName) {
    throw new Error(`Drive name confirmation failed. Expected "${drive.name}" but got "${confirmDriveName}"`);
  }

  if (drive.isTrashed) {
    throw new Error('Drive is already in trash');
  }

  // Get recipients BEFORE trashing (ensures we have valid member list)
  const trashRecipientUserIds = await getDriveRecipientUserIds(drive.id);

  // Use repository seam for drive trash
  await driveRepository.trash(drive.id);

  await broadcastDriveEvent(
    createDriveEventPayload(drive.id, 'deleted', { name: drive.name, slug: drive.slug }),
    trashRecipientUserIds
  );

  return { id: drive.id, name: drive.name, slug: drive.slug };
}

// Helper: Restore a page from trash
async function restorePage(
  userId: string,
  pageId: string,
  context: ToolExecutionContext
): Promise<{ id: string; title: string; type: string; driveId: string; parentId: string | null }> {
  // Use repository seam for trashed page lookup
  const trashedPage = await pageRepository.findTrashedById(pageId);

  if (!trashedPage) {
    throw new Error(`Trashed page with ID "${pageId}" not found`);
  }

  const canEdit = await canActorEditPage(context as ToolExecutionContext, trashedPage.id);
  if (!canEdit) {
    throw new Error('Insufficient permissions to restore this page');
  }

  const mutationContext = await buildAiMutationContext(context, {
    metadata: { restoreSource: 'trash' },
  });

  await applyPageMutation({
    pageId: trashedPage.id,
    operation: 'restore',
    updates: { isTrashed: false, trashedAt: null },
    updatedFields: ['isTrashed', 'trashedAt'],
    expectedRevision: typeof trashedPage.revision === 'number' ? trashedPage.revision : undefined,
    context: mutationContext,
  });

  await broadcastPageEvent(
    createPageEventPayload(trashedPage.driveId, trashedPage.id, 'restored', {
      title: trashedPage.title,
      parentId: trashedPage.parentId,
    })
  );

  return { id: trashedPage.id, title: trashedPage.title, type: trashedPage.type, driveId: trashedPage.driveId, parentId: trashedPage.parentId };
}

// Helper: Restore a drive from trash
async function restoreDrive(
  userId: string,
  driveId: string
): Promise<{ id: string; name: string; slug: string }> {
  // Use repository seam for drive lookup
  const drive = await driveRepository.findByIdAndOwner(driveId, userId);

  if (!drive) {
    throw new Error('Drive not found or you do not have permission to restore it');
  }

  if (isHomeDrive(drive)) {
    throw new Error(homeDriveActionError(drive, 'restore')!);
  }

  if (!drive.isTrashed) {
    throw new Error('Drive is not in trash');
  }

  // Use repository seam for drive restore
  const restoredDrive = await driveRepository.restore(drive.id);

  const restoreRecipientUserIds = await getDriveRecipientUserIds(restoredDrive.id);
  await broadcastDriveEvent(
    createDriveEventPayload(restoredDrive.id, 'updated', { name: restoredDrive.name, slug: restoredDrive.slug }),
    restoreRecipientUserIds
  );

  return { id: restoredDrive.id, name: restoredDrive.name, slug: restoredDrive.slug };
}

export const pageWriteTools = {
  /**
   * Replace specific line(s) in a document
   */
  replace_lines: tool({
    description: 'Replace one or more lines in a document or code page with new content. Specify start and end line numbers (1-based indexing). Omit pageId to edit the page currently in view.',
    inputSchema: z.object({
      title: z.string().describe('The document title for display context'),
      pageId: z.string().optional().describe('The unique ID of the page to edit. Defaults to the page currently in view if omitted.'),
      startLine: z.number().describe('Starting line number (1-based)'),
      endLine: z.number().optional().describe('Ending line number (1-based, optional, defaults to startLine)'),
      content: z.string().describe('New content to replace the lines with'),
    }),
    execute: async ({ title, pageId: pageIdArg, startLine, endLine = startLine, content }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, context as ToolExecutionContext);

      try {
        // Get the page via repository seam
        const page = await pageRepository.findById(pageId);

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        // Check if this is a FILE type page - these are read-only
        if (page.type === 'FILE') {
          return {
            success: false,
            error: 'Cannot edit FILE pages',
            message: 'This is an uploaded file. File content is read-only and managed by the system.',
            suggestion: 'To modify content, create a new document page instead of editing the uploaded file.',
            pageInfo: {
              pageId: page.id,
              title: page.title,
              type: page.type,
              mimeType: page.mimeType
            }
          };
        }

        // Check if this is a SHEET type page - use edit_sheet_cells instead
        if (isSheetType(page.type as PageType)) {
          return {
            success: false,
            error: 'Cannot use line editing on sheets',
            message: 'Sheet pages use structured cell data. Use edit_sheet_cells tool instead for cell-level edits.',
            suggestion: 'Use the edit_sheet_cells tool with cell addresses (A1, B2, etc.) to modify sheet content.',
            pageInfo: {
              pageId: page.id,
              title: page.title,
              type: page.type
            }
          };
        }

        // Check user permissions (need EDIT access)
        const canEdit = await canActorEditPage(context as ToolExecutionContext,page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this document');
        }

        // Apply the line edit. CODE and markdown pages have natural line
        // structure (and CODE may contain raw HTML/XML that addLineBreaksForAI
        // would mangle); HTML documents are normalized for line-based editing.
        // oldContent is normalized identically to newContent so a small edit
        // diffs as a small change rather than a full-document replacement.
        const isRawText = page.contentMode === 'markdown' || isCodePage(page.type as PageType);
        const { oldContent, newContent, newLineCount, changeType } = replaceLines({
          content: page.content,
          startLine,
          endLine,
          replacement: content,
          isRawText,
        });
        const isDeletion = changeType === 'deletion';

        const mutationContext = await buildAiMutationContext(context as ToolExecutionContext, {
          metadata: {
            linesChanged: endLine - startLine + 1,
            changeType,
          },
        });

        await applyPageMutation({
          pageId: page.id,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: mutationContext,
        });

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

        return {
          success: true,
          pageId: page.id,
          title: page.title,
          type: page.type,
          contentMode: page.contentMode || 'html',
          oldContent,
          newContent,
          linesReplaced: endLine - startLine + 1,
          newLineCount,
          message: isDeletion
            ? `Successfully removed lines ${startLine}-${endLine}`
            : `Successfully replaced lines ${startLine}-${endLine}`,
          summary: isDeletion
            ? `Removed ${endLine - startLine + 1} line${endLine - startLine + 1 === 1 ? '' : 's'} from "${page.title}"`
            : `Updated "${page.title}" by replacing ${endLine - startLine + 1} line${endLine - startLine + 1 === 1 ? '' : 's'}`,
          stats: {
            linesChanged: endLine - startLine + 1,
            totalLines: newLineCount,
            changeType
          },
          nextSteps: [
            'Review the updated content to ensure it meets requirements',
            'Consider making additional edits if needed'
          ]
        };
      } catch (error) {
        pageWriteLogger.error('Failed to replace lines', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          title,
        });
        throw new Error(`Failed to replace lines in "${title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Create new documents, folders, or other content
   */
  create_page: tool({
    // Both the type list and its glosses come from the same config the schema
    // below is built from, so the prose can never drift from what the tool
    // actually accepts — the hardcoded list here had gone stale (#2150).
    description: `Create new pages in the workspace. Supported page types: ${getCreatablePageTypes()
      .map((type) => `${type} (${getPageTypeConfig(type).description})`)
      .join(', ')}. Any page type can contain any other page type as children with infinite nesting. For AI_CHAT pages, use update_agent_config after creation to configure agent behavior.`,
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to create the page in'),
      parentId: z.string().optional().describe('The unique ID of the parent page from list_pages - REQUIRED when creating inside any page (folder, document, channel, etc). Only omit for root-level pages in the drive.'),
      title: z.string().describe('The title of the new page'),
      type: z.enum(getCreatablePageTypes() as [string, ...string[]]).describe('The type of page to create'),
      contentMode: z.enum(['html', 'markdown']).optional().describe('Content mode for DOCUMENT pages. Defaults to html. Use markdown for markdown-native documents.'),
    }),
    execute: async ({ driveId, parentId, title, type, contentMode }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the drive via repository seam
        const drive = await driveRepository.findByIdBasic(driveId);

        if (!drive) {
          throw new Error(`Drive with ID "${driveId}" not found`);
        }

        // If parentId is provided, verify it exists and belongs to this drive
        if (parentId) {
          const parentExists = await pageRepository.existsInDrive(parentId, driveId);
          if (!parentExists) {
            throw new Error(`Parent page with ID "${parentId}" not found in this drive`);
          }
        }

        // Check permissions for page creation.
        // The drive is the root parent node: creating a child anywhere requires
        // canEdit on the parent. For root-level pages the drive is the parent.
        if (parentId) {
          const canEdit = await canActorEditPage(context as ToolExecutionContext, parentId);
          if (!canEdit) {
            throw new Error('Insufficient permissions to create pages in this folder');
          }
        } else {
          const canEdit = await canActorEditPage(context as ToolExecutionContext, driveId);
          if (!canEdit) {
            throw new Error('Insufficient permissions to create pages in this drive');
          }
        }

        // Get next position via repository seam
        const nextPosition = await pageRepository.getNextPosition(drive.id, parentId || null);

        const initialContent = getDefaultContent(type as PageType);
        const contentFormat = detectPageContentFormat(initialContent);
        const contentRef = hashWithPrefix(contentFormat, initialContent);
        const stateHash = computePageStateHash({
          title,
          contentRef,
          parentId: parentId || null,
          position: nextPosition,
          isTrashed: false,
          type,
          driveId: drive.id,
        });
        const changeGroupId = createChangeGroupId();

        // Create the page via repository seam
        const newPage = await pageRepository.create({
          title,
          type: type as PageType,
          content: initialContent,
          contentMode: type === 'DOCUMENT' && contentMode ? contentMode : 'html',
          position: nextPosition,
          driveId: drive.id,
          parentId: parentId || null,
          isTrashed: false,
          revision: 0,
          stateHash,
          updatedAt: new Date(),
          createdBy: userId,
        });

        // AI_CHAT pages are agents — they need a drive membership to act with
        // permissions. Without this row the agent has no role and is denied access.
        if (isAIChatPage(type as PageType)) {
          await db.insert(driveAgentMembers).values({
            driveId: drive.id,
            agentPageId: newPage.id,
            role: 'MEMBER',
            addedBy: userId,
          });
        }

        // TASK_LIST pages need their `task_lists` + default status configs seeded
        // immediately — unlike the browser's page-creation flow, this repository-level
        // create() bypasses pageService.createPage()'s seeding, so without this the
        // Kanban UI crashes on first load with no status-group config to render.
        if (type === 'TASK_LIST') {
          await ensureTaskListForPage(db, {
            pageId: newPage.id,
            title: newPage.title,
            userId,
          });
        }

        await createPageVersion({
          pageId: newPage.id,
          driveId: drive.id,
          createdBy: userId,
          source: 'system',
          content: initialContent,
          contentFormat,
          pageRevision: 0,
          stateHash,
          changeGroupId,
          changeGroupType: 'ai',
          metadata: { source: 'ai_tool' },
        });

        // Broadcast page creation event
        await broadcastPageEvent(
          createPageEventPayload(driveId, newPage.id, 'created', {
            parentId,
            title: newPage.title,
            type: newPage.type
          })
        );

        // Log activity for AI-generated page creation (fire-and-forget)
        logPageActivityAsync(userId, 'create', {
          id: newPage.id,
          title: newPage.title,
          driveId: drive.id,
        }, context as ToolExecutionContext, {
          metadata: { pageType: newPage.type, parentId },
          contentRef,
          contentSize: Buffer.byteLength(initialContent, 'utf8'),
          contentFormat,
          streamId: newPage.id,
          streamSeq: 0,
          changeGroupId,
          changeGroupType: 'ai',
          stateHashAfter: stateHash,
        });

        // Build response
        const nextSteps: string[] = [];
        if (isDocumentPage(type as PageType)) {
          nextSteps.push('Add content to the new document');
        } else if (isAIChatPage(type as PageType)) {
          nextSteps.push('Use update_agent_config to configure the agent behavior');
          nextSteps.push('Start chatting with your new AI agent');
        } else {
          nextSteps.push('Organize related pages');
        }
        nextSteps.push(`New page ID: ${newPage.id} - use this for further operations`);

        // Creating a page shifts the agent's focus onto it for the rest of
        // this turn — same mutate-in-place pattern as switch_machine, so a
        // later tool call in this turn that omits pageId defaults to the
        // page just created, not the page the user was viewing at turn start.
        const rawContext = context as ToolExecutionContext | undefined;
        if (rawContext) {
          rawContext.currentWorkingPage = { id: newPage.id, title: newPage.title, type: newPage.type };
        }

        return {
          success: true,
          id: newPage.id,
          title: newPage.title,
          type: newPage.type,
          contentMode: isDocumentPage(type as PageType) && contentMode ? contentMode : 'html',
          parentId: parentId || 'root',
          message: `Successfully created ${type.toLowerCase()} page "${title}"`,
          summary: `Created new ${type.toLowerCase()} "${title}" in ${parentId ? `parent ${parentId}` : 'drive root'}`,
          stats: {
            pageType: newPage.type,
            location: parentId ? `Parent ID: ${parentId}` : 'Drive root',
          },
          nextSteps
        };
      } catch (error) {
        pageWriteLogger.error('Failed to create page', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          driveId: maskIdentifier(driveId),
          parentId: maskIdentifier(parentId || undefined),
          title,
          type,
        });
        throw new Error(`Failed to create page: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Rename an existing page
   */
  rename_page: tool({
    description: 'Change the title of an existing page. Updates the page title while preserving all content and structure. Omit pageId to rename the page currently in view.',
    inputSchema: z.object({
      currentTitle: z.string().describe('The current title of the page for display context'),
      pageId: z.string().optional().describe('The unique ID of the page to rename. Defaults to the page currently in view if omitted.'),
      title: z.string().describe('New title for the page'),
    }),
    execute: async ({ currentTitle, pageId: pageIdArg, title }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, context as ToolExecutionContext);

      try {
        // Get the page via repository seam
        const page = await pageRepository.findById(pageId);

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        // Check permissions
        const canEdit = await canActorEditPage(context as ToolExecutionContext,page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to rename this page');
        }

        const mutationContext = await buildAiMutationContext(context as ToolExecutionContext);
        await applyPageMutation({
          pageId: page.id,
          operation: 'update',
          updates: { title },
          updatedFields: ['title'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: mutationContext,
        });

        // Broadcast page update event for title change
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'updated', {
            title,
            parentId: page.parentId
          })
        );

        // Keep the cached working-page title in sync if this IS the agent's
        // current focus — otherwise a later omitted-pageId call in the same
        // turn would resolve correctly by id but report the pre-rename title.
        const rawContext = context as ToolExecutionContext | undefined;
        if (rawContext?.currentWorkingPage?.id === page.id) {
          rawContext.currentWorkingPage = { ...rawContext.currentWorkingPage, title };
        }

        return {
          success: true,
          id: page.id,
          title,
          type: page.type,
          message: `Successfully renamed page from "${currentTitle}" to "${title}"`,
          summary: `Renamed page to "${title}"`,
          stats: {
            pageType: page.type,
            newTitle: title
          },
          nextSteps: [
            'Update any references to this page in other documents',
            'Consider if related pages need similar organization'
          ]
        };
      } catch (error) {
        pageWriteLogger.error('Failed to rename page', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          currentTitle,
          newTitle: title,
        });
        throw new Error(`Failed to rename page "${currentTitle}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a page to trash (soft delete)
   */
  trash_page: tool({
    description: 'Move a page to trash (soft delete). By default all child pages are trashed recursively with the parent; pass withChildren: false to instead move children up to the grandparent and keep them.',
    inputSchema: z.object({
      id: z.string().describe('The unique ID of the page to trash'),
      title: z.string().optional().describe('Optional page title for display/error context only — the real title is fetched by ID'),
      withChildren: z.boolean().optional().default(true).describe('Whether to trash all children recursively (default true). Set false to move children up to the grandparent instead of trashing them.'),
    }),
    execute: async ({ id, title, withChildren = true }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        const { page, childrenCount } = await trashPage(userId, id, withChildren, context as ToolExecutionContext);

        return {
          success: true,
          type: 'page',
          id: page.id,
          title: page.title,
          pageType: page.type,
          childrenCount: withChildren ? childrenCount : undefined,
          message: withChildren
            ? `Successfully moved "${page.title}" and ${childrenCount} children to trash`
            : `Successfully moved "${page.title}" to trash`,
        };
      } catch (error) {
        pageWriteLogger.error('Failed to trash page', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(id),
          title,
        });
        throw new Error(`Failed to trash page${title ? ` "${title}"` : ''}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a drive (workspace) to trash — destructive, requires name confirmation
   */
  trash_drive: tool({
    description: 'Move an entire drive (workspace) to trash. This is destructive and affects all pages in the drive. Requires confirmDriveName to exactly match the drive name as a safety confirmation.',
    inputSchema: z.object({
      id: z.string().describe('The unique ID of the drive to trash'),
      confirmDriveName: z
        .string()
        .trim()
        .min(1, 'confirmDriveName is required')
        .describe('The exact name of the drive — REQUIRED confirmation to prevent accidental drive deletion'),
    }),
    execute: async ({ id, confirmDriveName }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      if (await driveDeniedByAppToken(context as ToolExecutionContext, id, 'manage')) {
        throw new Error('This token does not have access to this drive');
      }

      try {
        if (!confirmDriveName) {
          throw new Error('Drive name confirmation is required for trashing drives (confirmDriveName parameter)');
        }
        const drive = await trashDrive(context as ToolExecutionContext, id, confirmDriveName);

        // Log activity for AI-generated drive trash (fire-and-forget)
        logDriveActivityAsync(userId, 'trash', {
          id: drive.id,
          name: drive.name,
        }, context as ToolExecutionContext, {
          previousValues: { isTrashed: false },
          newValues: { isTrashed: true },
        });

        return {
          success: true,
          type: 'drive',
          id: drive.id,
          name: drive.name,
          slug: drive.slug,
          message: `Successfully moved workspace "${drive.name}" to trash`,
          warning: 'The drive and all its pages are now inaccessible but can be restored',
        };
      } catch (error) {
        pageWriteLogger.error('Failed to trash drive', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          driveId: maskIdentifier(id),
        });
        throw new Error(`Failed to trash drive: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Restore a page from trash
   */
  restore_page: tool({
    description: 'Restore a trashed page back to its original location.',
    inputSchema: z.object({
      id: z.string().describe('The unique ID of the page to restore'),
    }),
    execute: async ({ id }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        const page = await restorePage(userId, id, context as ToolExecutionContext);

        return {
          success: true,
          type: 'page',
          id: page.id,
          title: page.title,
          pageType: page.type,
          message: `Successfully restored "${page.title}" from trash`,
        };
      } catch (error) {
        pageWriteLogger.error('Failed to restore page', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(id),
        });
        throw new Error(`Failed to restore page: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Restore a drive (workspace) from trash
   */
  restore_drive: tool({
    description: 'Restore a trashed drive (workspace) back to active state.',
    inputSchema: z.object({
      id: z.string().describe('The unique ID of the drive to restore'),
    }),
    execute: async ({ id }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      if (await driveDeniedByAppToken(context as ToolExecutionContext, id, 'manage')) {
        throw new Error('This token does not have access to this drive');
      }

      try {
        const drive = await restoreDrive(userId, id);

        // Log activity for AI-generated drive restore (fire-and-forget)
        logDriveActivityAsync(userId, 'restore', {
          id: drive.id,
          name: drive.name,
        }, context as ToolExecutionContext, {
          previousValues: { isTrashed: true },
          newValues: { isTrashed: false },
        });

        return {
          success: true,
          type: 'drive',
          id: drive.id,
          name: drive.name,
          slug: drive.slug,
          message: `Successfully restored workspace "${drive.name}" from trash`,
        };
      } catch (error) {
        pageWriteLogger.error('Failed to restore drive', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          driveId: maskIdentifier(id),
        });
        throw new Error(`Failed to restore drive: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a page to a different parent or reorder position
   */
  move_page: tool({
    description: 'Move a page to a different parent folder or change its position within the current parent. Omit pageId to move the page currently in view.',
    inputSchema: z.object({
      title: z.string().describe('The title of the page being moved for display context'),
      pageId: z.string().optional().describe('The unique ID of the page to move. Defaults to the page currently in view if omitted.'),
      newParentTitle: z.string().optional().describe('Title of the destination folder (omit for root level)'),
      newParentId: z.string().optional().describe('The unique ID of the new parent page (omit for root level)'),
      position: z.number().describe('Position within the new parent (1-based, higher numbers appear later)'),
    }),
    execute: async ({ title, pageId: pageIdArg, newParentTitle, newParentId, position }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, context as ToolExecutionContext);

      try {
        // Get the page to move via repository seam
        const page = await pageRepository.findById(pageId);

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        // Moving/reordering a page requires drive owner or admin — mirrors the
        // /api/pages/reorder REST route's authorization bar for the same operation.
        const canManage = await canActorManageDrive(context as ToolExecutionContext, page.driveId);
        if (!canManage) {
          throw new Error('Only drive owners and admins can move pages');
        }

        // If newParentId is provided, verify it exists and is in the same drive
        if (newParentId) {
          const parentExists = await pageRepository.existsInDrive(newParentId, page.driveId);
          if (!parentExists) {
            throw new Error(`Parent page with ID "${newParentId}" not found in this drive`);
          }
        }

        const mutationContext = await buildAiMutationContext(context as ToolExecutionContext, {
          metadata: { newParentId, position },
        });

        await applyPageMutation({
          pageId: page.id,
          operation: 'move',
          updates: {
            parentId: newParentId ?? null,
            position: position,
          },
          updatedFields: ['parentId', 'position'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: mutationContext,
        });

        // Broadcast page move event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'moved', {
            parentId: newParentId,
            title: page.title
          })
        );

        return {
          success: true,
          position,
          id: page.id,
          title: page.title,
          type: page.type,
          message: newParentId
            ? `Successfully moved "${page.title}" to "${newParentTitle ?? 'parent folder'}" at position ${position}`
            : `Successfully moved "${page.title}" to root at position ${position}`,
        };
      } catch (error) {
        pageWriteLogger.error('Failed to move page', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          title,
          newParentId: maskIdentifier(newParentId || undefined),
        });
        throw new Error(`Failed to move page "${title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Insert content before or after an anchor line in a document or code page
   */
  insert_content: tool({
    description: 'Anchored line insert — adds a new line of content immediately before or after the first line containing a given anchor string. Useful for agents that need to insert content relative to headings or landmarks without knowing exact line numbers. Omit pageId to edit the page currently in view.',
    inputSchema: z.object({
      title: z.string().describe('The document title for display context'),
      pageId: z.string().optional().describe('The unique ID of the page to edit. Defaults to the page currently in view if omitted.'),
      anchor: z.string().min(1).describe('Text to search for within a line — the first line containing this substring is used'),
      content: z.string().describe('Content to insert as a new line'),
      position: z.enum(['before', 'after']).describe('Insert the new line before or after the anchor line'),
    }),
    execute: async ({ title, pageId: pageIdArg, anchor, content, position }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, context as ToolExecutionContext);

      try {
        const page = await pageRepository.findById(pageId);
        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        if (page.type === 'FILE') {
          return {
            success: false,
            error: 'Cannot edit FILE pages',
            message: 'This is an uploaded file. File content is read-only.',
            pageInfo: { pageId: page.id, title: page.title, type: page.type, mimeType: page.mimeType },
          };
        }

        if (isSheetType(page.type as PageType)) {
          return {
            success: false,
            error: 'Cannot use line insertion on sheets',
            message: 'Use edit_sheet_cells for sheet pages.',
            pageInfo: { pageId: page.id, title: page.title, type: page.type },
          };
        }

        const canEdit = await canActorEditPage(context as ToolExecutionContext, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this document');
        }

        const isRawText = page.contentMode === 'markdown' || isCodePage(page.type as PageType);
        const { oldContent, newContent, inserted, anchorLine } = insertAtAnchor({
          content: page.content,
          anchor,
          insertion: content,
          position,
          isRawText,
        });

        if (!inserted) {
          return {
            success: true,
            pageId: page.id,
            title: page.title,
            inserted: false,
            anchorLine: null,
            message: `Anchor text not found in "${page.title}"`,
          };
        }

        const mutationContext = await buildAiMutationContext(context as ToolExecutionContext, {
          metadata: { anchorLine, position },
        });

        await applyPageMutation({
          pageId: page.id,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: mutationContext,
        });

        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', { title: page.title })
        );

        return {
          success: true,
          pageId: page.id,
          title: page.title,
          inserted: true,
          anchorLine,
          oldContent,
          newContent,
          message: `Inserted content ${position} line ${anchorLine} in "${page.title}"`,
        };
      } catch (error) {
        pageWriteLogger.error('Failed to insert content', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          title,
        });
        throw new Error(`Failed to insert content in "${title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Edit cells in a sheet page
   */
  edit_sheet_cells: tool({
    description: 'Edit one or more cells in a SHEET page. Use A1-style cell addresses. Supports batch updates for efficiency. Values starting with "=" are treated as formulas. Omit pageId to edit the sheet currently in view.',
    inputSchema: z.object({
      pageId: z.string().optional().describe('The unique ID of the sheet page to edit. Defaults to the page currently in view if omitted.'),
      cells: z.array(z.object({
        address: z.string().describe('Cell address in A1-style format (e.g., "A1", "B2", "AA100")'),
        value: z.string().describe('Value to set in the cell. Values starting with "=" are formulas. Empty string clears the cell.'),
      })).min(1).describe('Array of cell updates to apply'),
    }),
    execute: async ({ pageId: pageIdArg, cells }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const pageId = resolveOrThrowPageId(pageIdArg, context as ToolExecutionContext);

      try {
        // Get the page via repository seam
        const page = await pageRepository.findById(pageId);

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        // Verify this is a SHEET type page
        if (!isSheetType(page.type as PageType)) {
          return {
            success: false,
            error: 'Page is not a sheet',
            message: `This page is a ${page.type}. Use edit_sheet_cells only on SHEET pages.`,
            suggestion: 'Use replace_lines for document editing.',
            pageInfo: {
              pageId: page.id,
              title: page.title,
              type: page.type
            }
          };
        }

        // Check user permissions
        const canEdit = await canActorEditPage(context as ToolExecutionContext,page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this sheet');
        }

        // Validate all cell addresses upfront
        const invalidAddresses = cells.filter(cell => !isValidCellAddress(cell.address));
        if (invalidAddresses.length > 0) {
          const examples = invalidAddresses.slice(0, 3).map(c => `"${c.address}"`).join(', ');
          throw new Error(`Invalid cell addresses: ${examples}. Use A1-style format (e.g., A1, B2, AA100).`);
        }

        // Parse the existing sheet content
        const sheetData = parseSheetContent(page.content);

        // Apply the cell updates
        const updatedSheet = updateSheetCells(sheetData, cells);

        // Serialize back to TOML format
        const newContent = serializeSheetContent(updatedSheet, { pageId: page.id });

        const mutationContext = await buildAiMutationContext(context as ToolExecutionContext, {
          metadata: {
            cellsUpdated: cells.length,
          },
        });

        await applyPageMutation({
          pageId: page.id,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: mutationContext,
        });

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

        // Summarize changes for response
        const formulaCount = cells.filter(c => c.value.trim().startsWith('=')).length;
        const valueCount = cells.filter(c => c.value.trim() !== '' && !c.value.trim().startsWith('=')).length;
        const clearCount = cells.filter(c => c.value.trim() === '').length;

        return {
          success: true,
          pageId: page.id,
          title: page.title,
          cellsUpdated: cells.length,
          message: `Successfully updated ${cells.length} cell${cells.length === 1 ? '' : 's'} in "${page.title}"`,
          summary: `Updated sheet "${page.title}": ${valueCount > 0 ? `${valueCount} values` : ''}${formulaCount > 0 ? `${valueCount > 0 ? ', ' : ''}${formulaCount} formulas` : ''}${clearCount > 0 ? `${valueCount + formulaCount > 0 ? ', ' : ''}${clearCount} cleared` : ''}`.trim(),
          stats: {
            totalCellsUpdated: cells.length,
            valuesSet: valueCount,
            formulasSet: formulaCount,
            cellsCleared: clearCount,
            sheetDimensions: {
              rows: updatedSheet.rowCount,
              columns: updatedSheet.columnCount
            }
          },
          updatedCells: cells.map(c => ({
            address: c.address.toUpperCase(),
            type: c.value.trim() === '' ? 'cleared' : c.value.trim().startsWith('=') ? 'formula' : 'value'
          })),
          nextSteps: [
            'Use read_page to verify the sheet content',
            'Continue editing with additional edit_sheet_cells calls if needed'
          ]
        };
      } catch (error) {
        pageWriteLogger.error('Failed to edit sheet cells', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          cellCount: cells.length,
        });
        throw new Error(`Failed to edit sheet cells: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
