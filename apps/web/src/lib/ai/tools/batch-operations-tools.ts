import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, eq, and, inArray, sql } from '@pagespace/db';
import { canUserEditPage, canUserDeletePage, getUserDriveAccess } from '@pagespace/lib';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { ToolExecutionContext } from '../types';

export const batchOperationsTools = {
  /**
   * Move multiple pages to a new parent location
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
   * Rename multiple pages using patterns
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
   * Delete multiple pages in a single atomic operation
   */
  bulk_delete_pages: tool({
    description: 'Delete multiple pages in one atomic operation. All deletions succeed or all fail together.',
    inputSchema: z.object({
      pageIds: z.array(z.string()).describe('Array of page IDs to delete'),
      includeChildren: z.boolean().default(false).describe('Whether to delete child pages too'),
    }),
    execute: async ({ pageIds, includeChildren = false }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        const deletedPages: Array<{ id: string; title: string; driveId: string; deletedCount: number }> = [];
        const allDeletedIds: string[] = [];

        await db.transaction(async (tx) => {
          for (const pageId of pageIds) {
            // Check permissions
            const canDelete = includeChildren
              ? await canUserDeletePage(userId, pageId)
              : await canUserEditPage(userId, pageId);

            if (!canDelete) {
              throw new Error(`No permission to delete page ${pageId}`);
            }

            // Get page info
            const [page] = await tx
              .select({ id: pages.id, title: pages.title, driveId: pages.driveId })
              .from(pages)
              .where(eq(pages.id, pageId));

            if (!page) {
              throw new Error(`Page ${pageId} not found`);
            }

            if (includeChildren) {
              // Recursively find all children
              const getAllChildren = async (parentId: string): Promise<string[]> => {
                const children = await tx
                  .select({ id: pages.id })
                  .from(pages)
                  .where(and(
                    eq(pages.parentId, parentId),
                    eq(pages.driveId, page.driveId)
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
              const deleteIds = [pageId, ...childIds];

              // Delete all pages
              await tx
                .update(pages)
                .set({
                  isTrashed: true,
                  trashedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(pages.id, deleteIds));

              allDeletedIds.push(...deleteIds);
              deletedPages.push({
                id: page.id,
                title: page.title,
                driveId: page.driveId,
                deletedCount: deleteIds.length,
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

              allDeletedIds.push(pageId);
              deletedPages.push({
                id: page.id,
                title: page.title,
                driveId: page.driveId,
                deletedCount: 1,
              });
            }
          }
        });

        // Broadcast deletion events
        for (const deletedId of allDeletedIds) {
          const page = deletedPages.find(p => p.id === deletedId);
          if (page) {
            await broadcastPageEvent(
              createPageEventPayload(page.driveId, deletedId, 'trashed', {})
            );
          }
        }

        return {
          success: true,
          deletedPages: deletedPages.map(p => ({
            id: p.id,
            title: p.title,
            deletedCount: p.deletedCount,
          })),
          totalDeleted: allDeletedIds.length,
          summary: `Successfully deleted ${deletedPages.length} page${deletedPages.length === 1 ? '' : 's'} (${allDeletedIds.length} total including children)`,
          stats: {
            pagesRequested: pageIds.length,
            pagesDeleted: deletedPages.length,
            totalDeleted: allDeletedIds.length,
          },
          nextSteps: [
            'Use list_pages to verify the pages are gone',
            'Check trash if you need to restore any pages',
          ]
        };
      } catch (error) {
        console.error('Bulk delete failed:', error);
        throw new Error(`Bulk delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Update content in multiple pages
   */
  bulk_update_content: tool({
    description: 'Update content in multiple pages in one atomic operation. All updates succeed or all fail together.',
    inputSchema: z.object({
      updates: z.array(z.object({
        pageId: z.string().describe('The page ID to update'),
        content: z.string().describe('The new content for the page'),
        operation: z.enum(['replace', 'append', 'prepend']).default('replace').describe('How to apply the content'),
      })).describe('Array of content updates to apply'),
    }),
    execute: async ({ updates }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        const updatedPages: Array<{ id: string; title: string; operation: string; driveId: string }> = [];

        await db.transaction(async (tx) => {
          for (const update of updates) {
            // Check permissions
            const canEdit = await canUserEditPage(userId, update.pageId);
            if (!canEdit) {
              throw new Error(`No permission to update page ${update.pageId}`);
            }

            // Get current page
            const [currentPage] = await tx
              .select({ content: pages.content, title: pages.title, driveId: pages.driveId })
              .from(pages)
              .where(eq(pages.id, update.pageId));

            if (!currentPage) {
              throw new Error(`Page ${update.pageId} not found`);
            }

            let newContent: string;
            switch (update.operation) {
              case 'replace':
                newContent = update.content;
                break;
              case 'append':
                newContent = currentPage.content + update.content;
                break;
              case 'prepend':
                newContent = update.content + currentPage.content;
                break;
            }

            // Update the page
            await tx
              .update(pages)
              .set({
                content: newContent,
                updatedAt: new Date(),
              })
              .where(eq(pages.id, update.pageId));

            updatedPages.push({
              id: update.pageId,
              title: currentPage.title,
              operation: update.operation,
              driveId: currentPage.driveId,
            });
          }
        });

        // Broadcast update events
        for (const page of updatedPages) {
          await broadcastPageEvent(
            createPageEventPayload(page.driveId, page.id, 'updated', {
              title: page.title,
            })
          );
        }

        return {
          success: true,
          updatedPages: updatedPages.map(p => ({
            id: p.id,
            title: p.title,
            operation: p.operation,
          })),
          summary: `Successfully updated ${updatedPages.length} page${updatedPages.length === 1 ? '' : 's'}`,
          stats: {
            totalUpdated: updatedPages.length,
            operations: {
              replace: updatedPages.filter(p => p.operation === 'replace').length,
              append: updatedPages.filter(p => p.operation === 'append').length,
              prepend: updatedPages.filter(p => p.operation === 'prepend').length,
            },
          },
          nextSteps: [
            'Use read_page to verify the content changes',
            'Use list_pages to see the updated pages',
          ]
        };
      } catch (error) {
        console.error('Bulk content update failed:', error);
        throw new Error(`Bulk content update failed: ${error instanceof Error ? error.message : String(error)}`);
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

// Note: The complex batch_page_operations tool has been removed in favor of simpler,
// purpose-built tools that are easier for AI assistants to understand and use correctly:
// - create_folder_structure: For hierarchical structure creation
// - bulk_move_pages: For moving multiple pages
// - bulk_rename_pages: For renaming multiple pages
// - bulk_delete_pages: For deleting multiple pages
// - bulk_update_content: For updating content in multiple pages
//
// This eliminates the confusing tempId concept and makes each tool's purpose crystal clear.