import { tool } from 'ai';
import { z } from 'zod';
import { db, taskLists, taskItems, pages, eq, and, desc, asc } from '@pagespace/db';
import { type ToolExecutionContext } from '../core';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canUserEditPage, logPageActivity, getActorInfo } from '@pagespace/lib/server';
import { getDefaultContent, PageType } from '@pagespace/lib';

// Helper: Extract AI attribution context with actor info for activity logging
async function getAiContextWithActor(context: ToolExecutionContext) {
  const actorInfo = await getActorInfo(context.userId);
  return {
    ...actorInfo,
    isAiGenerated: true,
    aiProvider: context.aiProvider,
    aiModel: context.aiModel,
    aiConversationId: context.conversationId,
  };
}

/**
 * Helper to verify page access for page-linked task lists
 */
async function verifyPageAccess(userId: string, pageId: string): Promise<boolean> {
  return canUserEditPage(userId, pageId);
}

export const taskManagementTools = {
  /**
   * Update or create a task
   * - If taskId is provided, updates the existing task
   * - If taskId is not provided but taskListId or pageId is, creates a new task
   */
  update_task: tool({
    description: `Update an existing task or create a new one on a TASK_LIST page.

To UPDATE: provide taskId
To CREATE: provide pageId (of a TASK_LIST page) and title

When creating tasks:
- A DOCUMENT page is automatically created as a child of the TASK_LIST page
- This linked page stores task notes and progress
- The page title stays synced with the task title
- DO NOT delete these pages directly - use this tool to manage tasks`,
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID to update (omit to create new task)'),
      pageId: z.string().optional().describe('TASK_LIST page ID (required when creating new task)'),
      title: z.string().optional().describe('Task title (required when creating)'),
      description: z.string().optional().describe('Task description'),
      status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional().describe('Task status'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Task priority'),
      assigneeId: z.string().nullable().optional().describe('User ID to assign (null to unassign)'),
      dueDate: z.string().nullable().optional().describe('Due date in ISO format (null to clear)'),
      note: z.string().optional().describe('Note about this update'),
      position: z.number().optional().describe('Position in the list (for new tasks, defaults to end)'),
    }),
    execute: async (params, { experimental_context: context }) => {
      const { taskId, pageId, title, description, status, priority, assigneeId, dueDate, note, position } = params;
      const userId = (context as ToolExecutionContext)?.userId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      // Determine if this is an update or create operation
      const isUpdate = !!taskId;

      if (!isUpdate && !pageId) {
        throw new Error('Either taskId (to update) or pageId (to create) must be provided');
      }

      if (!isUpdate && !title) {
        throw new Error('Title is required when creating a new task');
      }

      try {
        let taskList: typeof taskLists.$inferSelect | undefined;
        let resultTask;
        let message: string;

        if (isUpdate) {
          // UPDATE existing task
          const existingTask = await db.query.taskItems.findFirst({
            where: eq(taskItems.id, taskId),
          });

          if (!existingTask) {
            throw new Error('Task not found');
          }

          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.id, existingTask.taskListId),
          });

          if (!taskList) {
            throw new Error('Task list not found');
          }

          // Verify permissions
          if (taskList.pageId) {
            const hasAccess = await verifyPageAccess(userId, taskList.pageId);
            if (!hasAccess) {
              throw new Error('You do not have permission to update tasks on this page');
            }
          } else if (taskList.userId !== userId) {
            throw new Error('You do not have permission to update this task');
          }

          // Build update object
          const updateData: Record<string, unknown> = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (status !== undefined) {
            updateData.status = status;
            updateData.completedAt = status === 'completed' ? new Date() : null;
          }
          if (priority !== undefined) updateData.priority = priority;
          if (assigneeId !== undefined) updateData.assigneeId = assigneeId;
          if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;

          // Add note to metadata
          if (note || status !== undefined) {
            updateData.metadata = {
              ...(existingTask.metadata as Record<string, unknown> || {}),
              lastUpdate: {
                at: new Date().toISOString(),
                note,
                ...(status !== undefined ? { statusChange: { from: existingTask.status, to: status } } : {}),
              },
            };
          }

          const [updatedTask] = await db
            .update(taskItems)
            .set(updateData)
            .where(eq(taskItems.id, taskId))
            .returning();

          resultTask = updatedTask;

          // Update task list status based on task completion
          if (status !== undefined) {
            const siblingTasks = await db
              .select()
              .from(taskItems)
              .where(eq(taskItems.taskListId, existingTask.taskListId));

            const allCompleted = siblingTasks.every(t =>
              t.id === taskId ? status === 'completed' : t.status === 'completed'
            );

            if (allCompleted) {
              await db.update(taskLists).set({ status: 'completed' }).where(eq(taskLists.id, existingTask.taskListId));
            } else if (status === 'in_progress') {
              await db.update(taskLists).set({ status: 'in_progress' }).where(and(
                eq(taskLists.id, existingTask.taskListId),
                eq(taskLists.status, 'pending')
              ));
            }
          }

          // Broadcast update event
          await broadcastTaskEvent({
            type: 'task_updated',
            taskId: updatedTask.id,
            userId,
            pageId: taskList.pageId || undefined,
            data: { title: updatedTask.title, note },
          });

          message = `Updated task "${updatedTask.title}"`;
        } else {
          // CREATE new task - requires pageId of a TASK_LIST page

          // Get the TASK_LIST page and verify access
          const taskListPage = await db.query.pages.findFirst({
            where: and(eq(pages.id, pageId!), eq(pages.isTrashed, false)),
            columns: { id: true, driveId: true, type: true, title: true },
          });

          if (!taskListPage) {
            throw new Error('Page not found');
          }

          if (taskListPage.type !== 'TASK_LIST') {
            throw new Error('Page must be a TASK_LIST page to add tasks');
          }

          const hasAccess = await verifyPageAccess(userId, pageId!);
          if (!hasAccess) {
            throw new Error('You do not have permission to add tasks to this page');
          }

          // Find or create task_list record for this page
          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.pageId, pageId!),
          });

          if (!taskList) {
            // Auto-create task_list record for this page
            const [newTaskList] = await db.insert(taskLists).values({
              userId,
              pageId: pageId!,
              title: taskListPage.title,
              status: 'pending',
              metadata: {
                createdAt: new Date().toISOString(),
                autoCreated: true,
              },
            }).returning();
            taskList = newTaskList;
          }

          // Determine position for new task
          const existingTasks = await db
            .select()
            .from(taskItems)
            .where(eq(taskItems.taskListId, taskList.id))
            .orderBy(desc(taskItems.position));

          const nextTaskPosition = position ?? (existingTasks.length > 0 ? (existingTasks[0]?.position || 0) + 1 : 0);

          // Get next page position for the child document
          const lastChildPage = await db.query.pages.findFirst({
            where: and(eq(pages.parentId, pageId!), eq(pages.isTrashed, false)),
            orderBy: [desc(pages.position)],
          });
          const nextPagePosition = (lastChildPage?.position ?? 0) + 1;

          // Create document page and task in transaction
          const result = await db.transaction(async (tx) => {
            // Create document page for the task
            const [taskPage] = await tx.insert(pages).values({
              title: title!,
              type: 'DOCUMENT',
              parentId: pageId!,
              driveId: taskListPage.driveId,
              content: getDefaultContent(PageType.DOCUMENT),
              position: nextPagePosition,
              updatedAt: new Date(),
            }).returning();

            // Create task with link to the page
            const [newTask] = await tx.insert(taskItems).values({
              taskListId: taskList!.id,
              userId,
              pageId: taskPage.id,
              title: title!,
              description: description || null,
              status: status || 'pending',
              priority: priority || 'medium',
              assigneeId: assigneeId || null,
              dueDate: dueDate ? new Date(dueDate) : null,
              position: nextTaskPosition,
              metadata: {
                createdAt: new Date().toISOString(),
                note,
              },
            }).returning();

            return { task: newTask, page: taskPage };
          });

          resultTask = result.task;
          const createdPage = result.page;

          // Broadcast creation events
          await Promise.all([
            broadcastTaskEvent({
              type: 'task_added',
              taskId: resultTask.id,
              taskListId: taskList.id,
              userId,
              pageId: pageId!,
              data: { title: resultTask.title, priority: resultTask.priority, pageId: createdPage.id },
            }),
            broadcastPageEvent(
              createPageEventPayload(taskListPage.driveId, createdPage.id, 'created', {
                parentId: pageId,
                title: createdPage.title,
                type: 'DOCUMENT',
              }),
            ),
          ]);

          // Log activity for AI-generated task/page creation
          logPageActivity(userId, 'create', {
            id: createdPage.id,
            title: createdPage.title,
            driveId: taskListPage.driveId,
          }, {
            ...await getAiContextWithActor(context as ToolExecutionContext),
            metadata: { taskId: resultTask.id, taskTitle: resultTask.title },
          });

          message = `Created task "${resultTask.title}" with linked document page`;
        }

        // Get all tasks for response with assignee relations
        const allTasks = await db.query.taskItems.findMany({
          where: eq(taskItems.taskListId, taskList!.id),
          orderBy: [asc(taskItems.position)],
          with: {
            assignee: {
              columns: {
                id: true,
                name: true,
                image: true,
              },
            },
          },
        });

        // Refresh task list with page info for driveId
        const refreshedTaskList = await db.query.taskLists.findFirst({
          where: eq(taskLists.id, taskList!.id),
        });

        // Get driveId from the associated page
        let driveId: string | undefined;
        if (refreshedTaskList?.pageId) {
          const taskListPage = await db.query.pages.findFirst({
            where: eq(pages.id, refreshedTaskList.pageId),
            columns: { driveId: true },
          });
          driveId = taskListPage?.driveId;
        }

        return {
          success: true,
          action: isUpdate ? 'updated' : 'created',
          task: {
            id: resultTask.id,
            title: resultTask.title,
            description: resultTask.description,
            status: resultTask.status,
            priority: resultTask.priority,
            assigneeId: resultTask.assigneeId,
            dueDate: resultTask.dueDate,
            position: resultTask.position,
            completedAt: resultTask.completedAt,
            pageId: resultTask.pageId,
          },
          taskList: refreshedTaskList ? {
            id: refreshedTaskList.id,
            title: refreshedTaskList.title,
            description: refreshedTaskList.description,
            status: refreshedTaskList.status,
            pageId: refreshedTaskList.pageId,
            driveId,
          } : null,
          tasks: allTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            assigneeId: t.assigneeId,
            dueDate: t.dueDate,
            position: t.position,
            completedAt: t.completedAt,
            pageId: t.pageId,
            assignee: t.assignee ? {
              id: t.assignee.id,
              name: t.assignee.name,
              image: t.assignee.image,
            } : null,
          })),
          message,
        };
      } catch (error) {
        console.error('Error in update_task:', error);
        throw new Error(`Failed to ${isUpdate ? 'update' : 'create'} task: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
