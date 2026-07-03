/**
 * Tasks & statuses operations (Phase 3 task 4).
 *
 * Route-verified against `apps/web/src/app/api/pages/[pageId]/tasks/route.ts`,
 * `.../tasks/[taskId]/route.ts`, `.../tasks/statuses/route.ts`,
 * `apps/web/src/app/api/tasks/route.ts`, `apps/web/src/app/api/tasks/[taskId]/triggers/route.ts`
 * and `.../triggers/[triggerType]/route.ts` (docs/sdk/operations-inventory.md
 * §2.7 + §2.13, parity with MCP tools `create_task`, `update_task`,
 * `delete_task`, `reorder_task`, `create_task_status`, `set_task_trigger`,
 * `delete_task_trigger`, `get_assigned_tasks`). `reorder_task` targets the
 * same PATCH route as `update_task` with a position-only body — the MCP
 * layer deliberately splits them, so the registry does too (`tasks.update`
 * rejects `position`; only `tasks.reorder` accepts it).
 *
 * D2 fix: `delete_task_trigger`'s route was session-only prior to
 * #1764/66/67/70; it now accepts `['session','mcp']`, so this op declares
 * `requiredScope: 'drive'` like every other op here, not `sessionOnly`.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';
import { HttpError, isHttpError } from '../errors.js';

const priorityEnum = z.enum(['low', 'medium', 'high']);
const statusGroupEnum = z.enum(['todo', 'in_progress', 'done']);
const triggerTypeEnum = z.enum(['due_date', 'completion']);

const userRefSchema = z
  .object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() })
  .nullable();

const agentRefSchema = z
  .object({ id: z.string(), title: z.string().nullable(), type: z.string() })
  .nullable();

const assigneeEntrySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  userId: z.string().nullable(),
  agentPageId: z.string().nullable(),
  createdAt: z.string(),
  user: userRefSchema,
  agentPage: agentRefSchema,
});

/** `taskItems` row shape shared by create/update/reorder/get_assigned responses. */
const taskItemBaseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  assigneeId: z.string().nullable(),
  assigneeAgentId: z.string().nullable(),
  pageId: z.string(),
  status: z.string().describe('A status slug from the task list. Valid slugs come from read_page on the TASK_LIST page (availableStatuses), or tasks.createStatus output.'),
  priority: priorityEnum,
  position: z.number(),
  dueDate: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `{ ...taskWithRelations, title }` shape returned by create_task/update_task/reorder_task. */
const taskWithRelationsSchema = taskItemBaseSchema.extend({
  assignee: userRefSchema,
  assigneeAgent: agentRefSchema,
  user: userRefSchema,
  page: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  assignees: z.array(assigneeEntrySchema),
  title: z.string(),
});

const assigneeEntryInputSchema = z.object({ type: z.enum(['user', 'agent']), id: z.string() });

/**
 * `agentTrigger` on create_task/update_task. Route truth (`tasks/route.ts:389`,
 * `tasks/[taskId]/route.ts:208`) requires prompt OR instructionPageId — not a
 * strict XOR; the route never rejects both being present together.
 */
const agentTriggerInputSchema = z
  .object({
    agentPageId: z.string().min(1),
    triggerType: triggerTypeEnum.optional().describe('Defaults to "due_date" server-side when omitted.'),
    prompt: z.string().max(10000).optional(),
    instructionPageId: z.string().optional(),
    contextPageIds: z.array(z.string()).max(10).optional(),
  })
  .refine((v) => Boolean(v.prompt) || Boolean(v.instructionPageId), {
    message: 'agentTrigger needs either a prompt or an instructionPageId',
    path: ['prompt'],
  });

export const createTask = defineOperation({
  name: 'tasks.create',
  method: 'POST',
  path: '/api/pages/:pageId/tasks',
  inputSchema: z
    .object({
      pageId: z.string(),
      title: z.string().min(1),
      status: z.string().optional().describe('Status slug. Valid slugs come from read_page on the TASK_LIST page (availableStatuses).'),
      priority: priorityEnum.optional(),
      assigneeId: z.string().optional(),
      assigneeAgentId: z.string().optional(),
      assigneeIds: z.array(assigneeEntryInputSchema).optional(),
      dueDate: z.string().optional(),
      note: z.string().optional(),
      position: z.number().optional(),
      timezone: z.string().optional(),
      agentTrigger: agentTriggerInputSchema.optional(),
    })
    .refine(
      (v) => {
        if (!v.agentTrigger) return true;
        const triggerType = v.agentTrigger.triggerType ?? 'due_date';
        return triggerType !== 'due_date' || Boolean(v.dueDate);
      },
      { message: 'A due_date agentTrigger requires dueDate to be set on the task', path: ['dueDate'] },
    ),
  outputSchema: taskWithRelationsSchema,
  requiredScope: 'drive',
  description: 'Create a task on a TASK_LIST page. Status slugs come from that list\'s availableStatuses (see read_page).',
});

