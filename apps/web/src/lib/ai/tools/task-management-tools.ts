import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db'
import { eq, and, desc, isNull, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists, taskItems, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks';
import type { ToolExecutionContext } from '../core/types';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canActorViewPage, canActorAccessDrive } from './actor-permissions';
import { canActorEditPage } from './actor-permissions';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  syncTaskDueDateTrigger,
  cancelTaskDueDateTrigger,
  fireCompletionTrigger,
  createTaskTriggerWorkflow,
} from '@/lib/workflows/task-trigger-helpers';
import { agentTriggerBaseSchema } from '@/lib/workflows/agent-trigger-shared';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import { compareByPagePosition } from '@/services/api/task-ordering';
import { checkSubTasksComplete, toToolFailure } from '@/lib/tasks/completion-guard';
import { decryptTaskUserRelations } from '@/lib/tasks/decrypt-task-relations';
import type { DeferredWorkflowTrigger } from '@pagespace/lib/monitoring/activity-logger';
import {
  normalizeTaskAgentTriggerInput,
  getAiContextWithActor,
  resolveTaskForUpdate,
  syncTaskAssignees,
  createTask,
  deleteTask,
  reorderTaskPeers,
  buildTaskListResponse,
  broadcastTaskUpdated,
} from './task-helpers';

const STATUS_GROUP_DEFAULT_COLORS: Record<string, string> = {
  todo: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  done: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
};

