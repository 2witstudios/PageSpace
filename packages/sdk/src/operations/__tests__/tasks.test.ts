import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { HttpError, ResponseValidationError } from '../../errors.js';
import {
  classifyTaskCompletionGate,
  createTask,
  createTaskStatus,
  deleteTask,
  deleteTaskTrigger,
  getAssignedTasks,
  reorderTask,
  setTaskTrigger,
  updateTask,
} from '../tasks.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/pages/[pageId]/tasks/route.ts POST (§2.7 create_task). */
const taskFixture = {
  id: 't1abc',
  userId: 'u1abc',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: 'p1task',
  status: 'pending',
  priority: 'medium',
  position: 1,
  dueDate: null,
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', note: null },
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assignee: null,
  assigneeAgent: null,
  user: { id: 'u1abc', name: 'Ada', image: null },
  page: { id: 'p1task', title: 'Write the spec' },
  assignees: [],
  title: 'Write the spec',
};

describe('tasks.create — request shape', () => {
  it('interpolates :pageId and sends the rest as a JSON body', () => {
    const request = buildRequest(createTask, { pageId: 'pg1', title: 'Write the spec' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/pages/pg1/tasks');
    expect(request.body).toBe(JSON.stringify({ title: 'Write the spec' }));
  });

  it('serializes a nested agentTrigger object without dropping its fields', () => {
    const request = buildRequest(
      createTask,
      {
        pageId: 'pg1',
        title: 'Ship it',
        dueDate: '2026-02-01T00:00:00.000Z',
        agentTrigger: { agentPageId: 'ag1', prompt: 'Ship it' },
      },
      config,
    );
    const body = JSON.parse(request.body!);
    expect(body.agentTrigger).toEqual({ agentPageId: 'ag1', prompt: 'Ship it' });
  });
});

describe('tasks.create — input refinements', () => {
  it('accepts a minimal valid task', () => {
    expect(createTask.inputSchema.safeParse({ pageId: 'pg1', title: 'Write the spec' }).success).toBe(true);
  });

  it('rejects a missing title', () => {
    expect(createTask.inputSchema.safeParse({ pageId: 'pg1' }).success).toBe(false);
  });

  it('rejects an agentTrigger with neither prompt nor instructionPageId', () => {
    const result = createTask.inputSchema.safeParse({
      pageId: 'pg1',
      title: 'Ship it',
      dueDate: '2026-02-01T00:00:00.000Z',
      agentTrigger: { agentPageId: 'ag1' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an agentTrigger with only instructionPageId', () => {
    const result = createTask.inputSchema.safeParse({
      pageId: 'pg1',
      title: 'Ship it',
      dueDate: '2026-02-01T00:00:00.000Z',
      agentTrigger: { agentPageId: 'ag1', instructionPageId: 'instr1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a due_date agentTrigger (the default triggerType) with no dueDate on the task', () => {
    const result = createTask.inputSchema.safeParse({
      pageId: 'pg1',
      title: 'Ship it',
      agentTrigger: { agentPageId: 'ag1', prompt: 'Ship it' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a completion agentTrigger with no dueDate', () => {
    const result = createTask.inputSchema.safeParse({
      pageId: 'pg1',
      title: 'Ship it',
      agentTrigger: { agentPageId: 'ag1', prompt: 'Ship it', triggerType: 'completion' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects contextPageIds beyond the 10-item cap', () => {
    const result = createTask.inputSchema.safeParse({
      pageId: 'pg1',
      title: 'Ship it',
      dueDate: '2026-02-01T00:00:00.000Z',
      agentTrigger: {
        agentPageId: 'ag1',
        prompt: 'Ship it',
        contextPageIds: Array.from({ length: 11 }, (_, i) => `p${i}`),
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('tasks.create — response contract', () => {
  it('parses the created task (route truth, §2.7 create_task)', () => {
    const result = parseResponse(createTask, 200, new Headers(), JSON.stringify(taskFixture));
    expect(result).toEqual(taskFixture);
  });

  it('parses a task with multiple assignees', () => {
    const withAssignees = {
      ...taskFixture,
      assignees: [
        {
          id: 'ta1',
          taskId: 't1abc',
          userId: 'u2abc',
          agentPageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          user: { id: 'u2abc', name: 'Bo', image: null },
          agentPage: null,
        },
      ],
    };
    const result = parseResponse(createTask, 200, new Headers(), JSON.stringify(withAssignees));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('rejects a response missing a required field', () => {
    const malformed = { ...taskFixture } as Record<string, unknown>;
    delete malformed.pageId;
    const result = parseResponse(createTask, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies an invalid-status 400 as ValidationError, not a schema mismatch', () => {
    const result = parseResponse(createTask, 400, new Headers(), JSON.stringify({ error: 'Invalid status "bogus". Valid statuses: pending, completed' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('tasks.update — request shape', () => {
  it('interpolates :pageId and :taskId and omits position from its input', () => {
    const request = buildRequest(updateTask, { pageId: 'pg1', taskId: 't1', title: 'New title' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/pages/pg1/tasks/t1');
    expect(request.body).toBe(JSON.stringify({ title: 'New title' }));
  });

  it('rejects a position field (reorder_task owns position, not update_task)', () => {
    const result = updateTask.inputSchema.safeParse({ pageId: 'pg1', taskId: 't1', position: 2 });
    expect(result.success).toBe(false);
  });
});

describe('tasks.update — input refinements', () => {
  it('rejects an explicit-null dueDate paired with a due_date agentTrigger in the same call', () => {
    const result = updateTask.inputSchema.safeParse({
      pageId: 'pg1',
      taskId: 't1',
      dueDate: null,
      agentTrigger: { agentPageId: 'ag1', prompt: 'Ship it' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a due_date agentTrigger when dueDate is omitted (server falls back to the existing task due date)', () => {
    const result = updateTask.inputSchema.safeParse({
      pageId: 'pg1',
      taskId: 't1',
      agentTrigger: { agentPageId: 'ag1', prompt: 'Ship it' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a due_date agentTrigger when dueDate is set in this same call', () => {
    const result = updateTask.inputSchema.safeParse({
      pageId: 'pg1',
      taskId: 't1',
      dueDate: '2026-02-01T00:00:00.000Z',
      agentTrigger: { agentPageId: 'ag1', prompt: 'Ship it' },
    });
    expect(result.success).toBe(true);
  });
});

describe('tasks.update — response contract', () => {
  it('parses the updated task', () => {
    const result = parseResponse(updateTask, 200, new Headers(), JSON.stringify(taskFixture));
    expect(result).toEqual(taskFixture);
  });

  it('classifies the 422 sub-tasks-incomplete gate as an HttpError carrying status 422', () => {
    const result = parseResponse(
      updateTask,
      422,
      new Headers(),
      JSON.stringify({ code: 'SUBTASKS_INCOMPLETE', error: 'Complete all sub-tasks first (2 of 5 remaining)', pending: 2, total: 5 }),
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).status).toBe(422);
  });
});

describe('tasks.reorder — request shape', () => {
  it('PATCHes the same task route with only { position }', () => {
    const request = buildRequest(reorderTask, { pageId: 'pg1', taskId: 't1', position: 3 }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/pages/pg1/tasks/t1');
    expect(request.body).toBe(JSON.stringify({ position: 3 }));
  });
});

describe('tasks.reorder — response contract', () => {
  it('parses the updated task row', () => {
    const result = parseResponse(reorderTask, 200, new Headers(), JSON.stringify(taskFixture));
    expect(result).toEqual(taskFixture);
  });
});

describe('tasks.delete — request shape and response', () => {
  it('DELETEs the task route with no body', () => {
    const request = buildRequest(deleteTask, { pageId: 'pg1', taskId: 't1' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/pages/pg1/tasks/t1');
    expect(request.body).toBeUndefined();
  });

  it('parses { success: true }', () => {
    const result = parseResponse(deleteTask, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });
});

describe('tasks.createStatus — request shape, refinements, response', () => {
  it('interpolates :pageId and sends name/color/group/position as body', () => {
    const request = buildRequest(
      createTaskStatus,
      { pageId: 'pg1', name: 'Review', color: 'bg-blue-100', group: 'in_progress' },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/pages/pg1/tasks/statuses');
    expect(request.body).toBe(JSON.stringify({ color: 'bg-blue-100', group: 'in_progress', name: 'Review' }));
  });

  it('rejects a group outside todo/in_progress/done', () => {
    const result = createTaskStatus.inputSchema.safeParse({
      pageId: 'pg1',
      name: 'Review',
      color: 'bg-blue-100',
      group: 'archived',
    });
    expect(result.success).toBe(false);
  });

  it('parses the created status config row (route truth, §2.7 create_task_status)', () => {
    const statusFixture = {
      id: 's1abc',
      taskListId: 'tl1abc',
      name: 'Review',
      slug: 'review',
      color: 'bg-blue-100',
      group: 'in_progress',
      position: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const result = parseResponse(createTaskStatus, 201, new Headers(), JSON.stringify(statusFixture));
    expect(result).toEqual(statusFixture);
  });

  it('classifies a slug-collision 409 as an HttpError, never a schema mismatch', () => {
    const result = parseResponse(createTaskStatus, 409, new Headers(), JSON.stringify({ error: 'A status with slug "review" already exists' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('HTTP_ERROR');
  });
});

describe('tasks.setTrigger — request shape, refinements, response', () => {
  it('interpolates :taskId and sends the trigger fields as body', () => {
    const request = buildRequest(
      setTaskTrigger,
      { taskId: 't1', triggerType: 'due_date', agentPageId: 'ag1', prompt: 'Nudge me' },
      config,
    );
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://pagespace.ai/api/tasks/t1/triggers');
    expect(request.body).toBe(JSON.stringify({ agentPageId: 'ag1', prompt: 'Nudge me', triggerType: 'due_date' }));
  });

  it('rejects a trigger with neither prompt nor instructionPageId (route .strict().refine())', () => {
    const result = setTaskTrigger.inputSchema.safeParse({ taskId: 't1', triggerType: 'due_date', agentPageId: 'ag1' });
    expect(result.success).toBe(false);
  });

  it('accepts a trigger with only instructionPageId', () => {
    const result = setTaskTrigger.inputSchema.safeParse({
      taskId: 't1',
      triggerType: 'completion',
      agentPageId: 'ag1',
      instructionPageId: 'instr1',
    });
    expect(result.success).toBe(true);
  });

  it('parses { trigger } including the linked workflow fields', () => {
    const triggerFixture = {
      trigger: {
        id: 'tr1abc',
        taskItemId: 't1',
        triggerType: 'due_date',
        nextRunAt: '2026-02-01T00:00:00.000Z',
        lastFiredAt: null,
        lastFireError: null,
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        workflowId: 'wf1abc',
        agentPageId: 'ag1',
        prompt: 'Nudge me',
        instructionPageId: null,
        contextPageIds: [],
      },
    };
    const result = parseResponse(setTaskTrigger, 200, new Headers(), JSON.stringify(triggerFixture));
    expect(result).toEqual(triggerFixture);
  });
});

describe('tasks.deleteTrigger — request shape, response, and MCP-auth parity fix', () => {
  it('interpolates both :taskId and :triggerType', () => {
    const request = buildRequest(deleteTaskTrigger, { taskId: 't1', triggerType: 'completion' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/tasks/t1/triggers/completion');
    expect(request.body).toBeUndefined();
  });

  it('parses { success: true }', () => {
    const result = parseResponse(deleteTaskTrigger, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });

  it('declares drive scope, not sessionOnly — route now allows mcp tokens (#1764/66/67/70 fix, was D2)', () => {
    expect(deleteTaskTrigger.requiredScope).toBe('drive');
  });
});

describe('tasks.getAssigned — request shape, refinements, response', () => {
  it('sends filters as query params with no path params', () => {
    const request = buildRequest(getAssignedTasks, { context: 'drive', driveId: 'd1', limit: 10 }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/tasks?context=drive&driveId=d1&limit=10');
  });

  it('serializes boolean filters as literal "true"/"false" query strings', () => {
    const request = buildRequest(getAssignedTasks, { showAllAssignees: true }, config);
    expect(request.url).toBe('https://pagespace.ai/api/tasks?showAllAssignees=true');
  });

  it('rejects context "drive" with no driveId (route 400: "driveId is required for drive context")', () => {
    const result = getAssignedTasks.inputSchema.safeParse({ context: 'drive' });
    expect(result.success).toBe(false);
  });

  it('accepts context "user" with no driveId', () => {
    const result = getAssignedTasks.inputSchema.safeParse({ context: 'user' });
    expect(result.success).toBe(true);
  });

  it('rejects a limit above the route cap of 100', () => {
    const result = getAssignedTasks.inputSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('parses { tasks, statusConfigsByTaskList, pagination } (route truth, §2.7 get_assigned_tasks)', () => {
    const responseFixture = {
      tasks: [
        {
          ...taskFixture,
          page: { id: 'p1task', title: 'Write the spec', isTrashed: false, parentId: 'pglist1' },
          driveId: 'd1abc',
          taskListPageId: 'pglist1',
          taskListPageTitle: 'Sprint Board',
          statusGroup: 'todo',
          statusLabel: 'To Do',
          statusColor: 'bg-slate-100 text-slate-700',
        },
      ],
      statusConfigsByTaskList: {
        pglist1: [{ id: 's1', taskListId: 'tl1', name: 'To Do', slug: 'pending', color: 'bg-slate-100', group: 'todo', position: 0 }],
      },
      pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
    };
    const result = parseResponse(getAssignedTasks, 200, new Headers(), JSON.stringify(responseFixture));
    expect(result).toEqual(responseFixture);
  });

  it('parses an empty result set', () => {
    const empty = { tasks: [], statusConfigsByTaskList: {}, pagination: { total: 0, limit: 50, offset: 0, hasMore: false } };
    const result = parseResponse(getAssignedTasks, 200, new Headers(), JSON.stringify(empty));
    expect(result).toEqual(empty);
  });
});

describe('classifyTaskCompletionGate — pure gating-error classifier', () => {
  it('recovers pending/total from a 422 HttpError raised by tasks.update', () => {
    const error = new HttpError('Complete all sub-tasks first (2 of 5 remaining)', 422, 'tasks.update');
    expect(classifyTaskCompletionGate(error)).toEqual({ pending: 2, total: 5 });
  });

  it('returns null for a non-422 HttpError', () => {
    const error = new HttpError('Something else', 409, 'tasks.update');
    expect(classifyTaskCompletionGate(error)).toBeNull();
  });

  it('returns null for a 422 error whose message does not match the gating shape', () => {
    const error = new HttpError('HTTP 422', 422, 'tasks.update');
    expect(classifyTaskCompletionGate(error)).toBeNull();
  });

  it('returns null for a non-error value', () => {
    expect(classifyTaskCompletionGate({ status: 422, message: '(2 of 5 remaining)' })).toBeNull();
  });
});

describe('tasks operations — metadata', () => {
  it('every operation is named, described, and scoped for MCP/CLI derivation', () => {
    const ops = [createTask, updateTask, deleteTask, reorderTask, createTaskStatus, setTaskTrigger, deleteTaskTrigger, getAssignedTasks];
    for (const op of ops) {
      expect(op.name.startsWith('tasks.')).toBe(true);
      expect(op.description.length).toBeGreaterThan(0);
    }
  });
});
