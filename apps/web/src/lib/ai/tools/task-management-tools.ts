import { tool } from 'ai';
import { z } from 'zod';
import { db, aiTasks, eq, and, desc, asc, ne, ilike, sql } from '@pagespace/db';
import { ToolExecutionContext } from '../types';
import { broadcastTaskEvent } from '@/lib/socket-utils';


export const taskManagementTools = {
  /**
   * Create a task list for complex multi-step operations
   */
  create_task_list: tool({
    description: 'Create a task list to track progress on complex, multi-step operations. Tasks persist across AI conversations.',
    inputSchema: z.object({
      title: z.string().describe('Title for the task list'),
      description: z.string().optional().describe('Description of what this task list is for'),
      tasks: z.array(z.object({
        title: z.string().describe('Task title'),
        description: z.string().optional().describe('Task description'),
        priority: z.enum(['low', 'medium', 'high']).default('medium'),
        estimatedMinutes: z.number().optional().describe('Estimated time in minutes'),
      })).describe('Initial tasks to add to the list'),
      contextPageId: z.string().optional().describe('Optional page ID this task list relates to'),
      contextDriveId: z.string().optional().describe('Optional drive ID this task list relates to'),
    }),
    execute: async ({ title, description, tasks, contextPageId, contextDriveId }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      const conversationId = (context as ToolExecutionContext)?.conversationId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Use transaction to ensure atomicity
        const result = await db.transaction(async (tx) => {
          // Create the main task list
          const [taskList] = await tx.insert(aiTasks).values({
            userId,
            conversationId,
            title,
            description,
            status: 'pending',
            metadata: {
              type: 'task_list',
              contextPageId,
              contextDriveId,
              createdAt: new Date().toISOString(),
            },
          }).returning();

          // Batch create individual tasks
          const taskValues = tasks.map((task, i) => ({
            userId,
            conversationId,
            parentTaskId: taskList.id,
            title: task.title,
            description: task.description,
            status: 'pending' as const,
            priority: task.priority,
            position: i + 1,
            metadata: {
              type: 'task_item',
              estimatedMinutes: task.estimatedMinutes,
            },
          }));
          
          const createdTasks = await tx.insert(aiTasks).values(taskValues).returning();

          return { taskList, createdTasks };
        });

        const { taskList, createdTasks } = result;

        // Broadcast task creation event
        await broadcastTaskEvent({
          type: 'task_list_created',
          taskListId: taskList.id,
          userId,
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
            createdAt: taskList.createdAt,
            updatedAt: taskList.updatedAt,
          },
          tasks: createdTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
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
            'Use update_task_status to mark tasks as in_progress or completed',
            'Use add_task to add more tasks to this list',
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
      taskListId: z.string().optional().describe('Specific task list ID. If not provided, returns the most recent active list'),
      includeCompleted: z.boolean().default(true).describe('Include completed tasks in the response'),
    }),
    execute: async ({ taskListId, includeCompleted = true }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      const conversationId = (context as ToolExecutionContext)?.conversationId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        let taskList;
        
        if (taskListId) {
          // Get specific task list
          taskList = await db.query.aiTasks.findFirst({
            where: and(
              eq(aiTasks.id, taskListId),
              eq(aiTasks.userId, userId),
              sql`${aiTasks.metadata}->>'type' = 'task_list'`
            ),
          });
        } else {
          // Get most recent active task list for this conversation
          taskList = await db.query.aiTasks.findFirst({
            where: and(
              eq(aiTasks.userId, userId),
              conversationId ? eq(aiTasks.conversationId, conversationId) : sql`${aiTasks.conversationId} IS NOT NULL`,
              sql`${aiTasks.metadata}->>'type' = 'task_list'`,
              eq(aiTasks.status, 'in_progress')
            ),
            orderBy: desc(aiTasks.createdAt),
          });
          
          // If no in_progress list, get most recent pending list
          if (!taskList) {
            taskList = await db.query.aiTasks.findFirst({
              where: and(
                eq(aiTasks.userId, userId),
                conversationId ? eq(aiTasks.conversationId, conversationId) : sql`${aiTasks.conversationId} IS NOT NULL`,
                sql`${aiTasks.metadata}->>'type' = 'task_list'`,
                eq(aiTasks.status, 'pending')
              ),
              orderBy: desc(aiTasks.createdAt),
            });
          }
        }

        if (!taskList) {
          throw new Error('No task list found');
        }

        // Build task query conditions
        const taskWhereConditions = includeCompleted
          ? and(
              eq(aiTasks.parentTaskId, taskList.id),
              sql`${aiTasks.metadata}->>'type' = 'task_item'`
            )
          : and(
              eq(aiTasks.parentTaskId, taskList.id),
              sql`${aiTasks.metadata}->>'type' = 'task_item'`,
              ne(aiTasks.status, 'completed')
            );

        // Get all tasks in the list
        const tasksQuery = db
          .select()
          .from(aiTasks)
          .where(taskWhereConditions)
          .orderBy(asc(aiTasks.position));

        const tasks = await tasksQuery;

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
            'Use update_task_status to mark tasks as you complete them',
            'Include notes when using update_task_status to document progress',
          ] : [
            'All tasks are either completed or in progress',
            'Consider adding new tasks if needed',
            'Use complete_task_list to mark the entire list as done',
          ]
        };
      } catch (error) {
        console.error('Error getting task list:', error);
        throw new Error(`Failed to get task list: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Update task status
   */
  update_task_status: tool({
    description: 'Update the status of a specific task in a task list.',
    inputSchema: z.object({
      taskId: z.string().describe('The ID of the task to update'),
      status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('New status for the task'),
      note: z.string().optional().describe('Optional note about the status change'),
    }),
    execute: async ({ taskId, status, note }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the task
        const task = await db.query.aiTasks.findFirst({
          where: and(
            eq(aiTasks.id, taskId),
            eq(aiTasks.userId, userId)
          ),
        });

        if (!task) {
          throw new Error('Task not found or access denied');
        }

        // Update the task
        const [updatedTask] = await db
          .update(aiTasks)
          .set({
            status,
            updatedAt: new Date(),
            completedAt: status === 'completed' ? new Date() : null,
            metadata: {
              ...(task.metadata as Record<string, unknown> || {}),
              lastStatusChange: {
                from: task.status,
                to: status,
                at: new Date().toISOString(),
                note,
              },
            },
          })
          .where(eq(aiTasks.id, taskId))
          .returning();

        // If task list exists and all tasks are complete, update list status
        if (task.parentTaskId) {
          const siblingTasks = await db
            .select()
            .from(aiTasks)
            .where(and(
              eq(aiTasks.parentTaskId, task.parentTaskId),
              sql`${aiTasks.metadata}->>'type' = 'task_item'`
            ));

          const allCompleted = siblingTasks.every(t => 
            t.id === taskId ? status === 'completed' : t.status === 'completed'
          );

          if (allCompleted) {
            await db
              .update(aiTasks)
              .set({
                status: 'completed',
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(aiTasks.id, task.parentTaskId));
          } else if (status === 'in_progress') {
            // Update parent list to in_progress if it was pending
            await db
              .update(aiTasks)
              .set({
                status: 'in_progress',
                updatedAt: new Date(),
              })
              .where(and(
                eq(aiTasks.id, task.parentTaskId),
                eq(aiTasks.status, 'pending')
              ));
          }
        }

        // Broadcast task update event
        await broadcastTaskEvent({
          type: 'task_updated',
          taskId: updatedTask.id,
          userId,
          data: {
            title: updatedTask.title,
            oldStatus: task.status,
            newStatus: status,
            note,
          },
        });

 
        // Get the updated task list and all tasks to return for rendering
        if (updatedTask.parentTaskId) {
          try {
            const taskList = await db.query.aiTasks.findFirst({
              where: and(
                eq(aiTasks.id, updatedTask.parentTaskId),
                sql`${aiTasks.metadata}->>'type' = 'task_list'`
              ),
            });

            const allTasks = await db
              .select()
              .from(aiTasks)
              .where(and(
                eq(aiTasks.parentTaskId, updatedTask.parentTaskId),
                sql`${aiTasks.metadata}->>'type' = 'task_item'`
              ))
              .orderBy(asc(aiTasks.position));

            if (taskList && allTasks) {
              return {
                success: true,
                taskList: {
                  id: taskList.id,
                  title: taskList.title,
                  description: taskList.description,
                  status: taskList.status,
                  createdAt: taskList.createdAt,
                  updatedAt: taskList.updatedAt,
                },
                tasks: allTasks.map(t => ({
                  id: t.id,
                  title: t.title,
                  description: t.description,
                  status: t.status,
                  priority: t.priority,
                  position: t.position,
                  completedAt: t.completedAt,
                  metadata: t.metadata,
                })),
                message: `Task "${updatedTask.title}" status changed from ${task.status} to ${status}`,
                summary: `Updated task status to ${status}`,
              };
            }
          } catch (error) {
            console.error('Error fetching updated task list:', error);
          }
        }

        // Fallback if we can't fetch the full task list
        return {
          success: true,
          task: {
            id: updatedTask.id,
            title: updatedTask.title,
            previousStatus: task.status,
            newStatus: updatedTask.status,
            completedAt: updatedTask.completedAt,
          },
          message: `Task "${updatedTask.title}" status changed from ${task.status} to ${status}`,
          summary: `Updated task status to ${status}`,
        };
      } catch (error) {
        console.error('Error updating task status:', error);
        throw new Error(`Failed to update task status: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Add a new task to an existing list
   */
  add_task: tool({
    description: 'Add a new task to an existing task list.',
    inputSchema: z.object({
      taskListId: z.string().describe('The ID of the task list to add to'),
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      priority: z.enum(['low', 'medium', 'high']).default('medium'),
      position: z.number().optional().describe('Position in the list (defaults to end)'),
      estimatedMinutes: z.number().optional().describe('Estimated time in minutes'),
    }),
    execute: async ({ taskListId, title, description, priority, position, estimatedMinutes }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Verify task list exists and user has access
        const taskList = await db.query.aiTasks.findFirst({
          where: and(
            eq(aiTasks.id, taskListId),
            eq(aiTasks.userId, userId),
            sql`${aiTasks.metadata}->>'type' = 'task_list'`
          ),
        });

        if (!taskList) {
          throw new Error('Task list not found or access denied');
        }

        // Get existing tasks to determine position
        const existingTasks = await db
          .select()
          .from(aiTasks)
          .where(and(
            eq(aiTasks.parentTaskId, taskListId),
            sql`${aiTasks.metadata}->>'type' = 'task_item'`
          ))
          .orderBy(desc(aiTasks.position));

        const nextPosition = position || (existingTasks.length > 0 ? (existingTasks[0]?.position || 0) + 1 : 1);

        // Create the new task
        const [newTask] = await db.insert(aiTasks).values({
          userId,
          conversationId: taskList.conversationId,
          parentTaskId: taskListId,
          title,
          description,
          status: 'pending',
          priority,
          position: nextPosition,
          metadata: {
            type: 'task_item',
            estimatedMinutes,
            addedAt: new Date().toISOString(),
          },
        }).returning();

        // Broadcast task addition event
        await broadcastTaskEvent({
          type: 'task_added',
          taskId: newTask.id,
          taskListId,
          userId,
          data: {
            title: newTask.title,
            priority: newTask.priority,
          },
        });

 
        // Get all tasks to return the complete task list for rendering
        const allTasks = await db
          .select()
          .from(aiTasks)
          .where(and(
            eq(aiTasks.parentTaskId, taskListId),
            sql`${aiTasks.metadata}->>'type' = 'task_item'`
          ))
          .orderBy(asc(aiTasks.position));

        return {
          success: true,
          taskList: {
            id: taskList.id,
            title: taskList.title,
            description: taskList.description,
            status: taskList.status,
            createdAt: taskList.createdAt,
            updatedAt: taskList.updatedAt,
          },
          tasks: allTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            position: t.position,
            completedAt: t.completedAt,
            metadata: t.metadata,
          })),
          message: `Added task "${title}" to list "${taskList.title}"`,
          summary: `Added new ${priority} priority task to the list`,
        };
      } catch (error) {
        console.error('Error adding task:', error);
        throw new Error(`Failed to add task: ${error instanceof Error ? error.message : String(error)}`);
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
    }),
    execute: async ({ taskListId, searchTitle }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      const currentConversationId = (context as ToolExecutionContext)?.conversationId;
      
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        let taskList;
        
        if (taskListId) {
          // Get specific task list
          taskList = await db.query.aiTasks.findFirst({
            where: and(
              eq(aiTasks.id, taskListId),
              eq(aiTasks.userId, userId),
              sql`${aiTasks.metadata}->>'type' = 'task_list'`
            ),
          });
        } else if (searchTitle) {
          // Search by title
          taskList = await db.query.aiTasks.findFirst({
            where: and(
              eq(aiTasks.userId, userId),
              sql`${aiTasks.metadata}->>'type' = 'task_list'`,
              ilike(aiTasks.title, `%${searchTitle}%`)
            ),
            orderBy: desc(aiTasks.updatedAt),
          });
        } else {
          // Get most recent incomplete task list
          taskList = await db.query.aiTasks.findFirst({
            where: and(
              eq(aiTasks.userId, userId),
              sql`${aiTasks.metadata}->>'type' = 'task_list'`,
              ne(aiTasks.status, 'completed')
            ),
            orderBy: desc(aiTasks.updatedAt),
          });
        }

        if (!taskList) {
          throw new Error('No matching task list found');
        }

        // Update conversation ID to current (only if actually different, handling nulls)
        const needsConversationUpdate = (taskList.conversationId || null) !== (currentConversationId || null);
        
        if (needsConversationUpdate && currentConversationId) {
          try {
            // Update parent task list
            await db
              .update(aiTasks)
              .set({
                conversationId: currentConversationId,
                metadata: {
                  ...(typeof taskList.metadata === 'object' && taskList.metadata !== null ? taskList.metadata : {}),
                  resumedAt: new Date().toISOString(),
                  resumedFrom: taskList.conversationId || null,
                },
              })
              .where(eq(aiTasks.id, taskList.id));

            // Check if we have child tasks that need updating
            const childTasks = await db
              .select({ id: aiTasks.id, conversationId: aiTasks.conversationId })
              .from(aiTasks)
              .where(eq(aiTasks.parentTaskId, taskList.id));

            // Only update child tasks if they exist and need conversation ID changes
            const childTasksNeedingUpdate = childTasks.filter(child => 
              (child.conversationId || null) !== (currentConversationId || null)
            );

            if (childTasksNeedingUpdate.length > 0) {
              await db
                .update(aiTasks)
                .set({
                  conversationId: currentConversationId,
                })
                .where(eq(aiTasks.parentTaskId, taskList.id));
            }
          } catch (error) {
            console.error('Error updating task list conversation context:', error);
            throw new Error(`Failed to update task list context: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Get current status
        const tasks = await db
          .select()
          .from(aiTasks)
          .where(and(
            eq(aiTasks.parentTaskId, taskList.id),
            sql`${aiTasks.metadata}->>'type' = 'task_item'`
          ))
          .orderBy(asc(aiTasks.position));

        const completedTasks = tasks.filter(t => t.status === 'completed').length;
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        return {
          success: true,
          taskList: {
            id: taskList.id,
            title: taskList.title,
            description: taskList.description,
            status: taskList.status,
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
          message: `Resumed task list "${taskList.title}" from previous conversation`,
          summary: `Resuming "${taskList.title}" - ${completedTasks}/${tasks.length} tasks completed`,
          nextSteps: pendingTasks.length > 0 ? [
            `Continue with next task: "${pendingTasks[0].title}"`,
            'Use get_task_list to see full status',
            'Use update_task_status as you complete tasks',
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