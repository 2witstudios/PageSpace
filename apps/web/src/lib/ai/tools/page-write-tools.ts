import { tool } from 'ai';
import { z } from 'zod';
import {
  canUserEditPage,
  canUserDeletePage,
  PageType,
  isAIChatPage,
  isDocumentPage,
  parseSheetContent,
  serializeSheetContent,
  updateSheetCells,
  isValidCellAddress,
  isSheetType,
  loggers,
  logPageActivity,
  logDriveActivity,
  getActorInfo,
  pageRepository,
  driveRepository,
  type ActivityOperation,
} from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload, broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { type ToolExecutionContext } from '../core';
import { maskIdentifier } from '@/lib/logging/mask';

const pageWriteLogger = loggers.ai.child({ module: 'page-write-tools' });

// Helper: Non-blocking activity logging with AI context (fire-and-forget)
function logPageActivityAsync(
  userId: string,
  action: ActivityOperation,
  page: { id: string; title: string; driveId: string; content?: string },
  context: ToolExecutionContext,
  metadata?: Record<string, unknown>
) {
  getActorInfo(context.userId)
    .then(actorInfo => {
      logPageActivity(userId, action, page, {
        ...actorInfo,
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
        metadata,
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
        metadata,
      });
    });
}

// Helper: Non-blocking drive activity logging with AI context (fire-and-forget)
function logDriveActivityAsync(
  userId: string,
  action: ActivityOperation,
  drive: { id: string; name: string },
  context: ToolExecutionContext
) {
  getActorInfo(context.userId)
    .then(actorInfo => {
      logDriveActivity(userId, action, drive, {
        ...actorInfo,
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
      });
    })
    .catch(err => {
      pageWriteLogger.warn('Failed to get actor info for drive logging', { error: err });
      logDriveActivity(userId, action, drive, {
        isAiGenerated: true,
        aiProvider: context.aiProvider ?? 'unknown',
        aiModel: context.aiModel ?? 'unknown',
        aiConversationId: context.conversationId,
      });
    });
}

// Helper: Trash a single page or recursively with children
async function trashPage(
  userId: string,
  pageId: string,
  withChildren: boolean
): Promise<{ page: { id: string; title: string; type: string; driveId: string; parentId: string | null }; childrenCount: number }> {
  // Use repository seam for page lookup
  const page = await pageRepository.findById(pageId);

  if (!page) {
    throw new Error(`Page with ID "${pageId}" not found`);
  }

  if (withChildren) {
    const canDelete = await canUserDeletePage(userId, page.id);
    if (!canDelete) {
      throw new Error('Insufficient permissions to trash this page and its children');
    }
  } else {
    const canEdit = await canUserEditPage(userId, page.id);
    if (!canEdit) {
      throw new Error('Insufficient permissions to trash this page');
    }
  }

  let childrenCount = 0;

  if (withChildren) {
    // Use repository seam for recursive child lookup
    const childPageIds = await pageRepository.getChildIds(page.driveId, page.id);
    childrenCount = childPageIds.length;
    const allPageIds = [page.id, ...childPageIds];

    // Use repository seam for batch trash
    await pageRepository.trashMany(page.driveId, allPageIds);
  } else {
    // Use repository seam for single page trash
    await pageRepository.trash(page.id);
  }

  await broadcastPageEvent(
    createPageEventPayload(page.driveId, page.id, 'trashed', { title: page.title, parentId: page.parentId })
  );

  return { page: { id: page.id, title: page.title, type: page.type, driveId: page.driveId, parentId: page.parentId }, childrenCount };
}

// Helper: Trash a drive
async function trashDrive(
  userId: string,
  driveId: string,
  confirmDriveName: string
): Promise<{ id: string; name: string; slug: string }> {
  // Use repository seam for drive lookup
  const drive = await driveRepository.findByIdAndOwner(driveId, userId);

  if (!drive) {
    throw new Error('Drive not found or you do not have permission to delete it');
  }

  if (drive.name !== confirmDriveName) {
    throw new Error(`Drive name confirmation failed. Expected "${drive.name}" but got "${confirmDriveName}"`);
  }

  if (drive.isTrashed) {
    throw new Error('Drive is already in trash');
  }

  // Use repository seam for drive trash
  await driveRepository.trash(drive.id);

  await broadcastDriveEvent(createDriveEventPayload(drive.id, 'deleted', { name: drive.name, slug: drive.slug }));

  return { id: drive.id, name: drive.name, slug: drive.slug };
}