export const updateTask = defineOperation({
  name: 'tasks.update',
  method: 'PATCH',
  path: '/api/pages/:pageId/tasks/:taskId',
  inputSchema: z
    .object({
      pageId: z.string(),
      taskId: z.string(),
      title: z.string().min(1).optional(),
      status: z.string().optional().describe('Status slug. Valid slugs come from read_page on the TASK_LIST page (availableStatuses).'),
      priority: priorityEnum.optional(),
      assigneeId: z.string().optional(),
      assigneeAgentId: z.string().optional(),
      assigneeIds: z.array(assigneeEntryInputSchema).optional(),
      dueDate: z.string().nullable().optional(),
      note: z.string().optional(),
      timezone: z.string().optional(),
      agentTrigger: agentTriggerInputSchema.optional(),
    })
    .strict() // position belongs to tasks.reorder, not tasks.update
    .refine(
      (v) => {
        if (!v.agentTrigger) return true;
        const triggerType = v.agentTrigger.triggerType ?? 'due_date';
        if (triggerType !== 'due_date') return true;
        // Only refine when dueDate is explicit and falsy in THIS call — when
        // omitted, the server falls back to the task's existing dueDate,
        // which the client cannot see; failing closed there would reject
        // valid updates.
        if (v.dueDate === undefined) return true;
        return Boolean(v.dueDate);
      },
      {
        message: 'A due_date agentTrigger requires dueDate — either set in this update or already present on the task',
        path: ['dueDate'],
      },
    ),
  outputSchema: taskWithRelationsSchema,
  requiredScope: 'drive',
  description:
    'Update a task\'s fields. Position is owned by tasks.reorder, not this operation. On a 422 response, use classifyTaskCompletionGate to detect the "sub-tasks incomplete" gate.',
});

export const reorderTask = defineOperation({
  name: 'tasks.reorder',
  method: 'PATCH',
  path: '/api/pages/:pageId/tasks/:taskId',
  inputSchema: z.object({
    pageId: z.string(),
    taskId: z.string(),
    position: z.number(),
  }),
  outputSchema: taskWithRelationsSchema,
  requiredScope: 'drive',
  description: 'Move a task to a new position within its task list (same route as tasks.update, position-only body).',
});

