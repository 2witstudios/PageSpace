import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, drives, eq, and, desc, isNull, inArray } from '@pagespace/db';
import { canUserEditPage, canUserDeletePage, PageType, isAIChatPage, isDocumentPage } from '@pagespace/lib';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { ToolExecutionContext } from '../types';
import { pageSpaceTools } from '../ai-tools';

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

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

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

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

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

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

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
    description: 'Create new pages in the workspace. Supports all page types: FOLDER (hierarchical organization), DOCUMENT (text content), AI_CHAT (AI conversation spaces with optional agent configuration), CHANNEL (team discussions), CANVAS (custom HTML/CSS pages), DATABASE (deprecated). Any page type can contain any other page type as children with infinite nesting. For AI_CHAT pages, can optionally configure system prompt and enabled tools.',
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to create the page in'),
      parentId: z.string().optional().describe('The unique ID of the parent page from list_pages - REQUIRED when creating inside any page (folder, document, channel, etc). Only omit for root-level pages in the drive.'),
      title: z.string().describe('The title of the new page'),
      type: z.enum(['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS']).describe('The type of page to create'),
      content: z.string().optional().describe('Optional initial content for the page'),
      // Agent configuration fields (only for AI_CHAT type)
      systemPrompt: z.string().optional().describe('System prompt for AI agent behavior (only for AI_CHAT pages). Defines how the agent should behave and respond.'),
      enabledTools: z.array(z.string()).optional().describe('Array of tool names to enable for this AI agent (only for AI_CHAT pages). Available tools include: regex_search, glob_search, read_page, create_page, etc.'),
      aiProvider: z.string().optional().describe('AI provider override for this agent (only for AI_CHAT pages). Overrides user default provider.'),
      aiModel: z.string().optional().describe('AI model override for this agent (only for AI_CHAT pages). Overrides user default model.'),
    }),
    execute: async ({ driveId, parentId, title, type, content = '', systemPrompt, enabledTools, aiProvider, aiModel }, { experimental_context: context }) => {
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

        // Validate agent configuration for AI_CHAT pages
        if (isAIChatPage(type as PageType)) {
          // Validate enabled tools if provided
          if (enabledTools && enabledTools.length > 0) {
            const availableToolNames = Object.keys(pageSpaceTools);
            const invalidTools = enabledTools.filter(toolName => !availableToolNames.includes(toolName));
            if (invalidTools.length > 0) {
              throw new Error(`Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}`);
            }
          }
        } else {
          // Non-AI_CHAT pages should not have agent configuration
          if (systemPrompt || enabledTools || aiProvider || aiModel) {
            throw new Error('Agent configuration (systemPrompt, enabledTools, aiProvider, aiModel) can only be used with AI_CHAT page type');
          }
        }

        // Prepare page data with proper typing
        interface PageInsertData {
          title: string;
          type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS';
          content: string;
          position: number;
          driveId: string;
          parentId: string | null;
          isTrashed: boolean;
          systemPrompt?: string | null;
          enabledTools?: string[] | null;
          aiProvider?: string | null;
          aiModel?: string | null;
        }

        const pageData: PageInsertData = {
          title,
          type,
          content,
          position: nextPosition,
          driveId: drive.id,
          parentId: parentId || null,
          isTrashed: false,
        };

        // Add agent-specific fields for AI_CHAT pages
        if (isAIChatPage(type as PageType)) {
          if (systemPrompt) {
            pageData.systemPrompt = systemPrompt;
          }
          if (enabledTools && enabledTools.length > 0) {
            pageData.enabledTools = enabledTools;
          }
          if (aiProvider) {
            pageData.aiProvider = aiProvider;
          }
          if (aiModel) {
            pageData.aiModel = aiModel;
          }
        }

        // Create the page
        const [newPage] = await db
          .insert(pages)
          .values(pageData)
          .returning({ id: pages.id, title: pages.title, type: pages.type });

        // Broadcast page creation event
        await broadcastPageEvent(
          createPageEventPayload(driveId, newPage.id, 'created', {
            parentId,
            title: newPage.title,
            type: newPage.type
          })
        );

        // Build response with agent configuration info if applicable
        interface PageCreationResponse {
          success: boolean;
          id: string;
          title: string;
          type: string;
          parentId: string;
          message: string;
          summary: string;
          stats: {
            pageType: string;
            location: string;
            hasContent: boolean;
          };
          nextSteps: string[];
          agentConfig?: {
            hasSystemPrompt: boolean;
            enabledToolsCount: number;
            enabledTools: string[];
            aiProvider: string;
            aiModel: string;
          };
        }

        const response: PageCreationResponse = {
          success: true,
          id: newPage.id,
          title: newPage.title,
          type: newPage.type,
          parentId: parentId || 'root',
          message: `Successfully created ${type.toLowerCase()} page "${title}"${isAIChatPage(type as PageType) && (systemPrompt || enabledTools) ? ' with agent configuration' : ''}`,
          summary: `Created new ${type.toLowerCase()} "${title}" in ${parentId ? `parent ${parentId}` : 'drive root'}${isAIChatPage(type as PageType) && systemPrompt ? ' with custom system prompt' : ''}`,
          stats: {
            pageType: newPage.type,
            location: parentId ? `Parent ID: ${parentId}` : 'Drive root',
            hasContent: content.length > 0
          },
          nextSteps: [
            isDocumentPage(type as PageType) ? 'Add content to the new document' : 
            isAIChatPage(type as PageType) ? 'Start chatting with your new AI agent' : 
            'Organize related pages in this folder',
            'Use read_page to verify the content was created correctly',
            `New page ID: ${newPage.id} - use this for further operations`
          ]
        };

        // Add agent configuration details to response if applicable
        if (isAIChatPage(type as PageType)) {
          response.agentConfig = {
            hasSystemPrompt: !!systemPrompt,
            enabledToolsCount: enabledTools?.length || 0,
            enabledTools: enabledTools || [],
            aiProvider: aiProvider || 'default',
            aiModel: aiModel || 'default'
          };
          
          if (systemPrompt || enabledTools) {
            response.nextSteps.unshift(
              systemPrompt ? 'AI agent is configured with custom behavior' : 'AI agent created with default behavior',
              enabledTools?.length ? `Agent has access to ${enabledTools.length} tools: ${enabledTools.join(', ')}` : 'Agent has no additional tools enabled'
            );
          }
        }

        return response;
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
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, renamedPage.id, 'updated', {
            title: renamedPage.title,
            parentId: renamedPage.parentId
          })
        );

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
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, trashedPage.id, 'trashed', {
            title: trashedPage.title,
            parentId: trashedPage.parentId
          })
        );

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

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

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

        // Broadcast content update event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, page.id, 'content-updated', {
            title: page.title
          })
        );

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
        await broadcastPageEvent(
          createPageEventPayload(trashedPage.driveId, restoredPage.id, 'restored', {
            title: restoredPage.title,
            parentId: restoredPage.parentId
          })
        );

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

        // Broadcast page move event
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, movedPage.id, 'moved', {
            parentId: newParentId,
            title: movedPage.title
          })
        );

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
};