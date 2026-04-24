import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, taskItems, taskLists, chatMessages, channelMessages, eq, and, asc, isNotNull, count, max, min, inArray } from '@pagespace/db';
import { buildTree } from '@pagespace/lib/content/tree-utils';
import { getUserAccessLevel, getUserDriveAccess, getUserAccessiblePagesInDriveWithDetails } from '@pagespace/lib/permissions/permissions';
import { getPageTypeEmoji, isFolderPage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { type ToolExecutionContext, getSuggestedVisionModels } from '../core';
import { addLineBreaksForAI } from '@/lib/editor/line-breaks';

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
    description: 'Read the content of any page (document, AI chat, channel, etc.) using its ID. Returns content with line numbers. For CHANNEL pages, returns a message transcript. Use lineStart/lineEnd to read specific line ranges.',
    inputSchema: z.object({
      title: z.string().describe('The document title for display context'),
      pageId: z.string().describe('The unique ID of the page to read'),
      lineStart: z.number().int().optional().describe('Start line number (1-indexed, inclusive). Omit to start from beginning.'),
      lineEnd: z.number().int().optional().describe('End line number (1-indexed, inclusive). Omit to read to end.'),
    }),
    execute: async ({ title, pageId, lineStart, lineEnd }, { experimental_context: context }) => {
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
          const messages = await db.query.channelMessages.findMany({
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
            content,
            rawContent,
            lineCount: selectedMessages.length,
            totalLines: totalMessages,
            messageCount: selectedMessages.length,
            totalMessages,
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

        // Format content for AI line-based editing, then split into lines
        // Markdown pages already have natural line structure; HTML pages need addLineBreaksForAI
        const isMarkdown = page.contentMode === 'markdown';
        const formattedContent = isMarkdown
          ? (page.content || '')
          : addLineBreaksForAI(page.content || '');
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
          content: numberedContent,
          rawContent,
          lineCount: selectedLines.length,
          totalLines,
          ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
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

  /**
   * List all conversations for an AI_CHAT page
   */
  list_conversations: tool({
    description: 'List all conversations for an AI agent (AI_CHAT page). Returns conversation metadata including message counts and last activity.',
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

        // Check user access permissions
        const accessLevel = await getUserAccessLevel(userId, page.id, { silent: true });
        if (!accessLevel) {
          return {
            success: false,
            error: 'Insufficient permissions to access this agent',
          };
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
    description: 'Read messages from a specific conversation. Use lineStart/lineEnd to read specific message ranges. Messages are formatted with attribution showing who sent them.',
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

        // Check user access permissions
        const accessLevel = await getUserAccessLevel(userId, page.id, { silent: true });
        if (!accessLevel) {
          return {
            success: false,
            error: 'Insufficient permissions to access this conversation',
          };
        }

        // Get all messages for this conversation
        const messages = await db
          .select()
          .from(chatMessages)
          .where(and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.pageId, pageId),
            eq(chatMessages.isActive, true)
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
          content,
          messageCount: selectedMessages.length,
          totalMessages,
          ...(isRangeRequest && { rangeStart: effectiveStart, rangeEnd: effectiveEnd }),
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
