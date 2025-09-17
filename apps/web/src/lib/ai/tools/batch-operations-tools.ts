import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, eq, and, inArray, sql } from '@pagespace/db';
import { canUserEditPage, canUserDeletePage, getUserDriveAccess } from '@pagespace/lib';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { ToolExecutionContext } from '../types';

export const batchOperationsTools = {
  /**
   * Execute multiple page operations atomically
   */
  batch_page_operations: tool({
    description: 'Execute multiple page operations in a single atomic transaction. All operations succeed or all fail together. Perfect for complex reorganizations.',
    inputSchema: z.object({
      driveId: z.string().describe('The drive ID where operations will occur'),
      operations: z.array(z.object({
        // Required field - operation type
        type: z.enum(['create', 'move', 'rename', 'delete', 'trash', 'append', 'replace', 'update_content']).describe('The type of operation to perform'),

        // Optional fields for all operation types (Google AI compatible)
        tempId: z.string().optional().describe('For create: Temporary ID to reference this page in other operations'),
        title: z.string().optional().describe('For create/rename: The page title'),
        pageType: z.enum(['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS']).optional().describe('For create: The type of page to create'),
        pageId: z.string().optional().describe('For most operations: The page ID to operate on'),
        parentId: z.string().optional().describe('For create: Parent page ID or tempId from another create operation'),
        content: z.string().optional().describe('For create/update_content/append/replace: The page content'),
        position: z.number().optional().describe('For create/move: The position in the parent'),
        newParentId: z.string().optional().describe('For move: New parent ID or tempId'),
        newTitle: z.string().optional().describe('For rename: The new title for the page'),
        includeChildren: z.boolean().optional().describe('For delete/trash: Whether to delete child pages too'),
        startLine: z.number().optional().describe('For replace: Start line for partial replace (1-based)'),
        endLine: z.number().optional().describe('For replace: End line for partial replace (1-based)'),
        path: z.string().optional().describe('For context: Page path for better AI understanding'),
      })).describe('Array of operations to execute'),
      rollbackOnError: z.boolean().default(true).describe('Rollback all changes if any operation fails'),
    }),
    // Provider-specific options to handle schema compatibility
    providerOptions: {
      google: {
        structuredOutputs: false, // Bypass Google's strict schema validation for better compatibility
      },
    },
    execute: async ({ driveId, operations, rollbackOnError = true }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Verify drive access
      const hasDriveAccess = await getUserDriveAccess(userId, driveId);
      if (!hasDriveAccess) {
        throw new Error('You don\'t have access to this drive');
      }

      const results: Array<{ 
        operation: string; 
        pageId?: string; 
        tempId?: string;
        title?: string;
        status?: string; 
        message?: string;
        success?: boolean;
        error?: string;
        newParentId?: string;
        newTitle?: string;
        newContent?: string;
        reason?: string;
        [key: string]: unknown;
      }> = [];
      const tempIdMap = new Map<string, string>(); // Map temp IDs to real IDs
      const createdPageIds: string[] = [];
      const modifiedPageIds: string[] = [];
      const deletedPageIds: string[] = [];

      try {
        // Begin transaction
        await db.transaction(async (tx) => {
          for (const operation of operations) {
            try {
              // Enhanced runtime validation for simplified schema (Google AI compatible)
              switch (operation.type) {
                case 'create':
                  if (!operation.tempId || !operation.title || !operation.pageType) {
                    throw new Error('Create operation requires tempId, title, and pageType');
                  }
                  break;
                case 'move':
                  if (!operation.pageId) {
                    throw new Error('Move operation requires pageId');
                  }
                  break;
                case 'rename':
                  if (!operation.pageId || !operation.newTitle) {
                    throw new Error('Rename operation requires pageId and newTitle');
                  }
                  break;
                case 'delete':
                case 'trash':
                  if (!operation.pageId) {
                    throw new Error(`${operation.type} operation requires pageId`);
                  }
                  break;
                case 'append':
                  if (!operation.pageId || !operation.content) {
                    throw new Error('Append operation requires pageId and content');
                  }
                  break;
                case 'replace':
                  if (!operation.pageId || !operation.content) {
                    throw new Error('Replace operation requires pageId and content');
                  }
                  break;
                case 'update_content':
                  if (!operation.pageId || !operation.content) {
                    throw new Error('Update content operation requires pageId and content');
                  }
                  break;
                default:
                  throw new Error(`Unknown operation type: ${operation.type}`);
              }

              switch (operation.type) {
                case 'create': {
                  // After validation, we know these fields exist
                  const tempId = operation.tempId!;
                  const title = operation.title!;
                  const pageType = operation.pageType!;

                  // Resolve parent ID if it's a temp ID
                  const parentId = operation.parentId && tempIdMap.has(operation.parentId)
                    ? tempIdMap.get(operation.parentId)
                    : operation.parentId;

                  // Check permissions for parent
                  if (parentId) {
                    const canEdit = await canUserEditPage(userId, parentId);
                    if (!canEdit) {
                      throw new Error(`No permission to create pages in parent ${parentId}`);
                    }
                  }

                  // Get next position if not specified
                  let position = operation.position;
                  if (!position) {
                    const siblings = await tx
                      .select({ position: pages.position })
                      .from(pages)
                      .where(and(
                        eq(pages.driveId, driveId),
                        parentId ? eq(pages.parentId, parentId) : sql`${pages.parentId} IS NULL`
                      ))
                      .orderBy(sql`${pages.position} DESC`)
                      .limit(1);
                    position = siblings[0] ? siblings[0].position + 1 : 1;
                  }

                  // Create the page
                  const [newPage] = await tx
                    .insert(pages)
                    .values({
                      title: title,
                      type: pageType,
                      content: operation.content || '',
                      driveId,
                      parentId,
                      position,
                      isTrashed: false,
                    })
                    .returning();

                  tempIdMap.set(tempId, newPage.id);
                  createdPageIds.push(newPage.id);

                  results.push({
                    operation: 'create',
                    tempId: tempId,
                    pageId: newPage.id,
                    title: newPage.title,
                    success: true,
                  });
                  break;
                }

                case 'move': {
                  // After validation, we know this field exists
                  const pageId = operation.pageId!;

                  // Check permissions
                  const canEdit = await canUserEditPage(userId, pageId);
                  if (!canEdit) {
                    throw new Error(`No permission to move page ${pageId}`);
                  }

                  // Resolve new parent ID if it's a temp ID
                  const newParentId = operation.newParentId && tempIdMap.has(operation.newParentId)
                    ? tempIdMap.get(operation.newParentId)
                    : operation.newParentId;

                  // Check permissions for destination
                  if (newParentId) {
                    const canEditDest = await canUserEditPage(userId, newParentId);
                    if (!canEditDest) {
                      throw new Error(`No permission to move to parent ${newParentId}`);
                    }
                  }

                  // Move the page
                  const [movedPage] = await tx
                    .update(pages)
                    .set({
                      parentId: newParentId,
                      position: operation.position || undefined,
                      updatedAt: new Date(),
                    })
                    .where(eq(pages.id, pageId))
                    .returning();

                  modifiedPageIds.push(movedPage.id);

                  results.push({
                    operation: 'move',
                    pageId: movedPage.id,
                    title: movedPage.title,
                    newParentId: newParentId || undefined,
                    success: true,
                  });
                  break;
                }

                case 'rename': {
                  // After validation, we know these fields exist
                  const pageId = operation.pageId!;
                  const newTitle = operation.newTitle!;

                  // Check permissions
                  const canEdit = await canUserEditPage(userId, pageId);
                  if (!canEdit) {
                    throw new Error(`No permission to rename page ${pageId}`);
                  }

                  // Rename the page
                  const [renamedPage] = await tx
                    .update(pages)
                    .set({
                      title: newTitle,
                      updatedAt: new Date(),
                    })
                    .where(eq(pages.id, pageId))
                    .returning();

                  modifiedPageIds.push(renamedPage.id);

                  results.push({
                    operation: 'rename',
                    pageId: renamedPage.id,
                    oldTitle: renamedPage.title,
                    newTitle: newTitle,
                    success: true,
                  });
                  break;
                }

                case 'delete': {
                  // After validation, we know this field exists
                  const pageId = operation.pageId!;

                  // Check permissions
                  const canDelete = operation.includeChildren
                    ? await canUserDeletePage(userId, pageId)
                    : await canUserEditPage(userId, pageId);

                  if (!canDelete) {
                    throw new Error(`No permission to delete page ${pageId}`);
                  }

                  if (operation.includeChildren) {
                    // Recursively find all children
                    const getAllChildren = async (parentId: string): Promise<string[]> => {
                      const children = await tx
                        .select({ id: pages.id })
                        .from(pages)
                        .where(and(
                          eq(pages.parentId, parentId),
                          eq(pages.driveId, driveId)
                        ));

                      const allIds = [];
                      for (const child of children) {
                        allIds.push(child.id);
                        const grandChildren = await getAllChildren(child.id);
                        allIds.push(...grandChildren);
                      }
                      return allIds;
                    };

                    const childIds = await getAllChildren(pageId);
                    const allIds = [pageId, ...childIds];

                    // Delete all pages
                    await tx
                      .update(pages)
                      .set({
                        isTrashed: true,
                        trashedAt: new Date(),
                        updatedAt: new Date(),
                      })
                      .where(inArray(pages.id, allIds));

                    deletedPageIds.push(...allIds);

                    results.push({
                      operation: 'delete',
                      pageId: pageId,
                      deletedCount: allIds.length,
                      success: true,
                    });
                  } else {
                    // Delete single page
                    await tx
                      .update(pages)
                      .set({
                        isTrashed: true,
                        trashedAt: new Date(),
                        updatedAt: new Date(),
                      })
                      .where(eq(pages.id, pageId));

                    deletedPageIds.push(pageId);

                    results.push({
                      operation: 'delete',
                      pageId: pageId,
                      deletedCount: 1,
                      success: true,
                    });
                  }
                  break;
                }

                case 'update_content': {
                  // After validation, we know these fields exist
                  const pageId = operation.pageId!;
                  const content = operation.content!;

                  // Check permissions
                  const canEdit = await canUserEditPage(userId, pageId);
                  if (!canEdit) {
                    throw new Error(`No permission to update page ${pageId}`);
                  }

                  // Update content
                  const [updatedPage] = await tx
                    .update(pages)
                    .set({
                      content: content,
                      updatedAt: new Date(),
                    })
                    .where(eq(pages.id, pageId))
                    .returning();

                  modifiedPageIds.push(updatedPage.id);

                  results.push({
                    operation: 'update_content',
                    pageId: updatedPage.id,
                    title: updatedPage.title,
                    success: true,
                  });
                  break;
                }

                case 'trash': {
                  // After validation, we know this field exists
                  const pageId = operation.pageId!;

                  // Trash operation (alias for delete)
                  const canDelete = operation.includeChildren
                    ? await canUserDeletePage(userId, pageId)
                    : await canUserEditPage(userId, pageId);

                  if (!canDelete) {
                    throw new Error(`No permission to trash page ${pageId}`);
                  }

                  if (operation.includeChildren) {
                    // Recursively find all children
                    const getAllChildren = async (parentId: string): Promise<string[]> => {
                      const children = await tx
                        .select({ id: pages.id })
                        .from(pages)
                        .where(and(
                          eq(pages.parentId, parentId),
                          eq(pages.driveId, driveId)
                        ));

                      const allIds = [];
                      for (const child of children) {
                        allIds.push(child.id);
                        const grandChildren = await getAllChildren(child.id);
                        allIds.push(...grandChildren);
                      }
                      return allIds;
                    };

                    const childIds = await getAllChildren(pageId);
                    const allIds = [pageId, ...childIds];

                    // Trash all pages
                    await tx
                      .update(pages)
                      .set({
                        isTrashed: true,
                        trashedAt: new Date(),
                        updatedAt: new Date(),
                      })
                      .where(inArray(pages.id, allIds));

                    deletedPageIds.push(...allIds);

                    results.push({
                      operation: 'trash',
                      pageId: pageId,
                      deletedCount: allIds.length,
                      success: true,
                    });
                  } else {
                    // Trash single page
                    await tx
                      .update(pages)
                      .set({
                        isTrashed: true,
                        trashedAt: new Date(),
                        updatedAt: new Date(),
                      })
                      .where(eq(pages.id, pageId));

                    deletedPageIds.push(pageId);

                    results.push({
                      operation: 'trash',
                      pageId: pageId,
                      deletedCount: 1,
                      success: true,
                    });
                  }
                  break;
                }

                case 'append': {
                  // After validation, we know these fields exist
                  const pageId = operation.pageId!;
                  const content = operation.content!;

                  // Check permissions
                  const canEdit = await canUserEditPage(userId, pageId);
                  if (!canEdit) {
                    throw new Error(`No permission to append to page ${pageId}`);
                  }

                  // Get current page content
                  const [currentPage] = await tx
                    .select({ content: pages.content, title: pages.title })
                    .from(pages)
                    .where(eq(pages.id, pageId));

                  if (!currentPage) {
                    throw new Error(`Page ${pageId} not found`);
                  }

                  // Append content
                  const newContent = currentPage.content + content;
                  const [updatedPage] = await tx
                    .update(pages)
                    .set({
                      content: newContent,
                      updatedAt: new Date(),
                    })
                    .where(eq(pages.id, pageId))
                    .returning();

                  modifiedPageIds.push(updatedPage.id);

                  results.push({
                    operation: 'append',
                    pageId: updatedPage.id,
                    title: updatedPage.title,
                    success: true,
                  });
                  break;
                }

                case 'replace': {
                  // After validation, we know these fields exist
                  const pageId = operation.pageId!;
                  const content = operation.content!;

                  // Check permissions
                  const canEdit = await canUserEditPage(userId, pageId);
                  if (!canEdit) {
                    throw new Error(`No permission to replace content in page ${pageId}`);
                  }

                  // Get current page content
                  const [currentPage] = await tx
                    .select({ content: pages.content, title: pages.title })
                    .from(pages)
                    .where(eq(pages.id, pageId));

                  if (!currentPage) {
                    throw new Error(`Page ${pageId} not found`);
                  }

                  let newContent: string;

                  if (operation.startLine && operation.endLine) {
                    // Line-based replacement
                    const lines = currentPage.content.split('\n');
                    const startLine = operation.startLine - 1; // Convert to 0-based
                    const endLine = operation.endLine - 1; // Convert to 0-based

                    if (startLine < 0 || startLine >= lines.length || endLine < startLine || endLine >= lines.length) {
                      throw new Error(`Invalid line range: ${operation.startLine}-${operation.endLine}. Document has ${lines.length} lines.`);
                    }

                    // Replace lines
                    const newLines = [
                      ...lines.slice(0, startLine),
                      content,
                      ...lines.slice(endLine + 1),
                    ];
                    newContent = newLines.join('\n');
                  } else {
                    // Full content replacement
                    newContent = content;
                  }

                  // Update content
                  const [updatedPage] = await tx
                    .update(pages)
                    .set({
                      content: newContent,
                      updatedAt: new Date(),
                    })
                    .where(eq(pages.id, pageId))
                    .returning();

                  modifiedPageIds.push(updatedPage.id);

                  results.push({
                    operation: 'replace',
                    pageId: updatedPage.id,
                    title: updatedPage.title,
                    linesReplaced: operation.startLine && operation.endLine ? operation.endLine - operation.startLine + 1 : undefined,
                    success: true,
                  });
                  break;
                }
              }
            } catch (error) {
              if (rollbackOnError) {
                throw error; // This will rollback the transaction
              } else {
                results.push({
                  operation: operation.type,
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        });

        // Broadcast events for all changes
        for (const pageId of createdPageIds) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'created', {})
          );
        }
        for (const pageId of modifiedPageIds) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'updated', {})
          );
        }
        for (const pageId of deletedPageIds) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'trashed', {})
          );
        }

        return {
          success: true,
          operations: operations.length,
          results,
          summary: `Successfully executed ${operations.length} operation${operations.length === 1 ? '' : 's'}`,
          stats: {
            totalOperations: operations.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            created: createdPageIds.length,
            modified: modifiedPageIds.length,
            deleted: deletedPageIds.length,
          },
          tempIdMappings: Object.fromEntries(tempIdMap),
          nextSteps: [
            'Use list_pages to verify the new structure',
            'Continue with additional batch operations if needed',
            'Use read_page to verify content changes',
          ]
        };
      } catch (error) {
        console.error('Batch operation failed:', error);
        throw new Error(`Batch operation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Bulk move multiple pages to a new parent
   */
  bulk_move_pages: tool({
    description: 'Move multiple pages to a new parent location in one operation. Maintains relative positions.',
    inputSchema: z.object({
      pageIds: z.array(z.string()).describe('Array of page IDs to move'),
      targetParentId: z.string().optional().describe('Target parent page ID (omit for root)'),
      targetDriveId: z.string().describe('Target drive ID'),
      maintainOrder: z.boolean().default(true).describe('Maintain relative order of moved pages'),
    }),
    execute: async ({ pageIds, targetParentId, targetDriveId, maintainOrder = true }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Verify drive access
        const hasDriveAccess = await getUserDriveAccess(userId, targetDriveId);
        if (!hasDriveAccess) {
          throw new Error('You don\'t have access to the target drive');
        }

        // Check permissions for all source pages
        const sourcePages: Array<{ id: string; title: string; parentId: string | null; position: number }> = [];
        for (const pageId of pageIds) {
          const canEdit = await canUserEditPage(userId, pageId);
          if (!canEdit) {
            throw new Error(`No permission to move page ${pageId}`);
          }
          
          const [page] = await db
            .select()
            .from(pages)
            .where(eq(pages.id, pageId));
          
          if (page) {
            sourcePages.push(page);
          }
        }

        // Check permission for target parent
        if (targetParentId) {
          const canEditTarget = await canUserEditPage(userId, targetParentId);
          if (!canEditTarget) {
            throw new Error('No permission to move pages to target location');
          }
        }

        // Get next available position in target
        const [maxPosition] = await db
          .select({ maxPos: sql`MAX(${pages.position})` })
          .from(pages)
          .where(and(
            eq(pages.driveId, targetDriveId),
            targetParentId ? eq(pages.parentId, targetParentId) : sql`${pages.parentId} IS NULL`
          ));

        let nextPosition = ((maxPosition as { maxPos: number | null })?.maxPos || 0) + 1;

        // Sort pages by current position if maintaining order
        if (maintainOrder) {
          sourcePages.sort((a, b) => a.position - b.position);
        }

        // Move all pages
        const movedPages: Array<{ id: string; title: string; parentId: string | null; position: number; type: string }> = [];
        await db.transaction(async (tx) => {
          for (const page of sourcePages) {
            const [moved] = await tx
              .update(pages)
              .set({
                parentId: targetParentId,
                driveId: targetDriveId,
                position: nextPosition++,
                updatedAt: new Date(),
              })
              .where(eq(pages.id, page.id))
              .returning();
            
            movedPages.push(moved);
          }
        });

        // Broadcast events
        for (const page of movedPages) {
          await broadcastPageEvent(
            createPageEventPayload(targetDriveId, page.id, 'moved', {
              parentId: targetParentId,
              title: page.title,
            })
          );
        }

        return {
          success: true,
          movedCount: movedPages.length,
          targetLocation: {
            driveId: targetDriveId,
            parentId: targetParentId || 'root',
          },
          movedPages: movedPages.map(p => ({
            id: p.id,
            title: p.title,
            type: p.type,
            newPosition: p.position,
          })),
          summary: `Successfully moved ${movedPages.length} page${movedPages.length === 1 ? '' : 's'}`,
          stats: {
            totalMoved: movedPages.length,
            types: [...new Set(movedPages.map(p => p.type))],
          },
          nextSteps: [
            'Use list_pages to verify the new structure',
            'Consider organizing with folders if needed',
            'Update any references to moved pages',
          ]
        };
      } catch (error) {
        console.error('Bulk move failed:', error);
        throw new Error(`Bulk move failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Bulk rename pages using patterns
   */
  bulk_rename_pages: tool({
    description: 'Rename multiple pages using find/replace patterns or templates.',
    inputSchema: z.object({
      pageIds: z.array(z.string()).describe('Array of page IDs to rename'),
      renamePattern: z.object({
        type: z.enum(['find_replace', 'prefix', 'suffix', 'template']).describe('The type of rename pattern'),
        // Find/replace fields (optional for Google AI compatibility)
        find: z.string().optional().describe('For find_replace: Text to find in titles'),
        replace: z.string().optional().describe('For find_replace: Text to replace with'),
        caseSensitive: z.boolean().optional().describe('For find_replace: Whether to be case sensitive'),
        // Prefix/suffix fields (optional for Google AI compatibility)
        prefix: z.string().optional().describe('For prefix: Prefix to add to all titles'),
        suffix: z.string().optional().describe('For suffix: Suffix to add to all titles'),
        // Template field (optional for Google AI compatibility)
        template: z.string().optional().describe('For template: Template with {title} and {index} placeholders'),
      }).describe('Pattern to use for renaming'),
    }),
    // Provider-specific options to handle schema compatibility
    providerOptions: {
      google: {
        structuredOutputs: false, // Bypass Google's strict schema validation for better compatibility
      },
    },
    execute: async ({ pageIds, renamePattern }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Runtime validation for required fields based on pattern type
        switch (renamePattern.type) {
          case 'find_replace':
            if (!renamePattern.find || !renamePattern.replace) {
              throw new Error('Find/replace pattern requires find and replace fields');
            }
            break;
          case 'prefix':
            if (!renamePattern.prefix) {
              throw new Error('Prefix pattern requires prefix field');
            }
            break;
          case 'suffix':
            if (!renamePattern.suffix) {
              throw new Error('Suffix pattern requires suffix field');
            }
            break;
          case 'template':
            if (!renamePattern.template) {
              throw new Error('Template pattern requires template field');
            }
            break;
        }

        // Check permissions and get pages
        const pagesToRename: Array<{ id: string; title: string; driveId: string }> = [];
        for (const pageId of pageIds) {
          const canEdit = await canUserEditPage(userId, pageId);
          if (!canEdit) {
            throw new Error(`No permission to rename page ${pageId}`);
          }

          const [page] = await db
            .select()
            .from(pages)
            .where(eq(pages.id, pageId));

          if (page && !page.isTrashed) {
            pagesToRename.push(page);
          }
        }

        // Apply rename pattern
        const renamedPages: Array<{ id: string; oldTitle: string; newTitle: string; type: string }> = [];
        await db.transaction(async (tx) => {
          for (let i = 0; i < pagesToRename.length; i++) {
            const page = pagesToRename[i];
            let newTitle = page.title;

            switch (renamePattern.type) {
              case 'find_replace':
                if (renamePattern.caseSensitive) {
                  newTitle = page.title.replace(
                    new RegExp(renamePattern.find!, 'g'),
                    renamePattern.replace!
                  );
                } else {
                  newTitle = page.title.replace(
                    new RegExp(renamePattern.find!, 'gi'),
                    renamePattern.replace!
                  );
                }
                break;

              case 'prefix':
                newTitle = renamePattern.prefix! + page.title;
                break;

              case 'suffix':
                newTitle = page.title + renamePattern.suffix!;
                break;

              case 'template':
                newTitle = renamePattern.template!
                  .replace('{title}', page.title)
                  .replace('{index}', String(i + 1));
                break;
            }

            if (newTitle !== page.title) {
              const [renamed] = await tx
                .update(pages)
                .set({
                  title: newTitle,
                  updatedAt: new Date(),
                })
                .where(eq(pages.id, page.id))
                .returning();

              renamedPages.push({
                id: renamed.id,
                oldTitle: page.title,
                newTitle: renamed.title,
                type: renamed.type,
              });

              // Broadcast update event
              await broadcastPageEvent(
                createPageEventPayload((page as { driveId: string }).driveId, renamed.id, 'updated', {
                  title: renamed.title,
                })
              );
            }
          }
        });

        return {
          success: true,
          pattern: renamePattern.type,
          renamedCount: renamedPages.length,
          unchangedCount: pagesToRename.length - renamedPages.length,
          renamedPages,
          summary: `Renamed ${renamedPages.length} of ${pagesToRename.length} page${pagesToRename.length === 1 ? '' : 's'}`,
          stats: {
            totalProcessed: pagesToRename.length,
            renamed: renamedPages.length,
            unchanged: pagesToRename.length - renamedPages.length,
          },
          nextSteps: [
            'Review renamed pages to ensure correctness',
            'Use list_pages to see the updated structure',
            'Update any hardcoded references to old titles',
          ]
        };
      } catch (error) {
        console.error('Bulk rename failed:', error);
        throw new Error(`Bulk rename failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Create a folder structure from a template
   */
  create_folder_structure: tool({
    description: 'Create a complex folder structure with multiple nested folders and documents in one operation.',
    inputSchema: z.object({
      driveId: z.string().describe('Drive ID to create structure in'),
      parentId: z.string().optional().describe('Parent page ID (omit for root)'),
      structure: z.array(z.object({
        title: z.string(),
        type: z.enum(['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS']),
        content: z.string().optional(),
        children: z.array(z.lazy(() => z.object({
          title: z.string(),
          type: z.enum(['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS']),
          content: z.string().optional(),
        }))).optional(),
      })).describe('Hierarchical structure to create'),
    }),
    execute: async ({ driveId, parentId, structure }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Verify drive access
        const hasDriveAccess = await getUserDriveAccess(userId, driveId);
        if (!hasDriveAccess) {
          throw new Error('You don\'t have access to this drive');
        }

        // Check parent permissions if specified
        if (parentId) {
          const canEdit = await canUserEditPage(userId, parentId);
          if (!canEdit) {
            throw new Error('No permission to create structure in target location');
          }
        }

        const createdPages: Array<{ id: string; title: string; type: string; parentId: string | null; path: string }> = [];
        
        // Recursive function to create structure
        const createStructureRecursive = async (
          items: typeof structure,
          currentParentId: string | null,
          tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
        ) => {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            // Create the page
            const [newPage] = await tx
              .insert(pages)
              .values({
                title: item.title,
                type: item.type,
                content: item.content || '',
                driveId,
                parentId: currentParentId,
                position: i + 1,
                isTrashed: false,
              })
              .returning();

            createdPages.push({
              id: newPage.id,
              title: newPage.title,
              type: newPage.type,
              parentId: currentParentId,
              path: currentParentId ? `${currentParentId}/${newPage.title}` : newPage.title,
            });

            // Create children if any
            if (item.children && item.children.length > 0) {
              await createStructureRecursive(item.children, newPage.id, tx);
            }
          }
        };

        // Execute in transaction
        await db.transaction(async (tx) => {
          await createStructureRecursive(structure, parentId || null, tx);
        });

        // Broadcast creation events
        for (const page of createdPages) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, page.id, 'created', {
              parentId: page.parentId,
              title: page.title,
              type: page.type,
            })
          );
        }

        // Build statistics
        const stats = {
          totalCreated: createdPages.length,
          byType: {} as Record<string, number>,
          maxDepth: 0,
        };

        for (const page of createdPages) {
          stats.byType[page.type] = (stats.byType[page.type] || 0) + 1;
          const depth = page.path.split('/').length;
          stats.maxDepth = Math.max(stats.maxDepth, depth);
        }

        return {
          success: true,
          createdPages: createdPages.map(p => ({
            id: p.id,
            title: p.title,
            type: p.type,
            semanticPath: p.path,
          })),
          summary: `Created ${createdPages.length} page${createdPages.length === 1 ? '' : 's'} in hierarchical structure`,
          stats,
          rootPages: createdPages.filter(p => p.parentId === parentId).map(p => ({
            id: p.id,
            title: p.title,
            type: p.type,
          })),
          nextSteps: [
            'Use list_pages to explore the created structure',
            'Add content to the created documents',
            'Continue building on the structure as needed',
          ]
        };
      } catch (error) {
        console.error('Structure creation failed:', error);
        throw new Error(`Failed to create folder structure: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};