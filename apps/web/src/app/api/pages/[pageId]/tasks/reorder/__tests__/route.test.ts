import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ---------- Mocks (must precede route import) ----------

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  canPrincipalEditPage: async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserEditPage: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
    PageType: { DOCUMENT: 'DOCUMENT', FOLDER: 'FOLDER', TASK_LIST: 'TASK_LIST' },
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
    getDefaultContent: vi.fn(() => '{}'),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
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

vi.mock('@pagespace/db/db', () => {
  return {
    db: {
      query: {
        taskLists: { findFirst: vi.fn() },
        pages: { findFirst: vi.fn() },
      },
      transaction: vi.fn(async (callback) => {
        const tx = {};
        return callback(tx);
      }),
    },
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', field: a, value: b })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: {},
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/services/reorder', () => ({
  computeReorderPlan: vi.fn((entries: { id: string; position: number }[]) => {
    const positionById = new Map<string, number>();
    for (const entry of entries) {
      positionById.set(entry.id, entry.position);
    }
    return { orderedIds: Array.from(positionById.keys()).sort(), positionById };
  }),
}));

vi.mock('../reorder-task-list', () => ({
  reorderTaskListChildren: vi.fn(),
}));

// ---------- Imports (after mocks) ----------

import { PATCH } from '../route';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { broadcastTaskEvent } from '@/lib/websocket';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { computeReorderPlan } from '@pagespace/lib/services/reorder';
import { reorderTaskListChildren } from '../reorder-task-list';

// ---------- Helpers ----------

const mockUserId = 'user-123';
const mockPageId = 'page-456';
const mockTaskListId = 'tasklist-789';

const context = { params: Promise.resolve({ pageId: mockPageId }) };

function createRequest(body: Record<string, unknown>) {
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setupAuth(userId = mockUserId) {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
}

function setupAuthError() {
  const errResp = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: errResp } as never);
}

// ---------- Tests ----------

describe('PATCH /api/pages/[pageId]/tasks/reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
    // Default: every submitted task id resolves within scope (the "happy path").
    // Individual tests override this to simulate out-of-scope/invalid ids.
    vi.mocked(reorderTaskListChildren).mockImplementation(async (_tx, _pageId, plan) => plan.orderedIds);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await PATCH(createRequest({ tasks: [] }), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope check fails', async () => {
    setupAuth();
    const errResp = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
    vi.mocked(checkMCPPageScope).mockResolvedValueOnce(errResp as never);

    const response = await PATCH(createRequest({ tasks: [] }), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks edit permission', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(false);

    const response = await PATCH(createRequest({ tasks: [] }), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('You need edit permission to reorder tasks');
  });

  it('succeeds when task list row is absent (membership is derived from pages.parentId)', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await PATCH(createRequest({ tasks: [] }), context);
    expect(response.status).toBe(200);
  });

  it('returns 400 when tasks is not an array', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PATCH(createRequest({ tasks: 'not-array' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('tasks must be an array');
  });

  it('returns 400 when a task entry is missing id', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PATCH(createRequest({
      tasks: [{ position: 0 }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Each task must have id and position');
  });

  it('returns 400 when a task entry has non-numeric position', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PATCH(createRequest({
      tasks: [{ id: 'task-1', position: 'abc' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Each task must have id and position');
  });

  it('reorders tasks and broadcasts event', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const tasks = [
      { id: 'task-a', position: 0 },
      { id: 'task-b', position: 1 },
    ];

    const response = await PATCH(createRequest({ tasks }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(reorderTaskListChildren).toHaveBeenCalledTimes(1);
    expect(reorderTaskListChildren).toHaveBeenCalledWith(
      expect.anything(),
      mockPageId,
      expect.objectContaining({ orderedIds: ['task-a', 'task-b'] }),
    );
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tasks_reordered',
      taskId: 'task-a',
      taskListId: mockTaskListId,
      pageId: mockPageId,
    }));
  });

  it('issues a single reorderTaskListChildren call regardless of task count', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const tasks = [
      { id: 'task-a', position: 0 },
      { id: 'task-b', position: 1 },
      { id: 'task-c', position: 2 },
      { id: 'task-d', position: 3 },
      { id: 'task-e', position: 4 },
    ];

    const response = await PATCH(createRequest({ tasks }), context);
    expect(response.status).toBe(200);

    // The N-sequential-update loop that deadlocked production would have
    // issued one write per task. reorderTaskListChildren (and the batched
    // primitive it delegates to) is called exactly once, regardless of how
    // many tasks are being reordered.
    expect(computeReorderPlan).toHaveBeenCalledWith(tasks);
    expect(reorderTaskListChildren).toHaveBeenCalledTimes(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when a submitted task id falls outside the task list scope', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    // Simulate reorderTaskListChildren's scope excluding one of the submitted
    // ids (e.g. it belongs to a different task list) — only 'task-a' actually locked.
    vi.mocked(reorderTaskListChildren).mockResolvedValue(['task-a']);

    const tasks = [
      { id: 'task-a', position: 0 },
      { id: 'task-b', position: 1 },
    ];

    const response = await PATCH(createRequest({ tasks }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid task IDs');
    expect(broadcastTaskEvent).not.toHaveBeenCalled();
  });

  it('logs page activity when taskListPage exists', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My Task List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const tasks = [{ id: 'task-a', position: 0 }];

    const response = await PATCH(createRequest({ tasks }), context);
    expect(response.status).toBe(200);
    expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
    expect(logPageActivity).toHaveBeenCalledWith(
      mockUserId,
      'reorder',
      expect.objectContaining({
        id: mockPageId,
        title: 'My Task List',
        driveId: 'drive-1',
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({
          taskListId: mockTaskListId,
          reorderedTaskIds: ['task-a'],
        }),
      }),
    );
  });

  it('skips logging when taskListPage is null', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const tasks = [{ id: 'task-a', position: 0 }];

    const response = await PATCH(createRequest({ tasks }), context);
    expect(response.status).toBe(200);
    expect(logPageActivity).not.toHaveBeenCalled();
  });

  it('uses fallback title when taskListPage has no title', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: null } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const tasks = [{ id: 'task-a', position: 0 }];

    const response = await PATCH(createRequest({ tasks }), context);
    expect(response.status).toBe(200);
    expect(logPageActivity).toHaveBeenCalledWith(
      mockUserId,
      'reorder',
      { id: mockPageId, title: 'Task List', driveId: 'drive-1' },
      {
        actorEmail: 'test@test.com',
        actorDisplayName: 'Test User',
        metadata: {
          taskListId: mockTaskListId,
          reorderedTaskIds: ['task-a'],
          newPositions: [{ id: 'task-a', position: 0 }],
        },
      },
    );
  });

  it('handles empty tasks array (edge case)', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PATCH(createRequest({ tasks: [] }), context);
    expect(response.status).toBe(200);
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: '',
    }));
    // Empty plan is a no-op: no transaction should be opened for zero tasks.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(reorderTaskListChildren).not.toHaveBeenCalled();
  });
});
