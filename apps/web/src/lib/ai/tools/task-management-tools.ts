import { tool } from 'ai';
import { z } from 'zod';
import { db, taskLists, taskItems, taskStatusConfigs, taskAssignees, pages, eq, and, desc, asc, isNull, inArray } from '@pagespace/db';
import { type ToolExecutionContext } from '../core';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canUserEditPage, canUserViewPage, getUserDriveAccess, logPageActivity, getActorInfo } from '@pagespace/lib/server';
import { getDefaultContent, PageType } from '@pagespace/lib';

// Helper: Extract AI attribution context with actor info for activity logging
async function getAiContextWithActor(context: ToolExecutionContext) {
  const actorInfo = await getActorInfo(context.userId);
  // Build chain metadata (Tier 1)
  const chainMetadata = {
    ...(context.parentAgentId && { parentAgentId: context.parentAgentId }),
    ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
    ...(context.agentChain?.length && { agentChain: context.agentChain }),
    ...(context.requestOrigin && { requestOrigin: context.requestOrigin }),
  };

  return {
    ...actorInfo,
    isAiGenerated: true,
    aiProvider: context.aiProvider,
    aiModel: context.aiModel,
    aiConversationId: context.conversationId,
    metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
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
- DO NOT delete these pages directly - use this tool to manage tasks

Status:
- Task lists support custom statuses. Default statuses: pending, in_progress, blocked, completed
- Each status belongs to a group (todo, in_progress, done) that controls completion behavior
- Use a status slug that exists in the task list's configuration

Assignment:
- Use assigneeIds array to assign multiple users and/or agents
- Each entry: { type: 'user'|'agent', id: 'string' }
- Or use legacy assigneeId/assigneeAgentId for single assignment
- Agents can assign tasks to themselves or other agents`,
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task ID to update (omit to create new task)'),
      pageId: z.string().optional().describe('TASK_LIST page ID (required when creating new task)'),
      title: z.string().optional().describe('Task title (required when creating)'),
      description: z.string().optional().describe('Task description'),
      status: z.string().optional().describe('Task status slug (e.g. pending, in_progress, completed, blocked, or any custom status)'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Task priority'),
      assigneeId: z.string().nullable().optional().describe('User ID to assign (null to unassign user). Legacy single-assignee field.'),
      assigneeAgentId: z.string().nullable().optional().describe('Agent page ID to assign (null to unassign agent). Legacy single-assignee field.'),
      assigneeIds: z.array(z.object({
        type: z.enum(['user', 'agent']),
        id: z.string(),
      })).optional().describe('Multiple assignees. Each: { type: "user"|"agent", id: "..." }'),
      dueDate: z.string().nullable().optional().describe('Due date in ISO format (null to clear)'),
      note: z.string().optional().describe('Note about this update'),
      position: z.number().optional().describe('Position in the list (for new tasks, defaults to end)'),
    }),
    execute: async (params, { experimental_context: context }) => {
      const { taskId, pageId, title, description, status, priority, assigneeId, assigneeAgentId, assigneeIds, dueDate, note, position } = params;
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

          // Get driveId for agent validation (if task list has a page)
          let taskListDriveId: string | undefined;
          if (taskList.pageId) {
            const taskListPage = await db.query.pages.findFirst({
              where: eq(pages.id, taskList.pageId),
              columns: { driveId: true },
            });
            taskListDriveId = taskListPage?.driveId;
          }

          // Validate assigneeAgentId if provided
          if (assigneeAgentId) {
            const agentPage = await db.query.pages.findFirst({
              where: and(
                eq(pages.id, assigneeAgentId),
                eq(pages.type, 'AI_CHAT'),
                eq(pages.isTrashed, false)
              ),
              columns: { id: true, driveId: true },
            });

            if (!agentPage) {
              throw new Error('Invalid agent ID - must be an AI agent page');
            }

            if (taskListDriveId && agentPage.driveId !== taskListDriveId) {
              throw new Error('Agent must be in the same drive as the task list');
            }
          }

          // Fetch status configs for rollup and validation
          const validConfigs = await db.query.taskStatusConfigs.findMany({
            where: eq(taskStatusConfigs.taskListId, existingTask.taskListId),
            columns: { slug: true, group: true },
          });

          // Build update object
          const updateData: Record<string, unknown> = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (status !== undefined) {
            if (validConfigs.length > 0) {
              const matched = validConfigs.find(c => c.slug === status);
              if (!matched) {
                throw new Error(`Invalid status "${status}". Valid: ${validConfigs.map(c => c.slug).join(', ')}`);
              }
              updateData.status = status;
              updateData.completedAt = matched.group === 'done' ? new Date() : null;
            } else {
              updateData.status = status;
              updateData.completedAt = status === 'completed' ? new Date() : null;
            }
          }
          if (priority !== undefined) updateData.priority = priority;
          if (assigneeId !== undefined) updateData.assigneeId = assigneeId;
          if (assigneeAgentId !== undefined) updateData.assigneeAgentId = assigneeAgentId;
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

          resultTask = await db.transaction(async (tx) => {
            const [updatedTask] = await tx
              .update(taskItems)
              .set(updateData)
              .where(eq(taskItems.id, taskId))
              .returning();

            // Handle multiple assignees
            if (assigneeIds && assigneeIds.length > 0) {
              await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
              const rows = assigneeIds.map(a => ({
                taskId,
                ...(a.type === 'user' ? { userId: a.id } : { agentPageId: a.id }),
              }));
              await tx.insert(taskAssignees).values(rows);

              // Sync legacy fields
              const firstUser = assigneeIds.find(a => a.type === 'user');
              const firstAgent = assigneeIds.find(a => a.type === 'agent');
              await tx.update(taskItems).set({
                assigneeId: firstUser?.id || null,
                assigneeAgentId: firstAgent?.id || null,
              }).where(eq(taskItems.id, taskId));
            } else if (assigneeId !== undefined || assigneeAgentId !== undefined) {
              // Legacy single-assignee: sync to junction table
              await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
              const rows: { taskId: string; userId?: string; agentPageId?: string }[] = [];
              if (assigneeId) rows.push({ taskId, userId: assigneeId });
              if (assigneeAgentId) rows.push({ taskId, agentPageId: assigneeAgentId });
              if (rows.length > 0) await tx.insert(taskAssignees).values(rows);
            }

            return updatedTask;
          });

          // Update task list status based on task completion
          if (status !== undefined) {
            const doneStatusSlugs = validConfigs.length > 0
              ? new Set(validConfigs.filter(c => c.group === 'done').map(c => c.slug))
              : new Set(['completed']);
            const inProgressSlugs = validConfigs.length > 0
              ? new Set(validConfigs.filter(c => c.group === 'in_progress').map(c => c.slug))
              : new Set(['in_progress']);

            const siblingTasks = await db
              .select()
              .from(taskItems)
              .where(eq(taskItems.taskListId, existingTask.taskListId));

            const allCompleted = siblingTasks.every(t =>
              t.id === taskId ? doneStatusSlugs.has(status) : doneStatusSlugs.has(t.status)
            );

            if (allCompleted) {
              await db.update(taskLists).set({ status: 'completed' }).where(eq(taskLists.id, existingTask.taskListId));
            } else if (inProgressSlugs.has(status)) {
              await db.update(taskLists).set({ status: 'in_progress' }).where(and(
                eq(taskLists.id, existingTask.taskListId),
                eq(taskLists.status, 'pending')
              ));
            }
          }

          // Broadcast update event
          await broadcastTaskEvent({
            type: 'task_updated',
            taskId: resultTask.id,
            userId,
            pageId: taskList.pageId || undefined,
            data: { title: resultTask.title, note },
          });

          message = `Updated task "${resultTask.title}"`;
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

          // Validate assigneeAgentId if provided
          if (assigneeAgentId) {
            const agentPage = await db.query.pages.findFirst({
              where: and(
                eq(pages.id, assigneeAgentId),
                eq(pages.type, 'AI_CHAT'),
                eq(pages.isTrashed, false)
              ),
              columns: { id: true, driveId: true },
            });

            if (!agentPage) {
              throw new Error('Invalid agent ID - must be an AI agent page');
            }

            if (agentPage.driveId !== taskListPage.driveId) {
              throw new Error('Agent must be in the same drive as the task list');
            }
          }

          // Validate custom status if provided
          const resolvedStatus = status || 'pending';
          const statusConfigsForList = await db.query.taskStatusConfigs.findMany({
            where: eq(taskStatusConfigs.taskListId, taskList!.id),
            columns: { slug: true, group: true },
          });
          if (statusConfigsForList.length > 0 && status) {
            const matched = statusConfigsForList.find(c => c.slug === status);
            if (!matched) {
              throw new Error(`Invalid status "${status}". Valid: ${statusConfigsForList.map(c => c.slug).join(', ')}`);
            }
          }

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
            const primaryUserId = assigneeId || (assigneeIds?.find(a => a.type === 'user')?.id) || null;
            const primaryAgentId = assigneeAgentId || (assigneeIds?.find(a => a.type === 'agent')?.id) || null;

            const [newTask] = await tx.insert(taskItems).values({
              taskListId: taskList!.id,
              userId,
              pageId: taskPage.id,
              title: title!,
              description: description || null,
              status: resolvedStatus,
              priority: priority || 'medium',
              assigneeId: primaryUserId,
              assigneeAgentId: primaryAgentId,
              dueDate: dueDate ? new Date(dueDate) : null,
              position: nextTaskPosition,
              metadata: {
                createdAt: new Date().toISOString(),
                note,
              },
            }).returning();

            // Create multiple assignees in junction table
            const assigneeRows: { taskId: string; userId?: string; agentPageId?: string }[] = [];
            if (assigneeIds && assigneeIds.length > 0) {
              for (const a of assigneeIds) {
                if (a.type === 'user') assigneeRows.push({ taskId: newTask.id, userId: a.id });
                else if (a.type === 'agent') assigneeRows.push({ taskId: newTask.id, agentPageId: a.id });
              }
            } else {
              if (primaryUserId) assigneeRows.push({ taskId: newTask.id, userId: primaryUserId });
              if (primaryAgentId) assigneeRows.push({ taskId: newTask.id, agentPageId: primaryAgentId });
            }
            if (assigneeRows.length > 0) {
              await tx.insert(taskAssignees).values(assigneeRows);
            }

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
          const aiContext = await getAiContextWithActor(context as ToolExecutionContext);
          logPageActivity(userId, 'create', {
            id: createdPage.id,
            title: createdPage.title,
            driveId: taskListPage.driveId,
          }, {
            ...aiContext,
            metadata: {
              ...aiContext.metadata,
              taskId: resultTask.id,
              taskTitle: resultTask.title,
            },
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
            assigneeAgent: {
              columns: {
                id: true,
                title: true,
                type: true,
              },
            },
            assignees: {
              with: {
                user: { columns: { id: true, name: true } },
                agentPage: { columns: { id: true, title: true } },
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
            assigneeAgentId: resultTask.assigneeAgentId,
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
            assigneeAgentId: t.assigneeAgentId,
            dueDate: t.dueDate,
            position: t.position,
            completedAt: t.completedAt,
            pageId: t.pageId,
            assignee: t.assignee ? {
              id: t.assignee.id,
              name: t.assignee.name,
              image: t.assignee.image,
            } : null,
            assigneeAgent: t.assigneeAgent ? {
              id: t.assigneeAgent.id,
              title: t.assigneeAgent.title,
              type: t.assigneeAgent.type,
            } : null,
            assignees: t.assignees?.map(a => ({
              userId: a.userId,
              agentPageId: a.agentPageId,
              user: a.user ? { id: a.user.id, name: a.user.name } : null,
              agentPage: a.agentPage ? { id: a.agentPage.id, title: a.agentPage.title } : null,
            })) || [],
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
   * Get tasks assigned to an agent (including the current agent)
   * Allows agents to see their workload and responsibilities
   */
  get_assigned_tasks: tool({
    description: `Get tasks assigned to an AI agent. Use this to see your assigned tasks or tasks assigned to other agents.

By default, returns tasks assigned to YOU (the current agent).
Optionally filter by:
- agentId: See tasks assigned to a specific agent
- status: Filter by task status slug (e.g. pending, in_progress, completed, blocked, or any custom status)
- driveId: Only show tasks from a specific drive

This helps agents understand their responsibilities and coordinate work with other agents.`,
    inputSchema: z.object({
      agentId: z.string().optional().describe('Agent page ID to query (defaults to current agent if in agent context)'),
      status: z.string().optional().describe('Filter by task status slug (e.g. pending, in_progress, completed, blocked)'),
      driveId: z.string().optional().describe('Filter by drive ID'),
      includeCompleted: z.boolean().default(false).describe('Include completed tasks (default: false)'),
    }),
    execute: async (params, { experimental_context: context }) => {
      const { agentId, status, driveId, includeCompleted } = params;
      const userId = (context as ToolExecutionContext)?.userId;
      const toolContext = context as ToolExecutionContext;

      if (!userId) {
        throw new Error('User authentication required');
      }

      // Determine which agent to query
      // If agentId is provided, use that. Otherwise, try to derive from agent chain context
      let targetAgentId = agentId;

      // If we're running in an agent context (has agentChain) and no agentId specified,
      // use the current agent (last in the chain)
      if (!targetAgentId && toolContext.agentChain && toolContext.agentChain.length > 0) {
        targetAgentId = toolContext.agentChain[toolContext.agentChain.length - 1];
      }

      if (!targetAgentId) {
        throw new Error('No agent ID specified. Please provide an agentId parameter to query tasks for a specific agent.');
      }

      // Verify the target agent exists and user has access
      const agent = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, targetAgentId),
          eq(pages.type, 'AI_CHAT'),
          eq(pages.isTrashed, false),
        ),
        columns: { id: true, title: true, driveId: true },
      });

      if (!agent) {
        throw new Error(`Agent with ID ${targetAgentId} not found`);
      }

      const canView = await canUserViewPage(userId, targetAgentId);
      if (!canView) {
        throw new Error('You do not have permission to view this agent\'s tasks');
      }

      try {
        // Build query conditions
        const conditions = [eq(taskItems.assigneeAgentId, targetAgentId)];

        // Status filter
        if (status) {
          conditions.push(eq(taskItems.status, status));
        } else if (!includeCompleted) {
          // Exclude completed by default (use completedAt for custom status support)
          conditions.push(isNull(taskItems.completedAt));
        }

        // Query tasks assigned to the agent
        const tasks = await db.query.taskItems.findMany({
          where: and(...conditions),
          orderBy: [asc(taskItems.position)],
          with: {
            taskList: {
              columns: { id: true, title: true, pageId: true },
              with: {
                page: {
                  columns: { id: true, title: true, driveId: true },
                },
              },
            },
            assignee: {
              columns: { id: true, name: true },
            },
            page: {
              columns: { id: true, title: true, isTrashed: true },
            },
          },
        });

        // Get unique drive IDs from tasks and check permissions
        const taskDriveIds = [...new Set(
          tasks
            .map(t => t.taskList?.page?.driveId)
            .filter((id): id is string => !!id)
        )];

        // Check drive access in parallel for security
        const driveAccessResults = await Promise.all(
          taskDriveIds.map(async (taskDriveId) => ({
            driveId: taskDriveId,
            hasAccess: await getUserDriveAccess(userId, taskDriveId),
          }))
        );

        const accessibleDriveIds = new Set(
          driveAccessResults.filter(r => r.hasAccess).map(r => r.driveId)
        );

        // Filter out tasks with trashed pages, inaccessible drives, and optionally by driveId
        const filteredTasks = tasks.filter(task => {
          if (task.page?.isTrashed) return false;
          const taskDriveId = task.taskList?.page?.driveId;
          // Security: only include tasks from drives the user can access
          if (taskDriveId && !accessibleDriveIds.has(taskDriveId)) return false;
          // Optional driveId filter from params
          if (driveId && taskDriveId !== driveId) return false;
          return true;
        });

        // Build group lookup from status configs across all task lists
        const uniqueTaskListIds = [...new Set(filteredTasks.map(t => t.taskList?.id).filter(Boolean))] as string[];
        const allConfigs = uniqueTaskListIds.length > 0
          ? await db.query.taskStatusConfigs.findMany({
              where: inArray(taskStatusConfigs.taskListId, uniqueTaskListIds),
            })
          : [];
        const slugToGroup = new Map(allConfigs.map(c => [c.slug, c.group]));

        // Group tasks by config group (fall back to completedAt/status heuristic)
        const byGroup: Record<string, typeof filteredTasks> = { todo: [], in_progress: [], done: [] };
        for (const t of filteredTasks) {
          const group = slugToGroup.get(t.status)
            || (t.completedAt ? 'done' : t.status === 'in_progress' || t.status === 'blocked' ? 'in_progress' : 'todo');
          if (!byGroup[group]) byGroup[group] = [];
          byGroup[group].push(t);
        }

        return {
          success: true,
          agent: {
            id: agent.id,
            title: agent.title,
            driveId: agent.driveId,
          },
          summary: {
            total: filteredTasks.length,
            byGroup: {
              todo: byGroup.todo?.length || 0,
              in_progress: byGroup.in_progress?.length || 0,
              done: byGroup.done?.length || 0,
            },
          },
          tasks: filteredTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            dueDate: t.dueDate,
            pageId: t.pageId,
            taskList: t.taskList ? {
              id: t.taskList.id,
              title: t.taskList.title,
              pageId: t.taskList.pageId,
              driveId: t.taskList.page?.driveId,
            } : null,
            // Include user co-assignee if present
            userAssignee: t.assignee ? {
              id: t.assignee.id,
              name: t.assignee.name,
            } : null,
          })),
          message: `Found ${filteredTasks.length} task(s) assigned to agent "${agent.title}"`,
        };
      } catch (error) {
        console.error('Error in get_assigned_tasks:', error);
        throw new Error(`Failed to get assigned tasks: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
