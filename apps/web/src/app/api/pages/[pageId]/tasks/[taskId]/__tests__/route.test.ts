import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ---------- Mocks (must precede route import) ----------

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  loggers: {
    api: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
    ai: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  },
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/workflows/task-trigger-helpers', () => ({
  syncTaskDueDateTrigger: vi.fn().mockResolvedValue(undefined),
  cancelTaskDueDateTrigger: vi.fn().mockResolvedValue(undefined),
  fireCompletionTrigger: vi.fn().mockResolvedValue(undefined),
  disableTaskTriggers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: { DOCUMENT: 'DOCUMENT', FOLDER: 'FOLDER', TASK_LIST: 'TASK_LIST' },
  getDefaultContent: vi.fn(() => '{}'),
  logger: {
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@test.com',
    actorDisplayName: 'Test User',
  }),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/notifications', () => ({
  createTaskAssignedNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn().mockResolvedValue({ deferredTrigger: undefined }),
  PageRevisionMismatchError: class PageRevisionMismatchError extends Error {
    currentRevision: number;
    expectedRevision?: number;
    constructor(message: string, currentRevision: number, expectedRevision?: number) {
      super(message);
      this.currentRevision = currentRevision;
      this.expectedRevision = expectedRevision;
    }
  },
}));

vi.mock('@pagespace/lib/monitoring', () => ({
  DeferredWorkflowTrigger: undefined,
}));

// REVIEW: Deep ORM chain mocks (db.update().set().where().returning(), db.transaction(tx => ...))
// are used here because the route directly calls Drizzle ORM with no service layer.
// The ORM IS the system boundary for this route. Extracting a service seam is a production refactor.
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      taskLists: { findFirst: vi.fn() },
      taskItems: { findFirst: vi.fn() },
      taskStatusConfigs: { findMany: vi.fn().mockResolvedValue([]) },
      taskAssignees: { findMany: vi.fn().mockResolvedValue([]) },
      pages: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      const txUpdateReturning = vi.fn().mockResolvedValue([{
        id: 'task-1', title: 'Updated Task', status: 'pending',
        assigneeId: null, assigneeAgentId: null, pageId: null,
      }]);
      const txUpdateWhere = vi.fn(() => ({ returning: txUpdateReturning }));
      const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));

      const tx = {
        update: vi.fn(() => ({ set: txUpdateSet })),
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
        insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      };
      return callback(tx);
    }),
  },
  taskItems: {},
  taskLists: {},
  taskStatusConfigs: {},
  taskAssignees: {},
  pages: {},
  eq: vi.fn((_a: unknown, _b: unknown) => ({ _a, _b })),
  and: vi.fn((...c: unknown[]) => c),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn(() => ({})),
}));

// ---------- Imports (after mocks) ----------

import { PATCH, DELETE } from '../route';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { createTaskAssignedNotification } from '@pagespace/lib/notifications';
import { logPageActivity } from '@pagespace/lib/monitoring/activity-logger';

// ---------- Helpers ----------

const mockUserId = 'user-123';
const mockPageId = 'page-456';
const mockTaskId = 'task-789';
const mockTaskListId = 'tasklist-abc';

const context = { params: Promise.resolve({ pageId: mockPageId, taskId: mockTaskId }) };