// Helper: Restore a page from trash
async function restorePage(
  userId: string,
  pageId: string
): Promise<{ id: string; title: string; type: string; driveId: string; parentId: string | null }> {
  // Use repository seam for trashed page lookup
  const trashedPage = await pageRepository.findTrashedById(pageId);

  if (!trashedPage) {
    throw new Error(`Trashed page with ID "${pageId}" not found`);
  }

  const canEdit = await canUserEditPage(userId, trashedPage.id);
  if (!canEdit) {
    throw new Error('Insufficient permissions to restore this page');
  }

  // Use repository seam for page restore
  const restoredPage = await pageRepository.restore(trashedPage.id);

  await broadcastPageEvent(
    createPageEventPayload(trashedPage.driveId, restoredPage.id, 'restored', { title: restoredPage.title, parentId: restoredPage.parentId })
  );

  return { id: restoredPage.id, title: restoredPage.title, type: restoredPage.type, driveId: trashedPage.driveId, parentId: restoredPage.parentId };
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

  if (!drive.isTrashed) {
    throw new Error('Drive is not in trash');
  }

  // Use repository seam for drive restore
  const restoredDrive = await driveRepository.restore(drive.id);

  await broadcastDriveEvent(createDriveEventPayload(restoredDrive.id, 'updated', { name: restoredDrive.name, slug: restoredDrive.slug }));

  return { id: restoredDrive.id, name: restoredDrive.name, slug: restoredDrive.slug };
}

