import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, taskItems, taskLists, eq, and, asc, isNotNull } from '@pagespace/db';
import { buildTree, getUserAccessLevel, getUserDriveAccess, getUserAccessiblePagesInDriveWithDetails, getPageTypeEmoji, isFolderPage, PageType } from '@pagespace/lib/server';
import { type ToolExecutionContext, getSuggestedVisionModels } from '../core';

export const pageReadTools = {
  /**
   * Explore the folder structure and find content within a workspace
   */
  list_pages: tool({
    description: 'List all pages in a workspace with their paths and types. Returns hierarchical structure showing folders, documents, AI chats, channels, canvas pages, sheets, and task lists. Pages marked with (Task) suffix are linked to task items.',
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

        // Get all pages user has access to in the drive (optimized single query)
        const visiblePages = await getUserAccessiblePagesInDriveWithDetails(userId, driveId);

        // Sort by position to maintain order
        visiblePages.sort((a, b) => a.position - b.position);

        // Get task-linked page IDs to mark them
        const taskLinkedPageIds = await db.selectDistinct({ pageId: taskItems.pageId })
          .from(taskItems)
          .where(isNotNull(taskItems.pageId));
        const taskLinkedSet = new Set(taskLinkedPageIds.map(t => t.pageId));

        // Build flat list of paths with type indicators
        const buildPageList = (parentId: string | null = null, parentPath: string = `/${driveSlug || driveId}`): string[] => {
          const pages: string[] = [];
          const currentPages = visiblePages.filter(page => page.parentId === parentId);

          for (const page of currentPages) {
            const currentPath = `${parentPath}/${page.title}`;
            // Add type indicator emoji
            const typeIndicator = getPageTypeEmoji(page.type as PageType);
            // Add (Task) suffix for task-linked pages
            const taskSuffix = taskLinkedSet.has(page.id) ? ' (Task)' : '';

            pages.push(`${typeIndicator} [${page.type}]${taskSuffix} ID: ${page.id} Path: ${currentPath}`);

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
    description: 'Read the content of any page (document, AI chat, channel, etc.) using its ID. Returns the full content with line numbers for reference.',
    inputSchema: z.object({
      title: z.string().describe('The document title for display context'),
      pageId: z.string().describe('The unique ID of the page to read'),
    }),
    execute: async ({ title, pageId }, { experimental_context: context }) => {
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

        // Check user access permissions (silent to reduce log noise)
        const accessLevel = await getUserAccessLevel(userId, page.id, { silent: true });
        if (!accessLevel) {
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
              
              // Model supports vision - return metadata about the visual content
              // Use page metadata instead of loading the full content
              return {
                success: true,
                type: 'visual_content_metadata',
                pageId: page.id,
                title: page.title,
                message: `Found visual content: "${page.title}" (${page.mimeType || 'unknown type'})`,
                mimeType: page.mimeType || 'unknown',
                sizeBytes: page.fileSize || 0,
                summary: `This is a visual file that requires vision capabilities to process`,
                stats: {
                  documentType: 'VISUAL',
                  mimeType: page.mimeType || 'unknown',
                  sizeBytes: page.fileSize || 0,
                  sizeMB: page.fileSize ? (page.fileSize / 1024 / 1024).toFixed(2) : '0'
                },
                metadata: {
                  requiresVisionModel: true,
                  processingStatus: 'visual',
                  originalFileName: page.originalFileName
                }
              };
            
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
          // Find or create task_list record for this page
          let taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.pageId, page.id),
          });

          if (!taskList) {
            // Auto-create task_list record
            const [newTaskList] = await db.insert(taskLists).values({
              userId,
              pageId: page.id,
              title: page.title,
              status: 'pending',
              metadata: {
                createdAt: new Date().toISOString(),
                autoCreated: true,
              },
            }).returning();
            taskList = newTaskList;
          }

          // Get all tasks ordered by position
          const tasks = await db
            .select()
            .from(taskItems)
            .where(eq(taskItems.taskListId, taskList.id))
            .orderBy(asc(taskItems.position));

          // Calculate progress
          const totalTasks = tasks.length;
          const completedTasks = tasks.filter(t => t.status === 'completed').length;
          const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
          const pendingTasks = tasks.filter(t => t.status === 'pending').length;
          const blockedTasks = tasks.filter(t => t.status === 'blocked').length;
          const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

          return {
            success: true,
            title: page.title,
            type: 'TASK_LIST',
            taskListId: taskList.id,
            tasks: tasks.map(t => ({
              id: t.id,
              title: t.title,
              description: t.description,
              status: t.status,
              priority: t.priority,
              position: t.position,
              assigneeId: t.assigneeId,
              dueDate: t.dueDate,
              completedAt: t.completedAt,
              linkedPageId: t.pageId,
            })),
            progress: {
              total: totalTasks,
              completed: completedTasks,
              inProgress: inProgressTasks,
              pending: pendingTasks,
              blocked: blockedTasks,
              percentage: progressPercentage,
            },
            summary: totalTasks > 0
              ? `Task list "${page.title}" is ${progressPercentage}% complete (${completedTasks}/${totalTasks} tasks done)`
              : `Task list "${page.title}" has no tasks yet`,
            nextSteps: totalTasks === 0 ? [
              'Use update_task with this pageId to add tasks',
            ] : pendingTasks > 0 ? [
              'Use update_task with taskId to update task status',
              'Each task has a linked document page for notes',
            ] : [
              'All tasks are completed or in progress',
            ],
          };
        }

        // Split content into numbered lines for easy reference
        const lines = page.content.split('\n');
        const numberedContent = lines
          .map((line, index) => `${index + 1}→${line}`)
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

        return {
          success: true,
          pageId: page.id,
          driveId: page.driveId,
          title: page.title,
          type: page.type,
          isTaskLinked,
          content: numberedContent,
          htmlContent: page.content, // Raw HTML for rich text preview
          lineCount: lines.length,
          summary: `Read "${page.title}" (${lines.length} lines, ${page.type.toLowerCase()})${isTaskLinked ? ' - linked to task' : ''}`,
          stats: {
            documentType: page.type,
            lineCount: lines.length,
            wordCount: page.content.split(/\s+/).length,
            characterCount: page.content.length
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
};