function createPatchRequest(body: Record<string, unknown>) {
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/${mockTaskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createDeleteRequest() {
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/${mockTaskId}`, {
    method: 'DELETE',
  });
}

function setupAuth(userId = mockUserId) {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
}

function setupAuthError() {
  const errResp = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: errResp } as never);
}

function setupMCPScopeError() {
  setupAuth();
  const errResp = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
  vi.mocked(checkMCPPageScope).mockResolvedValueOnce(errResp as never);
}

function setupCanEdit(can = true) {
  vi.mocked(canUserEditPage).mockResolvedValue(can);
}

const baseTask = {
  id: mockTaskId,
  title: 'Existing Task',
  description: 'desc',
  status: 'pending',
  priority: 'medium',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: null,
  completedAt: null,
  taskListId: mockTaskListId,
  position: 0,
};

function setupTaskLookup(taskList = { id: mockTaskListId }, task: Record<string, unknown> | null = baseTask) {
  vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(taskList as never);
  vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(task as never);
}

function setupTransaction(returnedTask: Record<string, unknown> = baseTask) {
  vi.mocked(db.transaction).mockImplementation(async (callback) => {
    const txUpdateReturning = vi.fn().mockResolvedValue([returnedTask]);
    const txUpdateWhere = vi.fn(() => ({ returning: txUpdateReturning }));
    const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));

    const tx = {
      update: vi.fn(() => ({ set: txUpdateSet })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };
    return callback(tx as never);
  });
}

function setupRelationsLookup(task: Record<string, unknown> | null = {
  ...baseTask,
  assignee: null,
  assigneeAgent: null,
  user: null,
  assignees: [],
}) {
  vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(task as never);
}

// ---------- Tests ----------

describe('PATCH /api/pages/[pageId]/tasks/[taskId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([] as never);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await PATCH(createPatchRequest({ title: 'x' }), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope check fails', async () => {
    setupMCPScopeError();
    const response = await PATCH(createPatchRequest({ title: 'x' }), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks edit permission', async () => {
    setupAuth();
    setupCanEdit(false);
    const response = await PATCH(createPatchRequest({ title: 'x' }), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('You need edit permission to update tasks');
  });

  it('returns 404 when task list is not found', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await PATCH(createPatchRequest({ title: 'x' }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task list not found');
  });

  it('returns 404 when task is not found', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(null as never);

    const response = await PATCH(createPatchRequest({ title: 'x' }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task not found');
  });

  it('returns 400 when title is empty string', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();

    const response = await PATCH(createPatchRequest({ title: '   ' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Title cannot be empty');
  });

  it('returns 400 when title is not a string', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();

    const response = await PATCH(createPatchRequest({ title: 123 }), context);
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid status with custom status configs', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { slug: 'open', group: 'todo' },
      { slug: 'closed', group: 'done' },
    ] as never);

    const response = await PATCH(createPatchRequest({ status: 'bogus' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid status "bogus"');
    expect(body.error).toContain('open');
    expect(body.error).toContain('closed');
  });

  it('sets completedAt when custom status group is done', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, completedAt: null });
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { slug: 'open', group: 'todo' },
      { slug: 'finished', group: 'done' },
    ] as never);

    const updatedTask = { ...baseTask, status: 'finished', completedAt: new Date() };
    setupTransaction(updatedTask);
    setupRelationsLookup({ ...updatedTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ status: 'finished' }), context);
    expect(response.status).toBe(200);
  });

  it('clears completedAt when moving away from done group (custom statuses)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, status: 'finished', completedAt: new Date() });
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { slug: 'open', group: 'todo' },
      { slug: 'finished', group: 'done' },
    ] as never);

    const updatedTask = { ...baseTask, status: 'open', completedAt: null };
    setupTransaction(updatedTask);
    setupRelationsLookup({ ...updatedTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ status: 'open' }), context);
    expect(response.status).toBe(200);
  });

  it('does not clear completedAt for non-done status when existingTask has no completedAt', async () => {
    setupAuth();
    setupCanEdit(true);
    // existingTask has no completedAt (null), so the else branch is skipped
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, status: 'open', completedAt: null });
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { slug: 'open', group: 'todo' },
      { slug: 'wip', group: 'in_progress' },
      { slug: 'finished', group: 'done' },
    ] as never);

    const updatedTask = { ...baseTask, status: 'wip' };
    setupTransaction(updatedTask);
    setupRelationsLookup({ ...updatedTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ status: 'wip' }), context);
    expect(response.status).toBe(200);
  });

  it('clears completedAt when moving from done to non-done group (custom statuses, sequenced mocks)', async () => {
    setupAuth();
    setupCanEdit(true);
    const existingTask = { ...baseTask, status: 'finished', completedAt: new Date('2024-01-01') };
    // Use mockResolvedValueOnce to properly sequence: first call returns existingTask, second returns relations
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(existingTask as never) // existingTask lookup
      .mockResolvedValueOnce({ ...existingTask, status: 'open', completedAt: null, assignee: null, assigneeAgent: null, user: null, assignees: [] } as never); // relations lookup
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { slug: 'open', group: 'todo' },
      { slug: 'finished', group: 'done' },
    ] as never);

    setupTransaction({ ...existingTask, status: 'open', completedAt: null });

    const response = await PATCH(createPatchRequest({ status: 'open' }), context);
    expect(response.status).toBe(200);
  });

  it('clears completedAt when moving from completed in fallback mode (sequenced mocks)', async () => {
    setupAuth();
    setupCanEdit(true);
    const existingTask = { ...baseTask, status: 'completed', completedAt: new Date('2024-01-01') };
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(existingTask as never) // existingTask lookup
      .mockResolvedValueOnce({ ...existingTask, status: 'pending', completedAt: null, assignee: null, assigneeAgent: null, user: null, assignees: [] } as never); // relations lookup
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never); // no custom configs = fallback mode

    setupTransaction({ ...existingTask, status: 'pending', completedAt: null });

    const response = await PATCH(createPatchRequest({ status: 'pending' }), context);
    expect(response.status).toBe(200);
  });

  it('returns 400 for invalid fallback status (no custom configs)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);

    const response = await PATCH(createPatchRequest({ status: 'invalid_status' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid status');
  });

  it('sets completedAt for fallback completed status', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);

    const updatedTask = { ...baseTask, status: 'completed' };
    setupTransaction(updatedTask);
    setupRelationsLookup({ ...updatedTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ status: 'completed' }), context);
    expect(response.status).toBe(200);
  });

  it('clears completedAt when moving from completed to another fallback status', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, status: 'completed', completedAt: new Date() });
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);

    const updatedTask = { ...baseTask, status: 'pending', completedAt: null };
    setupTransaction(updatedTask);
    setupRelationsLookup({ ...updatedTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ status: 'pending' }), context);
    expect(response.status).toBe(200);
  });

  it('does not clear completedAt for fallback non-completed status when task was not completed', async () => {
    setupAuth();
    setupCanEdit(true);
    // existing task status is 'pending' (not 'completed'), so else-if is not entered
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, status: 'pending' });
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);

    const updatedTask = { ...baseTask, status: 'in_progress' };
    setupTransaction(updatedTask);
    setupRelationsLookup({ ...updatedTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ status: 'in_progress' }), context);
    expect(response.status).toBe(200);
  });

  it('returns 400 for invalid priority', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();

    const response = await PATCH(createPatchRequest({ priority: 'critical' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid priority');
  });

  it('allows valid priority', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, priority: 'high' });
    setupRelationsLookup({ ...baseTask, priority: 'high', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ priority: 'high' }), context);
    expect(response.status).toBe(200);
  });

  it('handles assigneeId update (legacy)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, assigneeId: 'user-999' });
    setupRelationsLookup({ ...baseTask, assigneeId: 'user-999', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeId: 'user-999' }), context);
    expect(response.status).toBe(200);
  });

  it('handles clearing assigneeId to null', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, assigneeId: 'user-999' });
    setupTransaction({ ...baseTask, assigneeId: null });
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeId: '' }), context);
    expect(response.status).toBe(200);
  });

  it('validates agent assigneeAgentId and returns 400 if not valid', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never) // taskListPage
      .mockResolvedValueOnce(null as never); // agent not found

    const response = await PATCH(createPatchRequest({ assigneeAgentId: 'bad-agent' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid agent ID - must be an AI agent page');
  });

  it('returns 400 when assigneeAgentId is in a different drive', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never)
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-other' } as never);

    const response = await PATCH(createPatchRequest({ assigneeAgentId: 'agent-1' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Agent must be in the same drive as the task list');
  });

  it('allows valid assigneeAgentId in same drive', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never)
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' } as never);

    setupTransaction({ ...baseTask, assigneeAgentId: 'agent-1' });
    setupRelationsLookup({ ...baseTask, assigneeAgentId: 'agent-1', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeAgentId: 'agent-1' }), context);
    expect(response.status).toBe(200);
  });

  it('clears assigneeAgentId when set to empty string', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, assigneeAgentId: 'agent-old' });
    setupTransaction({ ...baseTask, assigneeAgentId: null });
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeAgentId: '' }), context);
    expect(response.status).toBe(200);
  });

  it('validates agent entries in assigneeIds array', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never)
      .mockResolvedValueOnce(null as never);

    const response = await PATCH(createPatchRequest({
      assigneeIds: [{ type: 'agent', id: 'bad-agent' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid agent ID "bad-agent"');
  });

  it('returns 400 when agent in assigneeIds is in wrong drive', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never)
      .mockResolvedValueOnce({ id: 'agent-x', driveId: 'drive-2' } as never);

    const response = await PATCH(createPatchRequest({
      assigneeIds: [{ type: 'agent', id: 'agent-x' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Agent must be in the same drive as the task list');
  });

  it('handles dueDate update', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, dueDate: new Date('2025-12-31') });
    setupRelationsLookup({ ...baseTask, dueDate: '2025-12-31', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ dueDate: '2025-12-31' }), context);
    expect(response.status).toBe(200);
  });

  it('clears dueDate when set to null', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, dueDate: null });
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ dueDate: null }), context);
    expect(response.status).toBe(200);
  });

  it('handles position update', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, position: 5 });
    setupRelationsLookup({ ...baseTask, position: 5, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ position: 5 }), context);
    expect(response.status).toBe(200);
  });

  it('handles description update', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, description: 'new desc' });
    setupRelationsLookup({ ...baseTask, description: 'new desc', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ description: '  new desc  ' }), context);
    expect(response.status).toBe(200);
  });

  it('clears description when set to empty', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    setupTransaction({ ...baseTask, description: null });
    setupRelationsLookup({ ...baseTask, description: null, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ description: '' }), context);
    expect(response.status).toBe(200);
  });

  it('skips db update when no field-level updates are provided (assigneeIds only)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [{ type: 'user', id: 'user-999' }],
    }), context);
    expect(response.status).toBe(200);
  });

  it('syncs title to linked page when title changes and task has a pageId', async () => {
    setupAuth();
    setupCanEdit(true);
    const taskWithPage = { ...baseTask, pageId: 'linked-page-1' };
    setupTaskLookup({ id: mockTaskListId }, taskWithPage);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);

    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const txUpdateReturning = vi.fn().mockResolvedValue([{ ...taskWithPage, title: 'New Title' }]);
      const txUpdateWhere = vi.fn(() => ({ returning: txUpdateReturning }));
      const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
      const txSelectLimit = vi.fn().mockResolvedValue([{ revision: 1 }]);
      const txSelectWhere = vi.fn(() => ({ limit: txSelectLimit }));
      const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));

      const tx = {
        update: vi.fn(() => ({ set: txUpdateSet })),
        delete: vi.fn(() => ({ where: vi.fn() })),
        insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
        select: vi.fn(() => ({ from: txSelectFrom })),
      };
      return callback(tx as never);
    });

    vi.mocked(applyPageMutation).mockResolvedValue({ deferredTrigger: vi.fn() } as never);
    setupRelationsLookup({ ...taskWithPage, title: 'New Title', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ title: 'New Title' }), context);
    expect(response.status).toBe(200);
    expect(applyPageMutation).toHaveBeenCalledWith(expect.objectContaining({
      pageId: 'linked-page-1',
      operation: 'update',
    }));
    expect(createPageEventPayload).toHaveBeenCalledWith(
      'drive-1',
      'linked-page-1',
      'updated',
      expect.objectContaining({ title: 'New Title' })
    );
    expect(broadcastPageEvent).toHaveBeenCalledTimes(1);
  });

  it('handles PageRevisionMismatchError with expectedRevision (409)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, pageId: 'linked-page-1' });
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);

    const { PageRevisionMismatchError: PRME } = await import('@/services/api/page-mutation-service');
    vi.mocked(db.transaction).mockRejectedValueOnce(new PRME('Conflict', 5, 3));

    const response = await PATCH(createPatchRequest({ title: 'New Title' }), context);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('Conflict');
    expect(body.currentRevision).toBe(5);
    expect(body.expectedRevision).toBe(3);
  });

  it('handles PageRevisionMismatchError without expectedRevision (428)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, pageId: 'linked-page-1' });
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);

    const { PageRevisionMismatchError: PRME } = await import('@/services/api/page-mutation-service');
    vi.mocked(db.transaction).mockRejectedValueOnce(new PRME('Missing revision', 5, undefined));

    const response = await PATCH(createPatchRequest({ title: 'New Title' }), context);
    expect(response.status).toBe(428);
    const body = await response.json();
    expect(body.error).toBe('Missing revision');
  });

  it('rethrows non-PageRevisionMismatchError errors', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error('DB crash'));

    await expect(PATCH(createPatchRequest({ title: 'x' }), context)).rejects.toThrow('DB crash');
  });

  it('returns 404 when task not found after update', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction(baseTask);

    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(baseTask as never) // existing task check
      .mockResolvedValueOnce(null as never); // relations lookup returns null

    const response = await PATCH(createPatchRequest({ priority: 'low' }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task not found after update');
  });

  it('sends notification when assigneeId changes to a new user', async () => {
    setupAuth();
    setupCanEdit(true);
    const existingTask = { ...baseTask, assigneeId: 'old-user' };
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    // First call: existingTask lookup; Second call: relations lookup after update
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(existingTask as never)
      .mockResolvedValueOnce({
        ...baseTask, assigneeId: 'new-user', title: 'Existing Task',
        assignee: null, assigneeAgent: null, user: null, assignees: [],
      } as never);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction({ ...baseTask, assigneeId: 'new-user' });

    const response = await PATCH(createPatchRequest({ assigneeId: 'new-user' }), context);
    expect(response.status).toBe(200);
    expect(createTaskAssignedNotification).toHaveBeenCalledWith(
      'new-user', mockTaskId, 'Existing Task', mockPageId, mockUserId
    );
  });

  it('does not send notification when assigneeId is set to null', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, assigneeId: 'old-user' });
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction({ ...baseTask, assigneeId: null });
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeId: null }), context);
    expect(response.status).toBe(200);
    expect(createTaskAssignedNotification).not.toHaveBeenCalled();
  });

  it('sends notifications for newly added users in assigneeIds', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([
      { userId: 'existing-user', agentPageId: null },
    ] as never);
    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [
        { type: 'user', id: 'existing-user' },
        { type: 'user', id: 'brand-new-user' },
      ],
    }), context);
    expect(response.status).toBe(200);
    expect(createTaskAssignedNotification).toHaveBeenCalledWith(
      'brand-new-user', mockTaskId, 'Existing Task', mockPageId, mockUserId
    );
  });

  it('does not send notification to self when added in assigneeIds', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([] as never);
    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [{ type: 'user', id: mockUserId }],
    }), context);
    expect(response.status).toBe(200);
    expect(createTaskAssignedNotification).not.toHaveBeenCalled();
  });

  it('broadcasts task_updated event', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ priority: 'low' }), context);
    expect(response.status).toBe(200);
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_updated',
      taskId: mockTaskId,
      taskListId: mockTaskListId,
      pageId: mockPageId,
    }));
  });

  it('handles legacy single-assignee update syncing to junction table', async () => {
    setupAuth();
    setupCanEdit(true);
    const taskWithAssignee = { ...baseTask, assigneeId: 'old-user', assigneeAgentId: null };
    setupTaskLookup({ id: mockTaskListId }, taskWithAssignee);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction({ ...taskWithAssignee, assigneeId: 'new-user' });
    setupRelationsLookup({ ...taskWithAssignee, assigneeId: 'new-user', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeId: 'new-user' }), context);
    expect(response.status).toBe(200);
  });

  it('handles assigneeIds with agent entries in transaction', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never)
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' } as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([] as never);

    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [
        { type: 'user', id: 'user-a' },
        { type: 'agent', id: 'agent-1' },
      ],
    }), context);
    expect(response.status).toBe(200);
  });

  it('handles taskListPage being null when checking agent drive for assigneeAgentId', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce(null as never) // taskListPage null
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-x' } as never);

    setupTransaction({ ...baseTask, assigneeAgentId: 'agent-1' });
    setupRelationsLookup({ ...baseTask, assigneeAgentId: 'agent-1', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({ assigneeAgentId: 'agent-1' }), context);
    expect(response.status).toBe(200);
  });

  it('handles taskListPage being null for assigneeIds agent validation', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce(null as never) // taskListPage null
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'any-drive' } as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([] as never);

    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [{ type: 'agent', id: 'agent-1' }],
    }), context);
    expect(response.status).toBe(200);
  });

  it('handles empty assigneeIds array (no rows to insert)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([] as never);
    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [],
    }), context);
    expect(response.status).toBe(200);
  });

  it('handles assigneeIds entries without id (skips them)', async () => {
    setupAuth();
    setupCanEdit(true);
    setupTaskLookup();
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    vi.mocked(db.query.taskAssignees.findMany).mockResolvedValue([] as never);
    setupTransaction(baseTask);
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    const response = await PATCH(createPatchRequest({
      assigneeIds: [{ type: 'user', id: '' }, { type: 'agent', id: '' }],
    }), context);
    expect(response.status).toBe(200);
  });

  it('handles legacy assignee update with no existing assignees (empty rows)', async () => {
    setupAuth();
    setupCanEdit(true);
    // Task with no existing assignees
    setupTaskLookup({ id: mockTaskListId }, { ...baseTask, assigneeId: null, assigneeAgentId: null });
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
    setupTransaction({ ...baseTask, assigneeId: null });
    setupRelationsLookup({ ...baseTask, assignee: null, assigneeAgent: null, user: null, assignees: [] });

    // Setting assigneeId to null when it's already null - legacy path with empty rows
    const response = await PATCH(createPatchRequest({ assigneeId: null }), context);
    expect(response.status).toBe(200);
  });

  it('handles legacy assigneeAgentId update with existing assigneeId on task', async () => {
    setupAuth();
    setupCanEdit(true);
    // Task has existing assigneeId but no assigneeAgentId
    const taskWithUser = { ...baseTask, assigneeId: 'user-x', assigneeAgentId: null };
    setupTaskLookup({ id: mockTaskListId }, taskWithUser);
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ driveId: 'drive-1' } as never)
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' } as never);

    setupTransaction({ ...taskWithUser, assigneeAgentId: 'agent-1' });
    setupRelationsLookup({ ...taskWithUser, assigneeAgentId: 'agent-1', assignee: null, assigneeAgent: null, user: null, assignees: [] });

    // Only changing assigneeAgentId, not assigneeId - legacy path should sync both
    const response = await PATCH(createPatchRequest({ assigneeAgentId: 'agent-1' }), context);
    expect(response.status).toBe(200);
  });
});

describe('DELETE /api/pages/[pageId]/tasks/[taskId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope check fails', async () => {
    setupMCPScopeError();
    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks edit permission', async () => {
    setupAuth();
    setupCanEdit(false);
    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('You need edit permission to delete tasks');
  });

  it('returns 404 when task list not found', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task list not found');
  });

  it('returns 404 when task not found', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(null as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task not found');
  });

  it('deletes task record directly when task has no linked page', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ ...baseTask, pageId: null } as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_deleted',
      taskId: mockTaskId,
    }));
    expect(logPageActivity).toHaveBeenCalledWith(
      mockUserId,
      'delete',
      { id: mockPageId, title: 'Existing Task', driveId: 'drive-1' },
      {
        actorEmail: 'test@test.com',
        actorDisplayName: 'Test User',
        metadata: {
          taskId: mockTaskId,
          taskListId: mockTaskListId,
          taskListPageId: mockPageId,
          isConversationTask: true,
        },
      },
    );
  });

  it('deletes task without logging when taskListPage is null', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ ...baseTask, pageId: null } as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(200);
    expect(logPageActivity).not.toHaveBeenCalled();
  });

  it('trashes linked page when task has a pageId', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
      ...baseTask, pageId: 'linked-page-1',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ revision: 3 }]),
        })),
      })),
    } as never);

    vi.mocked(applyPageMutation).mockResolvedValue({ deferredTrigger: undefined } as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(200);
    expect(applyPageMutation).toHaveBeenCalledWith(expect.objectContaining({
      pageId: 'linked-page-1',
      operation: 'trash',
    }));
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_deleted',
      taskId: mockTaskId,
    }));
    expect(createPageEventPayload).toHaveBeenCalledWith(
      'drive-1',
      'linked-page-1',
      'trashed',
      expect.objectContaining({ title: 'Existing Task', parentId: 'page-456' })
    );
    expect(broadcastPageEvent).toHaveBeenCalledTimes(1);
  });

  it('handles PageRevisionMismatchError on trash with expectedRevision (409)', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
      ...baseTask, pageId: 'linked-page-1',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ revision: 3 }]),
        })),
      })),
    } as never);

    const { PageRevisionMismatchError: PRME } = await import('@/services/api/page-mutation-service');
    vi.mocked(applyPageMutation).mockRejectedValueOnce(new PRME('Conflict', 5, 3));

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('Conflict');
  });

  it('handles PageRevisionMismatchError on trash without expectedRevision (428)', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
      ...baseTask, pageId: 'linked-page-1',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ revision: 3 }]),
        })),
      })),
    } as never);

    const { PageRevisionMismatchError: PRME } = await import('@/services/api/page-mutation-service');
    vi.mocked(applyPageMutation).mockRejectedValueOnce(new PRME('Missing rev', 5, undefined));

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(428);
  });

  it('rethrows non-PageRevisionMismatchError from trash', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
      ...baseTask, pageId: 'linked-page-1',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ revision: 3 }]),
        })),
      })),
    } as never);

    vi.mocked(applyPageMutation).mockRejectedValueOnce(new Error('Unknown error'));

    await expect(DELETE(createDeleteRequest(), context)).rejects.toThrow('Unknown error');
  });

  it('handles linked page not found (no revision row)', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
      ...baseTask, pageId: 'linked-page-1',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(200);
    expect(applyPageMutation).not.toHaveBeenCalled();
    expect(broadcastPageEvent).not.toHaveBeenCalled();
  });

  it('skips page broadcast when taskListPage is null but linkedPage exists', async () => {
    setupAuth();
    setupCanEdit(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
      ...baseTask, pageId: 'linked-page-1',
    } as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ revision: 1 }]),
        })),
      })),
    } as never);

    vi.mocked(applyPageMutation).mockResolvedValue({ deferredTrigger: undefined } as never);

    const response = await DELETE(createDeleteRequest(), context);
    expect(response.status).toBe(200);
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_deleted',
      taskId: mockTaskId,
    }));
    expect(broadcastPageEvent).not.toHaveBeenCalled();
  });
});