export const pageWriteTools = {
  /**
   * Replace specific line(s) in a document
   */
  replace_lines: tool({
    description: 'Replace one or more lines in a document with new content. Specify start and end line numbers (1-based indexing).',
    inputSchema: z.object({
      path: z.string().describe('The document path using titles like "/driveSlug/Folder Name/Document Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to edit'),
      startLine: z.number().describe('Starting line number (1-based)'),
      endLine: z.number().optional().describe('Ending line number (1-based, optional, defaults to startLine)'),
      content: z.string().describe('New content to replace the lines with'),
    }),
    execute: async ({ path, pageId, startLine, endLine = startLine, content }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this document');
        }

        // Split content into lines
        const lines = page.content.split('\n');
        
        // Validate line numbers
        if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
          throw new Error(`Invalid line range: ${startLine}-${endLine}. Document has ${lines.length} lines.`);
        }

        const isDeletion = content.length === 0;

        // Replace lines (convert to 0-based indexing)
        const replacementSegment = isDeletion ? [] : [content];
        const newLines = [
          ...lines.slice(0, startLine - 1),
          ...replacementSegment,
          ...lines.slice(endLine),
        ];

        const newContent = newLines.join('\n');

        // Update the page content via repository seam
        await pageRepository.update(page.id, { content: newContent });

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

        // Log activity for AI-generated content update (fire-and-forget)
        logPageActivityAsync(userId, 'update', {
          id: page.id,
          title: page.title,
          driveId: page.driveId,
          content: newContent,
        }, context as ToolExecutionContext, {
          linesChanged: endLine - startLine + 1,
          changeType: isDeletion ? 'deletion' : 'replacement',
        });

        return {
          success: true,
          path,
          title: page.title,
          linesReplaced: endLine - startLine + 1,
          newLineCount: newLines.length,
          message: isDeletion
            ? `Successfully removed lines ${startLine}-${endLine}`
            : `Successfully replaced lines ${startLine}-${endLine}`,
          summary: isDeletion
            ? `Removed ${endLine - startLine + 1} line${endLine - startLine + 1 === 1 ? '' : 's'} from "${page.title}"`
            : `Updated "${page.title}" by replacing ${endLine - startLine + 1} line${endLine - startLine + 1 === 1 ? '' : 's'}`,
          stats: {
            linesChanged: endLine - startLine + 1,
            totalLines: newLines.length,
            changeType: isDeletion ? 'deletion' : 'replacement'
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
          path,
        });
        throw new Error(`Failed to replace lines in ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Create new documents, folders, or other content
   */
  create_page: tool({
    description: 'Create new pages in the workspace. Supports all page types: FOLDER (hierarchical organization), DOCUMENT (text content), AI_CHAT (AI conversation spaces), CHANNEL (team discussions), CANVAS (custom HTML/CSS pages), SHEET (spreadsheets with formulas), TASK_LIST (table-based task management). Any page type can contain any other page type as children with infinite nesting. For AI_CHAT pages, use update_agent_config after creation to configure agent behavior.',
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to create the page in'),
      parentId: z.string().optional().describe('The unique ID of the parent page from list_pages - REQUIRED when creating inside any page (folder, document, channel, etc). Only omit for root-level pages in the drive.'),
      title: z.string().describe('The title of the new page'),
      type: z.enum(['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET', 'TASK_LIST']).describe('The type of page to create'),
    }),
    execute: async ({ driveId, parentId, title, type }, { experimental_context: context }) => {
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

        // Check permissions for page creation
        if (parentId) {
          // Creating in a folder - check permissions on parent page
          const canEdit = await canUserEditPage(userId, parentId);
          if (!canEdit) {
            throw new Error('Insufficient permissions to create pages in this folder');
          }
        } else {
          // Creating at root level - check if user owns the drive
          if (drive.ownerId !== userId) {
            throw new Error('Only drive owners can create pages at the root level');
          }
        }

        // Get next position via repository seam
        const nextPosition = await pageRepository.getNextPosition(drive.id, parentId || null);

        // Create the page via repository seam
        const newPage = await pageRepository.create({
          title,
          type,
          content: '',
          position: nextPosition,
          driveId: drive.id,
          parentId: parentId || null,
          isTrashed: false,
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
        }, context as ToolExecutionContext, { pageType: newPage.type, parentId });

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

        return {
          success: true,
          id: newPage.id,
          title: newPage.title,
          type: newPage.type,
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
    description: 'Change the title of an existing page. Updates the page title while preserving all content and structure.',
    inputSchema: z.object({
      path: z.string().describe('The page path using titles like "/driveSlug/Folder Name/Page Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to rename'),
      title: z.string().describe('New title for the page'),
    }),
    execute: async ({ path, pageId, title }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the page via repository seam
        const page = await pageRepository.findById(pageId);

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        // Check permissions
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to rename this page');
        }

        // Update the page title via repository seam
        const renamedPage = await pageRepository.update(page.id, { title });

        // Broadcast page update event for title change
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, renamedPage.id, 'updated', {
            title: renamedPage.title,
            parentId: renamedPage.parentId
          })
        );

        // Log activity for AI-generated rename (fire-and-forget)
        logPageActivityAsync(userId, 'update', {
          id: renamedPage.id,
          title: renamedPage.title,
          driveId: page.driveId,
        }, context as ToolExecutionContext, { updatedFields: ['title'] });

        return {
          success: true,
          path,
          id: renamedPage.id,
          title: renamedPage.title,
          type: renamedPage.type,
          message: `Successfully renamed page to "${renamedPage.title}"`,
          summary: `Renamed page to "${renamedPage.title}"`,
          stats: {
            pageType: renamedPage.type,
            newTitle: renamedPage.title
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
          path,
          newTitle: title,
        });
        throw new Error(`Failed to rename page at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a page or drive to trash (soft delete)
   */
  trash: tool({
    description: 'Move a page or drive to trash. For pages, optionally trash all children recursively. For drives, requires name confirmation for safety.',
    inputSchema: z.object({
      type: z.enum(['page', 'drive']).describe('Whether to trash a page or a drive'),
      id: z.string().describe('The unique ID of the page or drive to trash'),
      path: z.string().optional().describe('For pages: the path using titles for semantic context'),
      withChildren: z.boolean().optional().default(false).describe('For pages: whether to trash all children recursively'),
      confirmDriveName: z.string().optional().describe('For drives: the exact name of the drive (required for safety confirmation)'),
    }),
    execute: async ({ type, id, path, withChildren = false, confirmDriveName }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        if (type === 'page') {
          const { page, childrenCount } = await trashPage(userId, id, withChildren);

          // Log activity for AI-generated trash operation (fire-and-forget)
          logPageActivityAsync(userId, 'trash', {
            id: page.id,
            title: page.title,
            driveId: page.driveId,
          }, context as ToolExecutionContext, { withChildren, childrenCount });

          return {
            success: true,
            type: 'page',
            path,
            id: page.id,
            title: page.title,
            pageType: page.type,
            childrenCount: withChildren ? childrenCount : undefined,
            message: withChildren
              ? `Successfully moved "${page.title}" and ${childrenCount} children to trash`
              : `Successfully moved "${page.title}" to trash`,
          };
        } else {
          if (!confirmDriveName) {
            throw new Error('Drive name confirmation is required for trashing drives (confirmDriveName parameter)');
          }
          const drive = await trashDrive(userId, id, confirmDriveName);

          // Log activity for AI-generated drive trash (fire-and-forget)
          logDriveActivityAsync(userId, 'trash', {
            id: drive.id,
            name: drive.name,
          }, context as ToolExecutionContext);

          return {
            success: true,
            type: 'drive',
            id: drive.id,
            name: drive.name,
            slug: drive.slug,
            message: `Successfully moved workspace "${drive.name}" to trash`,
            warning: 'The drive and all its pages are now inaccessible but can be restored',
          };
        }
      } catch (error) {
        pageWriteLogger.error('Failed to trash', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          type,
          id: maskIdentifier(id),
        });
        throw new Error(`Failed to trash ${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Restore a page or drive from trash
   */
  restore: tool({
    description: 'Restore a trashed page or drive back to its original location.',
    inputSchema: z.object({
      type: z.enum(['page', 'drive']).describe('Whether to restore a page or a drive'),
      id: z.string().describe('The unique ID of the page or drive to restore'),
    }),
    execute: async ({ type, id }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        if (type === 'page') {
          const page = await restorePage(userId, id);

          // Log activity for AI-generated restore operation (fire-and-forget)
          logPageActivityAsync(userId, 'restore', {
            id: page.id,
            title: page.title,
            driveId: page.driveId,
          }, context as ToolExecutionContext);

          return {
            success: true,
            type: 'page',
            id: page.id,
            title: page.title,
            pageType: page.type,
            message: `Successfully restored "${page.title}" from trash`,
          };
        } else {
          const drive = await restoreDrive(userId, id);

          // Log activity for AI-generated drive restore (fire-and-forget)
          logDriveActivityAsync(userId, 'restore', {
            id: drive.id,
            name: drive.name,
          }, context as ToolExecutionContext);

          return {
            success: true,
            type: 'drive',
            id: drive.id,
            name: drive.name,
            slug: drive.slug,
            message: `Successfully restored workspace "${drive.name}" from trash`,
          };
        }
      } catch (error) {
        pageWriteLogger.error('Failed to restore', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          type,
          id: maskIdentifier(id),
        });
        throw new Error(`Failed to restore ${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a page to a different parent or reorder position
   */
  move_page: tool({
    description: 'Move a page to a different parent folder or change its position within the current parent.',
    inputSchema: z.object({
      path: z.string().describe('The page path using titles like "/driveSlug/Folder Name/Page Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to move'),
      newParentPath: z.string().describe('New parent folder path like "/driveSlug/New Folder" for semantic context'),
      newParentId: z.string().optional().describe('The unique ID of the new parent page (omit for root level)'),
      position: z.number().describe('Position within the new parent (1-based, higher numbers appear later)'),
    }),
    execute: async ({ path, pageId, newParentPath, newParentId, position }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the page to move via repository seam
        const page = await pageRepository.findById(pageId);

        if (!page) {
          throw new Error(`Page with ID "${pageId}" not found`);
        }

        // Check permissions on the source page
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to move this page');
        }

        // If newParentId is provided, verify it exists and is in the same drive
        if (newParentId) {
          const parentExists = await pageRepository.existsInDrive(newParentId, page.driveId);
          if (!parentExists) {
            throw new Error(`Parent page with ID "${newParentId}" not found in this drive`);
          }
        }

        // Check permissions on the destination if moving to a folder
        if (newParentId) {
          const canEditDest = await canUserEditPage(userId, newParentId);
          if (!canEditDest) {
            throw new Error('Insufficient permissions to move page to this destination');
          }
        }

        // Update the page's parent and position via repository seam
        const movedPage = await pageRepository.update(page.id, {
          parentId: newParentId ?? null,
          position: position,
        });

        // Broadcast page move event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, movedPage.id, 'moved', {
            parentId: newParentId,
            title: movedPage.title
          })
        );

        // Log activity for AI-generated move operation (fire-and-forget)
        logPageActivityAsync(userId, 'move', {
          id: movedPage.id,
          title: movedPage.title,
          driveId: page.driveId,
        }, context as ToolExecutionContext, { newParentId, position });

        return {
          success: true,
          path,
          newParentPath,
          position,
          id: movedPage.id,
          title: movedPage.title,
          type: movedPage.type,
          message: `Successfully moved "${movedPage.title}" to ${newParentPath} at position ${position}`,
        };
      } catch (error) {
        pageWriteLogger.error('Failed to move page', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          path,
          newParentId: maskIdentifier(newParentId || undefined),
        });
        throw new Error(`Failed to move page from ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Edit cells in a sheet page
   */
  edit_sheet_cells: tool({
    description: 'Edit one or more cells in a SHEET page. Use A1-style cell addresses. Supports batch updates for efficiency. Values starting with "=" are treated as formulas.',
    inputSchema: z.object({
      pageId: z.string().describe('The unique ID of the sheet page to edit'),
      cells: z.array(z.object({
        address: z.string().describe('Cell address in A1-style format (e.g., "A1", "B2", "AA100")'),
        value: z.string().describe('Value to set in the cell. Values starting with "=" are formulas. Empty string clears the cell.'),
      })).min(1).describe('Array of cell updates to apply'),
    }),
    execute: async ({ pageId, cells }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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
        const canEdit = await canUserEditPage(userId, page.id);
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

        // Update the page content via repository seam
        await pageRepository.update(page.id, { content: newContent });

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

        // Log activity for AI-generated sheet edit (fire-and-forget)
        logPageActivityAsync(userId, 'update', {
          id: page.id,
          title: page.title,
          driveId: page.driveId,
          content: newContent,
        }, context as ToolExecutionContext, { cellsUpdated: cells.length });

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