export const taskManagementTools = {
  /**
   * Update fields of an existing task (identified by taskId).
   * Field-only: create/delete/reorder are separate verb tools.
   */
  update_task: tool({
    description: `Update fields of an existing task (identified by taskId). To create a task use create_task; to delete use delete_task; to reorder use reorder_task.

Updatable fields: status, priority, assignees (assigneeId/assigneeAgentId/assigneeIds), dueDate, note, title, agentTrigger.

Status:
- Task lists support custom statuses. Default statuses: pending, in_progress, blocked, completed
- Each status belongs to a group (todo, in_progress, done) that controls completion behavior
- Use a status slug that exists in the task list's configuration (read_page on the TASK_LIST page returns availableStatuses)
- To create a new custom status slug first, call create_task_status before this tool

Completion:
- A task cannot be marked done while it still has incomplete sub-tasks. When this tool returns { success: false, code: "SUBTASKS_INCOMPLETE" }, do not retry — tell the user that {pending} of {total} sub-tasks remain and must be completed first.

Assignment:
- Use assigneeIds array to assign multiple users and/or agents
- Each entry: { type: 'user'|'agent', id: 'string' }
- Or use legacy assigneeId/assigneeAgentId for single assignment
- Agents can assign tasks to themselves or other agents

Agent Triggers:
- Prefer set_task_trigger for attaching triggers to existing tasks (dedicated tool, simpler schema)
- The agentTrigger param here works as a shortcut when updating the task and setting the trigger together
- Provide agentTrigger with agentPageId and either prompt or instructionPageId
- triggerType 'due_date' fires when the due date arrives (requires dueDate)
- triggerType 'completion' fires when the task is marked done`,
    inputSchema: z.object({
      taskId: z.string().optional().describe('ID of the existing task to update. Required — to create a new task use create_task instead.'),
      title: z.string().optional().describe('New task title (renames the existing task)'),
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
      agentTrigger: z.preprocess(
        normalizeTaskAgentTriggerInput,
        agentTriggerBaseSchema.extend({
          triggerType: z.enum(['due_date', 'completion']).default('due_date').describe('When to trigger: at due date or on completion'),
        }).optional()
      ).describe('Schedule an AI agent to run at task due date or on completion. Requires a drive-based task list.'),
    }),
    execute: async (params, { experimental_context: context }) => {
      const { taskId, title, status, priority, assigneeId, assigneeAgentId, assigneeIds, dueDate, note, agentTrigger } = params;
      const userId = (context as ToolExecutionContext)?.userId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      if (!taskId) {
        throw new Error('taskId is required to update a task. To create a new task, use create_task.');
      }

      try {
        // taskId resolves the existing task + its owning list
        const { existingTask, taskList } = await resolveTaskForUpdate(
          context as ToolExecutionContext,
          userId,
          taskId,
        );

        let resultTask: typeof taskItems.$inferSelect = existingTask;
        let resultTitle = '';

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
        // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
        const validConfigs = await db.query.taskStatusConfigs.findMany({
          where: eq(taskStatusConfigs.taskListId, taskList.id),
          columns: { slug: true, group: true },
        });

        // Build update object — title is owned by the linked page, synced separately below.
        const updateData: Partial<typeof taskItems.$inferInsert> = {};
        let trimmedTitle: string | undefined;
        if (title !== undefined) {
          if (typeof title !== 'string' || title.trim().length === 0) {
            throw new Error('Title cannot be empty');
          }
          trimmedTitle = title.trim();
        }
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
        // Completion guard: cannot mark a task done while it has incomplete sub-tasks
        if (updateData.completedAt instanceof Date && existingTask.pageId) {
          const blocked = await checkSubTasksComplete(existingTask.pageId);
          if (blocked) return toToolFailure(blocked);
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

        let updateTitleDeferred: DeferredWorkflowTrigger | undefined;
        let linkedPageDriveId: string | undefined;
        const aiContextForTitle = trimmedTitle !== undefined
          ? await getAiContextWithActor(context as ToolExecutionContext)
          : null;
        try {
          resultTask = await db.transaction(async (tx) => {
            let updatedTask: typeof taskItems.$inferSelect = existingTask;
            if (Object.keys(updateData).length > 0) {
              [updatedTask] = await tx
                .update(taskItems)
                .set(updateData)
                .where(eq(taskItems.id, taskId))
                .returning();
            }

            // Sync title to the linked page (single source of truth).
            if (trimmedTitle !== undefined && aiContextForTitle) {
              const [linkedPage] = await tx
                .select({ revision: pages.revision })
                .from(pages)
                .where(eq(pages.id, existingTask.pageId))
                .limit(1);

              if (linkedPage) {
                const mutationResult = await applyPageMutation({
                  pageId: existingTask.pageId,
                  operation: 'update',
                  updates: { title: trimmedTitle },
                  updatedFields: ['title'],
                  expectedRevision: linkedPage.revision,
                  context: {
                    userId,
                    actorEmail: aiContextForTitle.actorEmail,
                    actorDisplayName: aiContextForTitle.actorDisplayName ?? undefined,
                    isAiGenerated: true,
                    aiProvider: (context as ToolExecutionContext).aiProvider,
                    aiModel: (context as ToolExecutionContext).aiModel,
                    aiConversationId: (context as ToolExecutionContext).conversationId,
                    metadata: {
                      taskId,
                      taskListId: taskList?.id,
                      taskListPageId: taskList?.pageId ?? undefined,
                    },
                  },
                  tx,
                });
                updateTitleDeferred = mutationResult.deferredTrigger;
                linkedPageDriveId = mutationResult.driveId;
              }
            }

            // Replace assignees (array = full replace; legacy single fields otherwise).
            await syncTaskAssignees(tx, taskId, { assigneeIds, assigneeId, assigneeAgentId });

            return updatedTask;
          });
          updateTitleDeferred?.();
          if (trimmedTitle !== undefined && linkedPageDriveId && existingTask.pageId) {
            void broadcastPageEvent(
              createPageEventPayload(linkedPageDriveId, existingTask.pageId, 'updated', {
                title: trimmedTitle,
              }),
            );
          }
        } catch (error) {
          if (error instanceof PageRevisionMismatchError) {
            throw new Error(`Linked page was modified concurrently — retry the update: ${error.message}`);
          }
          throw error;
        }

        // Update task list status based on task completion
        if (status !== undefined) {
          const doneStatusSlugs = validConfigs.length > 0
            ? new Set(validConfigs.filter(c => c.group === 'done').map(c => c.slug))
            : new Set(['completed']);
          const inProgressSlugs = validConfigs.length > 0
            ? new Set(validConfigs.filter(c => c.group === 'in_progress').map(c => c.slug))
            : new Set(['in_progress']);

          const siblingTasks = await db
            .select({ id: taskItems.id, status: taskItems.status })
            .from(taskItems)
            .innerJoin(pages, eq(pages.id, taskItems.pageId))
            .where(and(
              eq(pages.parentId, taskList.pageId!),
              eq(pages.type, 'TASK_LIST'),
              eq(pages.isTrashed, false),
            ));

          const allCompleted = siblingTasks.every(t =>
            t.id === taskId ? doneStatusSlugs.has(status) : doneStatusSlugs.has(t.status)
          );

          if (allCompleted) {
            await db.update(taskLists).set({ status: 'completed' }).where(eq(taskLists.id, taskList.id));
          } else if (inProgressSlugs.has(status)) {
            await db.update(taskLists).set({ status: 'in_progress' }).where(and(
              eq(taskLists.id, taskList.id),
              eq(taskLists.status, 'pending')
            ));
          }
        }

        // Create agent trigger workflow BEFORE firing cascades so the workflow
        // exists when fireCompletionTrigger looks for it
        if (agentTrigger) {
          if (!taskListDriveId) {
            return { success: false, error: 'Agent triggers require a drive-based task list' };
          }
          await createTaskTriggerWorkflow({
            database: db,
            driveId: taskListDriveId,
            userId,
            taskId,
            taskMetadata: resultTask.metadata as Record<string, unknown> | null,
            agentTrigger,
            dueDate: resultTask.dueDate,
            timezone: (context as ToolExecutionContext).timezone || 'UTC',
          });
        }

        // Task trigger cascades
        if (dueDate !== undefined) {
          void syncTaskDueDateTrigger(taskId, dueDate ? new Date(dueDate) : null);
        }
        if (status !== undefined) {
          const completedSlugs = validConfigs.length > 0
            ? new Set(validConfigs.filter(c => c.group === 'done').map(c => c.slug))
            : new Set(['completed']);
          if (completedSlugs.has(status) && !existingTask.completedAt) {
            void cancelTaskDueDateTrigger(taskId, 'Task completed before due date');
            void fireCompletionTrigger(taskId);
          }
        }

        resultTitle = trimmedTitle ?? existingTask.page?.title ?? '';

        // Broadcast update event (shared with reorder_task for a consistent payload)
        await broadcastTaskUpdated({
          taskId: resultTask.id,
          userId,
          taskListPageId: taskList.pageId,
          title: resultTitle,
          note,
        });

        return await buildTaskListResponse({
          action: 'updated',
          parentPageId: taskList.pageId!,
          taskListId: taskList.id,
          // Sourced from the linked page — the single ordering rail (#2143).
          resultTask: { ...resultTask, position: existingTask.page?.position ?? 0 },
          resultTitle,
          message: `Updated task "${resultTitle}"`,
        });
      } catch (error) {
        console.error('Error in update_task:', error);
        throw new Error(`Failed to update task: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Create a task on a TASK_LIST page.
   * Explicit create verb — no update/delete/reorder inference.
   */
  create_task: tool({
    description: `Create a new task on a TASK_LIST page.

A linked TASK_LIST page is automatically created as a child to hold the task description and any sub-tasks; its title stays synced with the task title. DO NOT delete that page directly — use delete_task instead.

Status:
- Task lists support custom statuses. Default statuses: pending, in_progress, blocked, completed
- Use a status slug that exists in the task list's configuration (read_page on the TASK_LIST page returns availableStatuses); create new slugs with create_task_status first.

Assignment:
- Use assigneeIds array to assign multiple users and/or agents — each entry: { type: 'user'|'agent', id: 'string' }
- Or use legacy assigneeId/assigneeAgentId for single assignment.

Agent Triggers:
- Provide agentTrigger with agentPageId and either prompt or instructionPageId to schedule an AI agent at the due date (triggerType 'due_date', requires dueDate) or on completion (triggerType 'completion'). Requires a drive-based task list.`,
    inputSchema: z.object({
      pageId: z.string().describe('TASK_LIST page ID to add the task to'),
      title: z.string().describe('Task title'),
      status: z.string().optional().describe('Task status slug (e.g. pending, in_progress, completed, blocked, or any custom status). Defaults to pending.'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Task priority (defaults to medium)'),
      assigneeId: z.string().nullable().optional().describe('User ID to assign. Legacy single-assignee field.'),
      assigneeAgentId: z.string().nullable().optional().describe('Agent page ID to assign. Legacy single-assignee field.'),
      assigneeIds: z.array(z.object({
        type: z.enum(['user', 'agent']),
        id: z.string(),
      })).optional().describe('Multiple assignees. Each: { type: "user"|"agent", id: "..." }'),
      dueDate: z.string().nullable().optional().describe('Due date in ISO format'),
      note: z.string().optional().describe('Note stored in task metadata'),
      position: z.number().optional().describe('Position in the list (defaults to end)'),
      agentTrigger: z.preprocess(
        normalizeTaskAgentTriggerInput,
        agentTriggerBaseSchema.extend({
          triggerType: z.enum(['due_date', 'completion']).default('due_date').describe('When to trigger: at due date or on completion'),
        }).optional()
      ).describe('Schedule an AI agent to run at task due date or on completion. Requires a drive-based task list.'),
    }),
    execute: async (params, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        return await createTask(ctx, userId, params);
      } catch (error) {
        console.error('Error in create_task:', error);
        throw new Error(`Failed to create task: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Delete a task and trash its linked TASK_LIST page.
   * Explicit delete verb — hard-removes the task.
   */
  delete_task: tool({
    description: `Hard-delete a task and trash its linked TASK_LIST page.

This permanently removes the task row and moves its linked page to the trash. Returns the refreshed task list so clients can drop the deleted task immediately.`,
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task to delete'),
    }),
    execute: async ({ taskId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        const { existingTask, taskList } = await resolveTaskForUpdate(ctx, userId, taskId);
        return await deleteTask(ctx, userId, existingTask, taskList, 'Task deleted via delete_task');
      } catch (error) {
        console.error('Error in delete_task:', error);
        throw new Error(`Failed to delete task: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Move a task to a new position and re-densify peer positions.
   * Explicit reorder verb.
   */
  reorder_task: tool({
    description: `Move a task to a new index in its list and re-densify peer positions to 0..n-1.

The position is clamped to the valid range. Returns the refreshed task list reflecting the new ordering.`,
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task to move'),
      position: z.number().describe('Target index in the list (0-based; clamped to the list length)'),
    }),
    execute: async ({ taskId, position }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;

      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        const { existingTask, taskList } = await resolveTaskForUpdate(ctx, userId, taskId);
        const clamped = await reorderTaskPeers(taskList.pageId!, taskId, position, {
          userId,
          isAiGenerated: true,
          aiProvider: ctx.aiProvider,
          aiModel: ctx.aiModel,
          aiConversationId: ctx.conversationId,
        });
        const resultTitle = existingTask.page?.title ?? '';
        // Broadcast so collaborators/other clients see the reorder, matching update_task.
        await broadcastTaskUpdated({
          taskId,
          userId,
          taskListPageId: taskList.pageId,
          title: resultTitle,
        });
        return await buildTaskListResponse({
          action: 'updated',
          parentPageId: taskList.pageId!,
          taskListId: taskList.id,
          resultTask: { ...existingTask, position: clamped.position },
          resultTitle,
          message: `Reordered task "${resultTitle}" to position ${clamped.index}`,
        });
      } catch (error) {
        console.error('Error in reorder_task:', error);
        throw new Error(`Failed to reorder task: ${error instanceof Error ? error.message : String(error)}`);
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

      if (!await canActorViewPage(context as ToolExecutionContext, targetAgentId)) {
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

        // Query tasks assigned to the agent (task list membership derived from pages.parentId)
        // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
        const unorderedTasks = await db.query.taskItems.findMany({
          where: and(...conditions),
          with: {
            assignee: {
              columns: { id: true, name: true },
            },
            page: {
              columns: { id: true, title: true, isTrashed: true, parentId: true, position: true },
            },
          },
        });
        // Ordered in JS: the ordering rail is pages.position on the joined page, and a
        // relational findMany cannot order by a joined table's column (#2143).
        const tasks = unorderedTasks.sort((a, b) => compareByPagePosition(a, b));

        // Collect unique task list page IDs from task parents
        const taskListPageIds = [...new Set(
          tasks.map(t => t.page?.parentId).filter((id): id is string => !!id)
        )];

        // Fetch page info (driveId) and task list records for those parent pages
        const [taskListPagesInfo, taskListsInfo] = await Promise.all([
          taskListPageIds.length > 0
            // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
            ? db.query.pages.findMany({
                where: inArray(pages.id, taskListPageIds),
                columns: { id: true, driveId: true },
              })
            : Promise.resolve([]),
          taskListPageIds.length > 0
            // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
            ? db.query.taskLists.findMany({
                where: inArray(taskLists.pageId, taskListPageIds),
                columns: { id: true, pageId: true, title: true },
              })
            : Promise.resolve([]),
        ]);

        const taskListPageInfoMap = new Map(taskListPagesInfo.map(p => [p.id, p]));
        const taskListByPageId = new Map(taskListsInfo.map(tl => [tl.pageId, tl]));

        // Get unique drive IDs from tasks and check permissions
        const taskDriveIds = [...new Set(
          taskListPageIds
            .map(id => taskListPageInfoMap.get(id)?.driveId)
            .filter((id): id is string => !!id)
        )];

        // Check drive access in parallel for security
        const driveAccessResults = await Promise.all(
          taskDriveIds.map(async (taskDriveId) => ({
            driveId: taskDriveId,
            hasAccess: await canActorAccessDrive(context as ToolExecutionContext, taskDriveId),
          }))
        );

        const accessibleDriveIds = new Set(
          driveAccessResults.filter(r => r.hasAccess).map(r => r.driveId)
        );

        // Filter out tasks with trashed pages, inaccessible drives, and optionally by driveId
        const matchingTasks = tasks.filter(task => {
          if (task.page?.isTrashed) return false;
          const parentId = task.page?.parentId;
          const taskDriveId = parentId ? taskListPageInfoMap.get(parentId)?.driveId : undefined;
          // Security: only include tasks from drives the user can access
          if (taskDriveId && !accessibleDriveIds.has(taskDriveId)) return false;
          // Optional driveId filter from params
          if (driveId && taskDriveId !== driveId) return false;
          return true;
        });

        // Decrypt after filtering — none of the filters read PII, so skip crypto work for dropped rows
        const filteredTasks = await decryptTaskUserRelations(matchingTasks);

        // Build group lookup from status configs across all task lists
        const uniqueTaskListIds = taskListsInfo.map(tl => tl.id);
        const allConfigs = uniqueTaskListIds.length > 0
          // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
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
            title: t.page?.title ?? '',
            status: t.status,
            priority: t.priority,
            dueDate: t.dueDate,
            pageId: t.pageId,
            taskList: (() => {
              const parentId = t.page?.parentId;
              const tl = parentId ? taskListByPageId.get(parentId) : undefined;
              const tlPage = parentId ? taskListPageInfoMap.get(parentId) : undefined;
              return tl ? {
                id: tl.id,
                title: tl.title,
                pageId: tl.pageId,
                driveId: tlPage?.driveId,
              } : null;
            })(),
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

  create_task_status: tool({
    description: `Create a custom status configuration on a TASK_LIST page.
Use this before setting a task to a status slug that doesn't exist yet.

Each status belongs to a semantic group that controls task completion behavior:
- 'todo'        — not yet started
- 'in_progress' — actively being worked on
- 'done'        — finished (marks tasks as completed)

The slug is auto-generated from the name (e.g. "In Review" → "in_review").
Returns the created status config including its slug to use in update_task.`,

    inputSchema: z.object({
      pageId: z.string().describe('TASK_LIST page ID'),
      name: z.string().describe('Status display name (e.g. "In Review")'),
      group: z.enum(['todo', 'in_progress', 'done']).describe('Semantic group'),
      color: z.string().optional().describe('Tailwind color classes. Auto-assigned from group if omitted.'),
      position: z.number().optional().describe('Display order. Appended to end if omitted.'),
    }),

    execute: async ({ pageId, name, group, color, position }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx.userId;

      const page = await db.query.pages.findFirst({
        where: and(eq(pages.id, pageId), eq(pages.isTrashed, false)),
        columns: { id: true, type: true, title: true },
      });
      if (!page) {
        return { error: `Page ${pageId} not found or is trashed.` };
      }
      if (page.type !== PageType.TASK_LIST) {
        return { error: `Page ${pageId} is not a TASK_LIST page (it is ${page.type}).` };
      }

      const canEdit = await canActorEditPage(ctx, pageId);
      if (!canEdit) {
        return { error: 'You need edit permission to manage statuses on this task list.' };
      }

      const slug = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      if (!slug) {
        return { error: 'Name must contain alphanumeric characters.' };
      }

      let taskList = await db.query.taskLists.findFirst({
        where: eq(taskLists.pageId, pageId),
      });

      if (!taskList) {
        taskList = await db.transaction(async (tx) => {
          const [created] = await tx.insert(taskLists).values({
            userId,
            pageId,
            title: page.title,
            status: 'pending',
          }).returning();
          await tx.insert(taskStatusConfigs).values(
            DEFAULT_TASK_STATUSES.map(s => ({ taskListId: created.id, ...s }))
          );
          return created;
        });
      }

      const existing = await db.query.taskStatusConfigs.findFirst({
        where: and(eq(taskStatusConfigs.taskListId, taskList.id), eq(taskStatusConfigs.slug, slug)),
      });

      if (existing) {
        return { error: `A status with slug "${slug}" already exists on this task list.` };
      }

      let newPosition = position;
      if (newPosition === undefined) {
        const last = await db.query.taskStatusConfigs.findFirst({
          where: eq(taskStatusConfigs.taskListId, taskList.id),
          orderBy: [desc(taskStatusConfigs.position)],
        });
        newPosition = (last?.position ?? -1) + 1;
      }

      let newConfig;
      try {
        [newConfig] = await db.insert(taskStatusConfigs).values({
          taskListId: taskList.id,
          name: name.trim(),
          slug,
          color: color ?? STATUS_GROUP_DEFAULT_COLORS[group],
          group,
          position: newPosition,
        }).returning();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique') || msg.includes('duplicate')) {
          return { error: `A status with slug "${slug}" already exists on this task list.` };
        }
        throw err;
      }

      await broadcastTaskEvent({
        type: 'task_updated',
        taskListId: taskList.id,
        userId,
        pageId,
        data: { statusConfigAdded: newConfig },
      });

      return {
        id: newConfig.id,
        slug: newConfig.slug,
        name: newConfig.name,
        group: newConfig.group,
        color: newConfig.color,
        position: newConfig.position,
        message: `Created status "${newConfig.name}" (slug: "${newConfig.slug}") on task list.`,
      };
    },
  }),
};