export const deleteTask = defineOperation({
  name: 'tasks.delete',
  method: 'DELETE',
  path: '/api/pages/:pageId/tasks/:taskId',
  inputSchema: z.object({ pageId: z.string(), taskId: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  requiredScope: 'drive',
  description: 'Delete a task by trashing its linked TASK_LIST child page.',
});

const taskStatusConfigSchema = z.object({
  id: z.string(),
  taskListId: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string(),
  group: statusGroupEnum,
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createTaskStatus = defineOperation({
  name: 'tasks.createStatus',
  method: 'POST',
  path: '/api/pages/:pageId/tasks/statuses',
  inputSchema: z.object({
    pageId: z.string(),
    name: z.string().min(1),
    color: z.string().min(1),
    group: statusGroupEnum,
    position: z.number().optional(),
  }),
  outputSchema: taskStatusConfigSchema,
  requiredScope: 'drive',
  description: 'Create a custom status on a task list. The returned slug becomes a valid value for tasks.create/tasks.update\'s status field.',
});

const taskTriggerSchema = z.object({
  id: z.string(),
  taskItemId: z.string(),
  triggerType: triggerTypeEnum,
  nextRunAt: z.string().nullable(),
  lastFiredAt: z.string().nullable(),
  lastFireError: z.string().nullable(),
  isEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  workflowId: z.string(),
  agentPageId: z.string(),
  prompt: z.string(),
  instructionPageId: z.string().nullable(),
  contextPageIds: z.array(z.string()).nullable(),
});

export const setTaskTrigger = defineOperation({
  name: 'tasks.setTrigger',
  method: 'PUT',
  path: '/api/tasks/:taskId/triggers',
  inputSchema: z
    .object({
      taskId: z.string(),
      triggerType: triggerTypeEnum,
      agentPageId: z.string().min(1),
      prompt: z.string().max(10000).optional(),
      instructionPageId: z.string().nullable().optional(),
      contextPageIds: z.array(z.string()).max(10).optional(),
      timezone: z.string().optional(),
    })
    .refine((v) => Boolean(v.prompt?.trim()) || Boolean(v.instructionPageId), {
      message: 'Either prompt or instructionPageId is required',
      path: ['prompt'],
    }),
  outputSchema: z.object({ trigger: taskTriggerSchema }),
  requiredScope: 'drive',
  description: 'Set (upsert) an agent trigger for a task — fires on the due date or on completion.',
});

export const deleteTaskTrigger = defineOperation({
  name: 'tasks.deleteTrigger',
  method: 'DELETE',
  path: '/api/tasks/:taskId/triggers/:triggerType',
  inputSchema: z.object({ taskId: z.string(), triggerType: triggerTypeEnum }),
  outputSchema: z.object({ success: z.boolean() }),
  requiredScope: 'drive',
  description: 'Remove one trigger (due_date or completion) from a task.',
});

const assignedTaskSchema = taskItemBaseSchema.extend({
  assignee: userRefSchema,
  assigneeAgent: agentRefSchema,
  assignees: z.array(assigneeEntrySchema),
  user: userRefSchema,
  page: z.object({ id: z.string(), title: z.string().nullable(), isTrashed: z.boolean(), parentId: z.string().nullable() }).nullable(),
  title: z.string(),
  driveId: z.string(),
  taskListPageId: z.string(),
  taskListPageTitle: z.string().nullable(),
  statusGroup: statusGroupEnum,
  statusLabel: z.string(),
  statusColor: z.string(),
});

export const getAssignedTasks = defineOperation({
  name: 'tasks.getAssigned',
  method: 'GET',
  path: '/api/tasks',
  inputSchema: z
    .object({
      context: z.enum(['user', 'drive']).optional(),
      driveId: z.string().optional(),
      status: z.string().optional(),
      priority: priorityEnum.optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      search: z.string().optional(),
      assigneeId: z.string().optional(),
      assigneeAgentId: z.string().optional(),
      showAllAssignees: z.boolean().optional(),
      includeCompleted: z.boolean().optional(),
      dueDateFilter: z.enum(['overdue', 'today', 'this_week', 'upcoming']).optional(),
      statusGroup: z.enum(['all', 'active', 'completed']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .refine((v) => v.context !== 'drive' || Boolean(v.driveId), {
      message: 'driveId is required for drive context',
      path: ['driveId'],
    }),
  outputSchema: z.object({
    tasks: z.array(assignedTaskSchema),
    statusConfigsByTaskList: z.record(
      z.string(),
      z.array(
        z.object({
          id: z.string(),
          taskListId: z.string(),
          name: z.string(),
          slug: z.string(),
          color: z.string(),
          group: statusGroupEnum,
          position: z.number(),
        }),
      ),
    ),
    pagination: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      hasMore: z.boolean(),
    }),
  }),
  description: 'List tasks assigned to the caller (or filtered) across one drive or every accessible drive.',
});

export interface TaskCompletionGatedError {
  readonly pending: number;
  readonly total: number;
}

const SUBTASKS_INCOMPLETE_PATTERN = /\((\d+) of (\d+) remaining\)/;

/**
 * Detects the tasks.update "complete sub-tasks first" gate (422,
 * `SUBTASKS_INCOMPLETE` — `packages/lib` completion-guard.ts) on an
 * already-classified error, recovering the pending/total counts embedded
 * in its message. Message-based, not body-based: `classifyHttpError`
 * (Phase 2) never retains the raw response body on `HttpError` (zero
 * trust — no oracle for server-echoed fields), so the counts baked into
 * the human-readable message are the only surviving structured data.
 */
export function classifyTaskCompletionGate(error: unknown): TaskCompletionGatedError | null {
  if (!isHttpError(error)) return null;
  if ((error as HttpError).status !== 422) return null;
  const match = SUBTASKS_INCOMPLETE_PATTERN.exec(error.message);
  if (!match) return null;
  return { pending: Number(match[1]), total: Number(match[2]) };
}
