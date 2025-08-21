import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, drives, eq, and, desc, asc, isNull, inArray, driveMembers, pagePermissions, ne } from '@pagespace/db';
import { buildTree, canUserEditPage, canUserDeletePage, getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib';
import { broadcastPageEvent, createPageEventPayload, broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';

/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These tools provide the AI with the ability to interact with PageSpace documents,
 * drives, and pages directly through the database with proper permission checking.
 */

interface ToolExecutionContext {
  userId: string;
  locationContext?: {
    currentPage?: {
      id: string;
      title: string;
      type: string;
      path: string;
    };
    currentDrive?: {
      id: string;
      name: string;
      slug: string;
    };
    breadcrumbs?: string[];
  };
}


export const pageSpaceTools = {
  /**
   * Discover what workspaces/drives are available to the user
   */
  list_drives: tool({
    description: 'List all available workspaces/drives that the user has access to. Returns drive names, slugs, and basic metadata.',
    inputSchema: z.object({}),
    execute: async ({}, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // 1. Get user's own drives
        const ownedDrives = await db
          .select({
            id: drives.id,
            name: drives.name,
            slug: drives.slug,
            createdAt: drives.createdAt,
            ownerId: drives.ownerId,
          })
          .from(drives)
          .where(eq(drives.ownerId, userId));

        // 2. Get drives where user is a member
        const memberDrives = await db.selectDistinct({ 
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
          createdAt: drives.createdAt,
          ownerId: drives.ownerId,
        })
          .from(driveMembers)
          .leftJoin(drives, eq(driveMembers.driveId, drives.id))
          .where(and(
            eq(driveMembers.userId, userId),
            ne(drives.ownerId, userId) // Exclude owned drives
          ));

        // 3. Get drives where user has page permissions
        const permissionDrives = await db.selectDistinct({
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
          createdAt: drives.createdAt,
          ownerId: drives.ownerId,
        })
          .from(pagePermissions)
          .leftJoin(pages, eq(pagePermissions.pageId, pages.id))
          .leftJoin(drives, eq(pages.driveId, drives.id))
          .where(and(
            eq(pagePermissions.userId, userId),
            eq(pagePermissions.canView, true),
            ne(drives.ownerId, userId) // Exclude owned drives
          ));

        // 4. Combine all drives and deduplicate
        const allDrives = [...ownedDrives, ...memberDrives, ...permissionDrives];
        const uniqueDrives = Array.from(new Map(allDrives.map(d => [d.id, d])).values());

        return {
          success: true,
          drives: uniqueDrives.map(drive => ({
            id: drive.id,
            slug: drive.slug,
            title: drive.name,
            description: '',
            isDefault: false,
          })),
          summary: `Found ${uniqueDrives.length} workspace${uniqueDrives.length === 1 ? '' : 's'} available`,
          stats: {
            totalDrives: uniqueDrives.length,
            driveNames: uniqueDrives.map(d => d.name)
          },
          nextSteps: uniqueDrives.length > 0 ? [
            'Use list_pages with both driveSlug and driveId from above to explore the structure of any workspace',
            'Use read_page to examine specific documents for context'
          ] : ['Create a new workspace if needed']
        };
      } catch (error) {
        console.error('Error reading drives:', error);
        throw new Error('Failed to read drives');
      }
    },
  }),

  /**
   * Explore the folder structure and find content within a workspace
   */
  list_pages: tool({
    description: 'List all pages in a workspace with their paths and types. Returns hierarchical structure showing folders, documents, AI chats, channels, canvas pages, and databases.',
    inputSchema: z.object({
      driveSlug: z.string().optional().describe('The human-readable slug of the drive (for semantic understanding)'),
      driveId: z.string().describe('The unique ID of the drive (used for operations)'),
    }),
    execute: async ({ driveSlug, driveId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Check if user has access to this drive using the provided ID
        const hasDriveAccess = await getUserDriveAccess(userId, driveId);
        if (!hasDriveAccess) {
          throw new Error(`You don't have access to the "${driveSlug}" workspace`);
        }

        // Get all pages in the drive using the drive ID
        const drivePages = await db
          .select({
            id: pages.id,
            title: pages.title,
            type: pages.type,
            parentId: pages.parentId,
            position: pages.position,
            isTrashed: pages.isTrashed,
          })
          .from(pages)
          .where(and(
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, false)
          ))
          .orderBy(asc(pages.position));

        // Filter pages based on user permissions
        const visiblePages: typeof drivePages = [];
        for (const page of drivePages) {
          const accessLevel = await getUserAccessLevel(userId, page.id);
          if (accessLevel?.canView) {
            visiblePages.push(page);
          }
        }

        // Build flat list of paths with type indicators
        const buildPageList = (parentId: string | null = null, parentPath: string = `/${driveSlug || driveId}`): string[] => {
          const pages: string[] = [];
          const currentPages = visiblePages.filter(page => page.parentId === parentId);
          
          for (const page of currentPages) {
            const currentPath = `${parentPath}/${page.title}`;
            // Add type indicator emoji
            const typeIndicator = page.type === 'FOLDER' ? '📁' : 
                                 page.type === 'DOCUMENT' ? '📄' : 
 
                                 page.type === 'AI_CHAT' ? '🤖' : 
                                 page.type === 'CHANNEL' ? '💬' : 
                                 page.type === 'CANVAS' ? '🎨' : '📄';
            
            pages.push(`${typeIndicator} ID: ${page.id} Path: ${currentPath}`);
            
            // Recursively add children
            pages.push(...buildPageList(page.id, currentPath));
          }
          
          return pages;
        };

        const paths = buildPageList();

        return {
          success: true,
          driveSlug: driveSlug || driveId,
          paths,
          count: paths.length,
          summary: `Explored ${driveSlug || driveId} workspace and found ${paths.length} page${paths.length === 1 ? '' : 's'}`,
          stats: {
            totalPages: paths.length,
            folderCount: paths.filter(p => p.includes('📁')).length,
            documentCount: paths.filter(p => p.includes('📄')).length,
            workspace: driveSlug || driveId
          },
          nextSteps: paths.length > 0 ? [
            'Use read_page to examine specific documents',
            'Use create_page to add new content to this workspace'
          ] : ['This workspace is empty - consider creating some initial content']
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
    description: 'Read the content of any page (document, AI chat, channel, etc.) using its path. Returns the full content with line numbers for reference.',
    inputSchema: z.object({
      path: z.string().describe('The document path using titles like "/driveSlug/Folder Name/Document Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to read'),
    }),
    execute: async ({ path, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check user access permissions
        const accessLevel = await getUserAccessLevel(userId, page.id);
        if (!accessLevel) {
          throw new Error('Insufficient permissions to read this document');
        }

        // Split content into numbered lines for easy reference
        const lines = page.content.split('\n');
        const numberedContent = lines
          .map((line, index) => `${index + 1}→${line}`)
          .join('\n');

        return {
          success: true,
          path,
          title: page.title,
          type: page.type,
          content: numberedContent,
          lineCount: lines.length,
          summary: `Read "${page.title}" (${lines.length} lines, ${page.type.toLowerCase()})`,
          stats: {
            documentType: page.type,
            lineCount: lines.length,
            wordCount: page.content.split(/\s+/).length,
            characterCount: page.content.length
          },
          nextSteps: [
            'Use the content for context in creating related documents',
            'Use edit tools to modify this document if needed',
            'Reference this content when answering user questions'
          ]
        };
      } catch (error) {
        console.error('Error reading document:', error);
        throw new Error(`Failed to read document at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

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

        // Replace lines (convert to 0-based indexing)
        const newLines = [
          ...lines.slice(0, startLine - 1),
          content,
          ...lines.slice(endLine),
        ];

        const newContent = newLines.join('\n');

        // Update the page content
        await db
          .update(pages)
          .set({
            content: newContent,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // Get drive slug and broadcast content update
        const [drive] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));
        
        if (drive?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(drive.slug, page.id, 'content-updated', {
              title: page.title
            })
          );
        }

        return {
          success: true,
          path,
          title: page.title,
          linesReplaced: endLine - startLine + 1,
          newLineCount: newLines.length,
          message: `Successfully replaced lines ${startLine}-${endLine}`,
          summary: `Updated "${page.title}" by replacing ${endLine - startLine + 1} line${endLine - startLine + 1 === 1 ? '' : 's'}`,
          stats: {
            linesChanged: endLine - startLine + 1,
            totalLines: newLines.length,
            changeType: 'replacement'
          },
          nextSteps: [
            'Review the updated content to ensure it meets requirements',
            'Consider making additional edits if needed'
          ]
        };
      } catch (error) {
        console.error('Error replacing lines:', error);
        throw new Error(`Failed to replace lines in ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Insert new content at a specific line
   */
  insert_lines: tool({
    description: 'Insert new content at a specific line number in a document. Content is inserted before the specified line.',
    inputSchema: z.object({
      path: z.string().describe('The document path using titles like "/driveSlug/Folder Name/Document Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to edit'),
      lineNumber: z.number().describe('Line number where to insert content (1-based)'),
      content: z.string().describe('Content to insert'),
    }),
    execute: async ({ path, pageId, lineNumber, content }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check user permissions
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this document');
        }

        // Split content into lines
        const lines = page.content.split('\n');
        
        // Validate line number (can be 1 to lines.length + 1 for append)
        if (lineNumber < 1 || lineNumber > lines.length + 1) {
          throw new Error(`Invalid line number: ${lineNumber}. Document has ${lines.length} lines.`);
        }

        // Insert content (convert to 0-based indexing)
        const newLines = [
          ...lines.slice(0, lineNumber - 1),
          content,
          ...lines.slice(lineNumber - 1),
        ];

        const newContent = newLines.join('\n');

        // Update the page content
        await db
          .update(pages)
          .set({
            content: newContent,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // Get drive slug and broadcast content update
        const [drive] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));
        
        if (drive?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(drive.slug, page.id, 'content-updated', {
              title: page.title
            })
          );
        }

        return {
          success: true,
          path,
          title: page.title,
          insertedAt: lineNumber,
          newLineCount: newLines.length,
          message: `Successfully inserted content at line ${lineNumber}`,
          summary: `Added new content to "${page.title}" at line ${lineNumber}`,
          stats: {
            insertPosition: lineNumber,
            totalLines: newLines.length,
            changeType: 'insertion'
          },
          nextSteps: [
            'Review the document to ensure the insertion flows well',
            'Make additional edits if needed to improve readability'
          ]
        };
      } catch (error) {
        console.error('Error inserting at line:', error);
        throw new Error(`Failed to insert content in ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Delete specific line(s) from a document
   */
  delete_lines: tool({
    description: 'Delete one or more lines from a document. Specify start and end line numbers (1-based indexing).',
    inputSchema: z.object({
      path: z.string().describe('The document path using titles like "/driveSlug/Folder Name/Document Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to edit'),
      startLine: z.number().describe('Starting line number to delete (1-based)'),
      endLine: z.number().optional().describe('Ending line number to delete (1-based, optional, defaults to startLine)'),
    }),
    execute: async ({ path, pageId, startLine, endLine = startLine }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check user permissions
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

        // Delete lines (convert to 0-based indexing)
        const newLines = [
          ...lines.slice(0, startLine - 1),
          ...lines.slice(endLine),
        ];

        const newContent = newLines.join('\n');

        // Update the page content
        await db
          .update(pages)
          .set({
            content: newContent,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // Get drive slug and broadcast content update
        const [drive] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));
        
        if (drive?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(drive.slug, page.id, 'content-updated', {
              title: page.title
            })
          );
        }

        return {
          success: true,
          path,
          title: page.title,
          linesDeleted: endLine - startLine + 1,
          newLineCount: newLines.length,
          message: `Successfully deleted lines ${startLine}-${endLine}`,
        };
      } catch (error) {
        console.error('Error deleting lines:', error);
        throw new Error(`Failed to delete lines from ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Create new documents, folders, or other content
   */
  create_page: tool({
    description: 'Create new pages in the workspace. Supports all page types: FOLDER (hierarchical organization), DOCUMENT (text content), AI_CHAT (AI conversation spaces), CHANNEL (team discussions), CANVAS (custom HTML/CSS pages), DATABASE (deprecated). Any page type can contain any other page type as children with infinite nesting.',
    inputSchema: z.object({
      parentPath: z.string().describe('Parent folder path using titles like "/driveSlug" for root or "/driveSlug/Folder Name" for semantic context'),
      driveId: z.string().describe('The unique ID of the drive to create the page in'),
      parentId: z.string().optional().describe('The unique ID of the parent page (omit for root level)'),
      title: z.string().describe('The title of the new page'),
      type: z.enum(['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS']).describe('The type of page to create'),
      content: z.string().optional().describe('Optional initial content for the page'),
    }),
    execute: async ({ parentPath, driveId, parentId, title, type, content = '' }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the drive directly by ID
        const [drive] = await db
          .select({ id: drives.id, ownerId: drives.ownerId })
          .from(drives)
          .where(eq(drives.id, driveId));
          
        if (!drive) {
          throw new Error(`Drive with ID "${driveId}" not found`);
        }

        // If parentId is provided, verify it exists and belongs to this drive
        if (parentId) {
          const [parentPage] = await db
            .select({ id: pages.id })
            .from(pages)
            .where(and(
              eq(pages.id, parentId),
              eq(pages.driveId, driveId),
              eq(pages.isTrashed, false)
            ));

          if (!parentPage) {
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

        // Get next position
        const siblingPages = await db
          .select({ position: pages.position })
          .from(pages)
          .where(and(
            eq(pages.driveId, drive.id),
            parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            eq(pages.isTrashed, false)
          ))
          .orderBy(desc(pages.position));

        const nextPosition = siblingPages.length > 0 ? siblingPages[0].position + 1 : 1;

        // Create the page
        const [newPage] = await db
          .insert(pages)
          .values({
            title,
            type,
            content,
            position: nextPosition,
            driveId: drive.id,
            parentId,
            isTrashed: false,
          })
          .returning({ id: pages.id, title: pages.title, type: pages.type });

        // Get the drive slug for broadcasting
        const [driveInfo] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, driveId));

        // Broadcast page creation event
        if (driveInfo?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(driveInfo.slug, newPage.id, 'created', {
              parentId,
              title: newPage.title,
              type: newPage.type
            })
          );
        }

        return {
          success: true,
          path: `${parentPath}/${newPage.title}`,
          id: newPage.id,
          title: newPage.title,
          type: newPage.type,
          message: `Successfully created ${type.toLowerCase()} page "${title}"`,
          summary: `Created new ${type.toLowerCase()} "${title}" in ${parentPath}`,
          stats: {
            pageType: newPage.type,
            location: parentPath,
            hasContent: content.length > 0
          },
          nextSteps: [
            type === 'DOCUMENT' ? 'Add content to the new document' : 'Organize related pages in this folder',
            'Use read_page to verify the content was created correctly'
          ]
        };
      } catch (error) {
        console.error('Error creating page:', error);
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

        // Check permissions
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to rename this page');
        }

        // Get the drive slug for broadcasting
        const [driveInfo] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));

        // Update the page title
        const [renamedPage] = await db
          .update(pages)
          .set({
            title,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id))
          .returning({ id: pages.id, title: pages.title, type: pages.type, parentId: pages.parentId });

        // Broadcast page update event for title change
        if (driveInfo?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(driveInfo.slug, renamedPage.id, 'updated', {
              title: renamedPage.title,
              parentId: renamedPage.parentId
            })
          );
        }

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
        console.error('Error renaming page:', error);
        throw new Error(`Failed to rename page at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a page to trash (soft delete)
   */
  trash_page: tool({
    description: 'Move a single page to trash. Children pages remain in place unless explicitly trashed separately.',
    inputSchema: z.object({
      path: z.string().describe('The page path using titles like "/driveSlug/Folder Name/Page Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to trash'),
    }),
    execute: async ({ path, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check permissions
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to trash this page');
        }

        // Get the drive slug for broadcasting
        const [driveInfo] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));

        // Move to trash
        const [trashedPage] = await db
          .update(pages)
          .set({
            isTrashed: true,
            trashedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id))
          .returning({ id: pages.id, title: pages.title, type: pages.type, parentId: pages.parentId });

        // Broadcast page deletion event
        if (driveInfo?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(driveInfo.slug, trashedPage.id, 'trashed', {
              title: trashedPage.title,
              parentId: trashedPage.parentId
            })
          );
        }

        return {
          success: true,
          path,
          id: trashedPage.id,
          title: trashedPage.title,
          type: trashedPage.type,
          message: `Successfully moved "${trashedPage.title}" to trash`,
        };
      } catch (error) {
        console.error('Error trashing page:', error);
        throw new Error(`Failed to trash page at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Append content to the end of a page
   */
  append_to_page: tool({
    description: 'Append content to the end of an existing page. New content is added after all existing content.',
    inputSchema: z.object({
      path: z.string().describe('The page path using titles like "/driveSlug/Folder Name/Page Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to edit'),
      content: z.string().describe('Content to append to the end of the page'),
    }),
    execute: async ({ path, pageId, content }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check permissions
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this page');
        }

        // Append content to existing content
        const newContent = page.content + '\n' + content;

        // Update the page content
        await db
          .update(pages)
          .set({
            content: newContent,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // Get drive slug and broadcast content update
        const [drive] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));
        
        if (drive?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(drive.slug, page.id, 'content-updated', {
              title: page.title
            })
          );
        }

        return {
          success: true,
          path,
          title: page.title,
          message: `Successfully appended content to "${page.title}"`,
          newLineCount: newContent.split('\n').length,
          summary: `Added new content to the end of "${page.title}"`,
          stats: {
            totalLines: newContent.split('\n').length,
            changeType: 'append'
          },
          nextSteps: [
            'Review the document to ensure the new content flows well',
            'Consider organizing or formatting the appended content'
          ]
        };
      } catch (error) {
        console.error('Error appending to page:', error);
        throw new Error(`Failed to append content to ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Prepend content to the beginning of a page
   */
  prepend_to_page: tool({
    description: 'Prepend content to the beginning of an existing page. New content is added before all existing content.',
    inputSchema: z.object({
      path: z.string().describe('The page path using titles like "/driveSlug/Folder Name/Page Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to edit'),
      content: z.string().describe('Content to prepend to the beginning of the page'),
    }),
    execute: async ({ path, pageId, content }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check permissions
        const canEdit = await canUserEditPage(userId, page.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to edit this page');
        }

        // Prepend content to existing content
        const newContent = content + '\n' + page.content;

        // Update the page content
        await db
          .update(pages)
          .set({
            content: newContent,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id));

        // Get drive slug and broadcast content update
        const [drive] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));
        
        if (drive?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(drive.slug, page.id, 'content-updated', {
              title: page.title
            })
          );
        }

        return {
          success: true,
          path,
          title: page.title,
          message: `Successfully prepended content to "${page.title}"`,
          newLineCount: newContent.split('\n').length,
          summary: `Added new content to the beginning of "${page.title}"`,
          stats: {
            totalLines: newContent.split('\n').length,
            changeType: 'prepend'
          },
          nextSteps: [
            'Review the document to ensure the new content provides good context',
            'Consider adjusting the structure or formatting'
          ]
        };
      } catch (error) {
        console.error('Error prepending to page:', error);
        throw new Error(`Failed to prepend content to ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a page and all its children to trash recursively
   */
  trash_page_with_children: tool({
    description: 'Move a page and all its children to trash recursively. Completely removes a folder and all nested content.',
    inputSchema: z.object({
      path: z.string().describe('The page path using titles like "/driveSlug/Folder Name/Page Title" for semantic context'),
      pageId: z.string().describe('The unique ID of the page to trash'),
    }),
    execute: async ({ path, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

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

        // Check permissions (need DELETE access for recursive trash)
        const canDelete = await canUserDeletePage(userId, page.id);
        if (!canDelete) {
          throw new Error('Insufficient permissions to trash this page and its children');
        }

        const driveId = page.driveId;

        // Recursively find all child pages
        const getAllChildPages = async (parentId: string): Promise<string[]> => {
          const children = await db
            .select({ id: pages.id })
            .from(pages)
            .where(and(
              eq(pages.driveId, driveId),
              eq(pages.parentId, parentId),
              eq(pages.isTrashed, false)
            ));

          const childIds = children.map(child => child.id);
          
          // Recursively get grandchildren
          const grandChildIds = [];
          for (const child of children) {
            const grandChildren = await getAllChildPages(child.id);
            grandChildIds.push(...grandChildren);
          }
          
          return [...childIds, ...grandChildIds];
        };

        const childPageIds = await getAllChildPages(page.id);
        const allPageIds = [page.id, ...childPageIds];

        // Trash all pages (parent and children)
        const [trashedPage] = await db
          .update(pages)
          .set({
            isTrashed: true,
            trashedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(pages.driveId, driveId),
            inArray(pages.id, allPageIds)
          ))
          .returning({ id: pages.id, title: pages.title, type: pages.type });

        return {
          success: true,
          path,
          id: trashedPage.id,
          title: trashedPage.title,
          type: trashedPage.type,
          childrenCount: childPageIds.length,
          message: `Successfully moved "${trashedPage.title}" and ${childPageIds.length} children to trash`,
        };
      } catch (error) {
        console.error('Error trashing page with children:', error);
        throw new Error(`Failed to trash page with children at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Restore a page from trash
   */
  restore_page: tool({
    description: 'Restore a trashed page back to its original location in the workspace.',
    inputSchema: z.object({
      path: z.string().describe('The page title for semantic context (e.g., "Page Title" or "/driveSlug/Page Title")'),
      pageId: z.string().describe('The unique ID of the trashed page to restore'),
    }),
    execute: async ({ path, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the trashed page directly by ID
        const trashedPage = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, pageId),
            eq(pages.isTrashed, true)
          ),
        });

        if (!trashedPage) {
          throw new Error(`Trashed page with ID "${pageId}" not found`);
        }

        // Check permissions
        const canEdit = await canUserEditPage(userId, trashedPage.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to restore this page');
        }

        // Get the drive slug for broadcasting
        const [driveInfo] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, trashedPage.driveId));

        // Restore the page
        const [restoredPage] = await db
          .update(pages)
          .set({
            isTrashed: false,
            trashedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, trashedPage.id))
          .returning({ id: pages.id, title: pages.title, type: pages.type, parentId: pages.parentId });

        // Broadcast page restore event
        if (driveInfo?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(driveInfo.slug, restoredPage.id, 'restored', {
              title: restoredPage.title,
              parentId: restoredPage.parentId
            })
          );
        }

        return {
          success: true,
          id: restoredPage.id,
          title: restoredPage.title,
          type: restoredPage.type,
          message: `Successfully restored "${restoredPage.title}" from trash`,
        };
      } catch (error) {
        console.error('Error restoring page:', error);
        throw new Error(`Failed to restore page "${path}": ${error instanceof Error ? error.message : String(error)}`);
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
        // Get the page to move directly by ID
        const page = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, pageId),
            eq(pages.isTrashed, false)
          ),
        });

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
          const [parentPage] = await db
            .select({ id: pages.id })
            .from(pages)
            .where(and(
              eq(pages.id, newParentId),
              eq(pages.driveId, page.driveId),
              eq(pages.isTrashed, false)
            ));

          if (!parentPage) {
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

        // Update the page's parent and position
        const [movedPage] = await db
          .update(pages)
          .set({
            parentId: newParentId,
            position: position,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id))
          .returning({ id: pages.id, title: pages.title, type: pages.type });

        // Get the drive slug for broadcasting
        const [driveInfo] = await db
          .select({ slug: drives.slug })
          .from(drives)
          .where(eq(drives.id, page.driveId));

        // Broadcast page move event
        if (driveInfo?.slug) {
          await broadcastPageEvent(
            createPageEventPayload(driveInfo.slug, movedPage.id, 'moved', {
              parentId: newParentId,
              title: movedPage.title
            })
          );
        }

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
        console.error('Error moving page:', error);
        throw new Error(`Failed to move page from ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
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
        // Check if user has access to this drive using the provided ID
        const hasDriveAccess = await getUserDriveAccess(userId, driveId);
        if (!hasDriveAccess) {
          throw new Error(`You don't have access to the "${driveSlug}" workspace`);
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
            title: node.title,
            type: node.type,
            trashedAt: node.trashedAt,
            parentId: node.parentId,
            isFolder: node.type === 'FOLDER',
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
   * Read the current page the user is viewing (location-aware)
   */
  read_current_page: tool({
    description: 'Read the content of the current page the user is viewing. Only available when location context is provided.',
    inputSchema: z.object({}),
    execute: async ({}, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Get location context from the request context
      const locationContext = (context as ToolExecutionContext)?.locationContext;
      if (!locationContext?.currentPage) {
        throw new Error('Current page location context not available. This tool is only available when viewing a specific page.');
      }

      try {
        const { currentPage, currentDrive } = locationContext;

        // Get the page from database using the page ID
        const [page] = await db
          .select({
            id: pages.id,
            title: pages.title,
            content: pages.content,
            type: pages.type,
            driveId: pages.driveId,
            parentId: pages.parentId,
            position: pages.position,
            createdAt: pages.createdAt,
            updatedAt: pages.updatedAt,
          })
          .from(pages)
          .where(and(
            eq(pages.id, currentPage.id),
            eq(pages.isTrashed, false)
          ));

        if (!page) {
          throw new Error('Current page not found or has been deleted');
        }

        // Check user access permissions
        const accessLevel = await getUserAccessLevel(userId, page.id);
        if (!accessLevel) {
          throw new Error('Insufficient permissions to read this page');
        }

        // Split content into numbered lines for easy reference
        const lines = page.content.split('\n');
        const numberedContent = lines
          .map((line, index) => `${index + 1}→${line}`)
          .join('\n');

        return {
          success: true,
          currentPageInfo: {
            id: page.id,
            title: page.title,
            type: page.type,
            path: currentPage.path,
            drive: currentDrive ? {
              id: currentDrive.id,
              name: currentDrive.name,
              slug: currentDrive.slug,
            } : null,
            breadcrumbs: locationContext.breadcrumbs || [],
          },
          content: numberedContent,
          lineCount: lines.length,
          summary: `Reading current page: "${page.title}" (${lines.length} lines, ${page.type.toLowerCase()})`,
          stats: {
            documentType: page.type,
            lineCount: lines.length,
            wordCount: page.content.split(/\s+/).length,
            characterCount: page.content.length,
            lastModified: page.updatedAt,
            created: page.createdAt,
          },
          contextInfo: {
            locationAware: true,
            inDrive: currentDrive?.name || 'Unknown',
            pagePath: currentPage.path,
            viewingContext: 'Current page in right sidebar assistant',
          },
          nextSteps: [
            'Use this content to provide context-aware assistance',
            'Reference specific line numbers when making suggestions',
            'Provide insights relevant to this specific page and its location'
          ]
        };
      } catch (error) {
        console.error('Error reading current page:', error);
        throw new Error(`Failed to read current page: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Create a new workspace/drive
   */
  create_drive: tool({
    description: 'Create a new workspace/drive. Use when user explicitly requests a new workspace or when their project clearly doesn\'t fit existing drives.',
    inputSchema: z.object({
      name: z.string().describe('The name of the new drive/workspace'),
    }),
    execute: async ({ name }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Validate name
        if (!name || name.trim().length === 0) {
          throw new Error('Drive name is required');
        }
        
        if (name.toLowerCase() === 'personal') {
          throw new Error('Cannot create a drive named "Personal"');
        }

        // Generate slug from name
        const slug = name.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-');

        // Create the new drive
        const [newDrive] = await db.insert(drives).values({
          name: name.trim(),
          slug,
          ownerId: userId,
          updatedAt: new Date(),
        }).returning({
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
        });

        // Broadcast drive creation event
        await broadcastDriveEvent(
          createDriveEventPayload(newDrive.id, 'created', {
            name: newDrive.name,
            slug: newDrive.slug,
          })
        );

        return {
          success: true,
          drive: {
            id: newDrive.id,
            name: newDrive.name,
            slug: newDrive.slug,
          },
          message: `Successfully created workspace "${newDrive.name}"`,
          summary: `Created new workspace "${newDrive.name}" with slug "${newDrive.slug}"`,
          stats: {
            driveName: newDrive.name,
            driveSlug: newDrive.slug,
          },
          nextSteps: [
            `Use list_pages with driveSlug: "${newDrive.slug}" and driveId: "${newDrive.id}" to explore the new workspace`,
            'Create folders and documents to organize your content',
            'Consider creating an AI_CHAT page for workspace-specific assistance',
          ]
        };
      } catch (error) {
        console.error('Error creating drive:', error);
        throw new Error(`Failed to create drive: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};

export type PageSpaceTools = typeof pageSpaceTools;