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

vi.mock('@pagespace/db', () => {
  const mockTxUpdate = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  return {
    db: {
      query: {
        taskLists: { findFirst: vi.fn() },
        pages: { findFirst: vi.fn() },
      },
      transaction: vi.fn(async (callback) => {
        const tx = { update: mockTxUpdate };
        return callback(tx);
      }),
    },
    taskItems: {},
    taskLists: {},
    pages: {},
    eq: vi.fn((a, b) => ({ field: a, value: b })),
  };
});

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------- Imports (after mocks) ----------

import { PATCH } from '../route';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { broadcastTaskEvent } from '@/lib/websocket';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';

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

/** @scaffold - ORM chain mocks until repository seam exists */
describe('PATCH /api/pages/[pageId]/tasks/reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
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

  it('returns 404 when task list not found', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ driveId: 'drive-1', title: 'My List' } as never);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await PATCH(createRequest({ tasks: [] }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task list not found');
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

    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tasks_reordered',
      taskId: 'task-a',
      taskListId: mockTaskListId,
      pageId: mockPageId,
    }));
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
      expect.objectContaining({ title: 'Task List' }),
      expect.any(Object),
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
  });
});
