import { tool } from 'ai';
import { z } from 'zod';
import { db, taskLists, taskItems, eq, and, desc, asc, ne, ilike, sql } from '@pagespace/db';
import { ToolExecutionContext } from '../core/types';
import { broadcastTaskEvent } from '@/lib/websocket/socket-utils';
import { canUserEditPage } from '@pagespace/lib/server';

/**
 * Helper to verify page access for page-linked task lists
 */
async function verifyPageAccess(userId: string, pageId: string): Promise<boolean> {
  return canUserEditPage(userId, pageId);
}

export const taskManagementTools = {
  /**
   * Create a task list for complex multi-step operations
   * Can be linked to a page (pageId) or conversation (conversationId)
   */
  create_task_list: tool({
    description: 'Create a task list to track progress on complex, multi-step operations. Tasks persist across AI conversations. Can be linked to a TASK_LIST page or exist as a conversation-scoped list.',
    inputSchema: z.object({
      title: z.string().describe('Title for the task list'),
      description: z.string().optional().describe('Description of what this task list is for'),
      tasks: z.array(z.object({
        title: z.string().describe('Task title'),
        description: z.string().optional().describe('Task description'),
        priority: z.enum(['low', 'medium', 'high']).default('medium'),
        assigneeId: z.string().optional().describe('User ID to assign the task to'),
        dueDate: z.string().optional().describe('Due date in ISO format'),
        estimatedMinutes: z.number().optional().describe('Estimated time in minutes'),
      })).describe('Initial tasks to add to the list'),
      pageId: z.string().optional().describe('Optional page ID to link this task list to a TASK_LIST page'),
    }),
    execute: async ({ title, description, tasks, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      const conversationId = (context as ToolExecutionContext)?.conversationId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      // If pageId provided, verify user has edit access
      if (pageId) {
        const hasAccess = await verifyPageAccess(userId, pageId);
        if (!hasAccess) {
          throw new Error('You do not have permission to create tasks on this page');
        }
      }

      try {
        // Use transaction to ensure atomicity
        const result = await db.transaction(async (tx) => {
          // Create the task list
          const [taskList] = await tx.insert(taskLists).values({
            userId,
            pageId: pageId || null,
            conversationId: pageId ? null : conversationId, // Only set conversationId if not page-linked
            title,
            description,
            status: 'pending',
            metadata: {
              createdAt: new Date().toISOString(),
            },
          }).returning();

          // Batch create individual tasks
          const taskValues = tasks.map((task, i) => ({
            taskListId: taskList.id,
            userId,
            title: task.title,
            description: task.description,
            status: 'pending' as const,
            priority: task.priority,
            assigneeId: task.assigneeId || null,
            dueDate: task.dueDate ? new Date(task.dueDate) : null,
            position: i,
            metadata: {
              estimatedMinutes: task.estimatedMinutes,
            },
          }));

          const createdTasks = taskValues.length > 0
            ? await tx.insert(taskItems).values(taskValues).returning()
            : [];

          return { taskList, createdTasks };
        });

        const { taskList, createdTasks } = result;

        // Broadcast task creation event
        await broadcastTaskEvent({
          type: 'task_list_created',
          taskListId: taskList.id,
          userId,
          pageId: pageId || undefined,
          data: {
            title: taskList.title,
            taskCount: createdTasks.length,
          },
        });

        return {
          success: true,
          taskList: {
            id: taskList.id,
            title: taskList.title,
            description: taskList.description,
            status: taskList.status,
            pageId: taskList.pageId,
            createdAt: taskList.createdAt,
            updatedAt: taskList.updatedAt,
          },
          tasks: createdTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            assigneeId: t.assigneeId,
            dueDate: t.dueDate,
            position: t.position,
            completedAt: t.completedAt,
            metadata: t.metadata,
          })),
          summary: `Created task list "${title}" with ${createdTasks.length} task${createdTasks.length === 1 ? '' : 's'}`,
          stats: {
            totalTasks: createdTasks.length,
            priorities: {
              high: createdTasks.filter(t => t.priority === 'high').length,
              medium: createdTasks.filter(t => t.priority === 'medium').length,
              low: createdTasks.filter(t => t.priority === 'low').length,
            },
            estimatedTotalMinutes: createdTasks.reduce((sum, t) =>
              sum + ((t.metadata as { estimatedMinutes?: number })?.estimatedMinutes || 0), 0
            ),
          },
          nextSteps: [
            'Use update_task with taskId to mark tasks as in_progress or completed',
            'Use update_task with taskListId to add more tasks to this list',
            'Use get_task_list to review current status',
          ]
        };
      } catch (error) {
        console.error('Error creating task list:', error);
        throw new Error(`Failed to create task list: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Get current task list status
   */
  get_task_list: tool({
    description: 'Get the current status of a task list, including all tasks and their progress.',
    inputSchema: z.object({
      taskListId: z.string().optional().describe('Specific task list ID'),
      pageId: z.string().optional().describe('Get task list for a specific TASK_LIST page'),
      includeCompleted: z.boolean().default(true).describe('Include completed tasks in the response'),
    }),
    execute: async ({ taskListId, pageId, includeCompleted = true }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      const conversationId = (context as ToolExecutionContext)?.conversationId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        let taskList;

        if (taskListId) {
          // Get specific task list by ID
          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.id, taskListId),
          });
        } else if (pageId) {
          // Get task list for a specific page
          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.pageId, pageId),
          });
        } else {
          // Get most recent active task list for this conversation
          taskList = await db.query.taskLists.findFirst({
            where: and(
              eq(taskLists.userId, userId),
              conversationId ? eq(taskLists.conversationId, conversationId) : sql`${taskLists.conversationId} IS NOT NULL`,
              eq(taskLists.status, 'in_progress')
            ),
            orderBy: desc(taskLists.createdAt),
          });

          // If no in_progress list, get most recent pending list
          if (!taskList) {
            taskList = await db.query.taskLists.findFirst({
              where: and(
                eq(taskLists.userId, userId),
                conversationId ? eq(taskLists.conversationId, conversationId) : sql`${taskLists.conversationId} IS NOT NULL`,
                eq(taskLists.status, 'pending')
              ),
              orderBy: desc(taskLists.createdAt),
            });
          }
        }

        if (!taskList) {
          throw new Error('No task list found');
        }

        // Build task query
        const taskWhereConditions = includeCompleted
          ? eq(taskItems.taskListId, taskList.id)
          : and(
              eq(taskItems.taskListId, taskList.id),
              ne(taskItems.status, 'completed')
            );

        const tasks = await db
          .select()
          .from(taskItems)
          .where(taskWhereConditions)
          .orderBy(asc(taskItems.position));

        // Calculate progress
        const totalTasks = tasks.length;
        const completedTasks = tasks.filter(t => t.status === 'completed').length;
        const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
        const pendingTasks = tasks.filter(t => t.status === 'pending').length;
        const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

        return {
          success: true,
          taskList: {
            id: taskList.id,
            title: taskList.title,
            description: taskList.description,
            status: taskList.status,
            pageId: taskList.pageId,
            createdAt: taskList.createdAt,
            updatedAt: taskList.updatedAt,
          },
          tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            position: t.position,
            completedAt: t.completedAt,
            dueDate: t.dueDate,
            estimatedMinutes: (t.metadata as { estimatedMinutes?: number })?.estimatedMinutes,
          })),
          progress: {
            totalTasks,
            completedTasks,
            inProgressTasks,
            pendingTasks,
            progressPercentage,
          },
          summary: `Task list "${taskList.title}" is ${progressPercentage}% complete (${completedTasks}/${totalTasks} tasks done)`,
          nextSteps: pendingTasks > 0 ? [
            'Continue working through pending tasks',
            'Use update_task to mark tasks as you complete them',
            'Include notes when using update_task to document progress',
          ] : [
            'All tasks are either completed or in progress',
            'Consider adding new tasks if needed',
          ]
        };
      } catch (error) {
        console.error('Error getting task list:', error);
        throw new Error(`Failed to get task list: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Update or create a task
   * - If taskId is provided, updates the existing task
   * - If taskId is not provided but taskListId is, creates a new task
   */
  update_task: tool({
    description: 'Update an existing task or create a new one. Provide taskId to update, or taskListId without taskId to create.',
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID to update (omit to create new task)'),
      taskListId: z.string().optional().describe('Task list ID (required when creating new task)'),
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
      const { taskId, taskListId, title, description, status, priority, assigneeId, dueDate, note, position } = params;
      const userId = (context as ToolExecutionContext)?.userId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      // Determine if this is an update or create operation
      const isUpdate = !!taskId;

      if (!isUpdate && !taskListId) {
        throw new Error('Either taskId (to update) or taskListId (to create) must be provided');
      }

      if (!isUpdate && !title) {
        throw new Error('Title is required when creating a new task');
      }

      try {
        let taskList;
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
          // CREATE new task
          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.id, taskListId!),
          });

          if (!taskList) {
            throw new Error('Task list not found');
          }

          // Verify permissions
          if (taskList.pageId) {
            const hasAccess = await verifyPageAccess(userId, taskList.pageId);
            if (!hasAccess) {
              throw new Error('You do not have permission to add tasks to this page');
            }
          } else if (taskList.userId !== userId) {
            throw new Error('You do not have permission to add tasks to this list');
          }

          // Determine position
          const existingTasks = await db
            .select()
            .from(taskItems)
            .where(eq(taskItems.taskListId, taskListId!))
            .orderBy(desc(taskItems.position));

          const nextPosition = position ?? (existingTasks.length > 0 ? (existingTasks[0]?.position || 0) + 1 : 0);

          // Create the task
          const [newTask] = await db.insert(taskItems).values({
            taskListId: taskListId!,
            userId,
            title: title!,
            description: description || null,
            status: status || 'pending',
            priority: priority || 'medium',
            assigneeId: assigneeId || null,
            dueDate: dueDate ? new Date(dueDate) : null,
            position: nextPosition,
            metadata: {
              createdAt: new Date().toISOString(),
              note,
            },
          }).returning();

          resultTask = newTask;

          // Broadcast creation event
          await broadcastTaskEvent({
            type: 'task_added',
            taskId: newTask.id,
            taskListId: taskListId!,
            userId,
            pageId: taskList.pageId || undefined,
            data: { title: newTask.title, priority: newTask.priority },
          });

          message = `Created task "${newTask.title}"`;
        }

        // Get all tasks for response
        const allTasks = await db
          .select()
          .from(taskItems)
          .where(eq(taskItems.taskListId, taskList!.id))
          .orderBy(asc(taskItems.position));

        // Refresh task list
        const refreshedTaskList = await db.query.taskLists.findFirst({
          where: eq(taskLists.id, taskList!.id),
        });

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
          },
          taskList: refreshedTaskList ? {
            id: refreshedTaskList.id,
            title: refreshedTaskList.title,
            description: refreshedTaskList.description,
            status: refreshedTaskList.status,
            pageId: refreshedTaskList.pageId,
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
          })),
          message,
        };
      } catch (error) {
        console.error('Error in update_task:', error);
        throw new Error(`Failed to ${isUpdate ? 'update' : 'create'} task: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Resume a previous task list from another conversation
   */
  resume_task_list: tool({
    description: 'Resume working on a task list from a previous conversation. Allows continuation of complex operations across sessions.',
    inputSchema: z.object({
      taskListId: z.string().optional().describe('Specific task list ID to resume'),
      searchTitle: z.string().optional().describe('Search for task list by title if ID not known'),
      pageId: z.string().optional().describe('Resume task list for a specific TASK_LIST page'),
    }),
    execute: async ({ taskListId, searchTitle, pageId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      const currentConversationId = (context as ToolExecutionContext)?.conversationId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        let taskList;

        if (taskListId) {
          // Get specific task list
          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.id, taskListId),
          });
        } else if (pageId) {
          // Get task list for a specific page
          taskList = await db.query.taskLists.findFirst({
            where: eq(taskLists.pageId, pageId),
          });
        } else if (searchTitle) {
          // Search by title
          taskList = await db.query.taskLists.findFirst({
            where: and(
              eq(taskLists.userId, userId),
              ilike(taskLists.title, `%${searchTitle}%`)
            ),
            orderBy: desc(taskLists.updatedAt),
          });
        } else {
          // Get most recent incomplete task list
          taskList = await db.query.taskLists.findFirst({
            where: and(
              eq(taskLists.userId, userId),
              ne(taskLists.status, 'completed')
            ),
            orderBy: desc(taskLists.updatedAt),
          });
        }

        if (!taskList) {
          throw new Error('No matching task list found');
        }

        // Update conversation ID if this is a conversation-linked list
        if (!taskList.pageId && currentConversationId && taskList.conversationId !== currentConversationId) {
          await db
            .update(taskLists)
            .set({
              conversationId: currentConversationId,
              metadata: {
                ...(typeof taskList.metadata === 'object' && taskList.metadata !== null ? taskList.metadata : {}),
                resumedAt: new Date().toISOString(),
                resumedFrom: taskList.conversationId || null,
              },
            })
            .where(eq(taskLists.id, taskList.id));
        }

        // Get current status
        const tasks = await db
          .select()
          .from(taskItems)
          .where(eq(taskItems.taskListId, taskList.id))
          .orderBy(asc(taskItems.position));

        const completedTasks = tasks.filter(t => t.status === 'completed').length;
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        return {
          success: true,
          taskList: {
            id: taskList.id,
            title: taskList.title,
            description: taskList.description,
            status: taskList.status,
            pageId: taskList.pageId,
            createdAt: taskList.createdAt,
            updatedAt: taskList.updatedAt,
          },
          tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            position: t.position,
            completedAt: t.completedAt,
            metadata: t.metadata,
          })),
          progress: {
            totalTasks: tasks.length,
            completedTasks,
            remainingTasks: tasks.length - completedTasks,
            nextPendingTask: pendingTasks[0] ? {
              id: pendingTasks[0].id,
              title: pendingTasks[0].title,
              priority: pendingTasks[0].priority,
            } : null,
          },
          message: `Resumed task list "${taskList.title}"`,
          summary: `Resuming "${taskList.title}" - ${completedTasks}/${tasks.length} tasks completed`,
          nextSteps: pendingTasks.length > 0 ? [
            `Continue with next task: "${pendingTasks[0].title}"`,
            'Use get_task_list to see full status',
            'Use update_task as you complete tasks',
          ] : [
            'All tasks are completed',
            'Consider marking the task list as complete',
            'Review completed work',
          ]
        };
      } catch (error) {
        console.error('Error resuming task list:', error);
        throw new Error(`Failed to resume task list: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
