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
  canUserViewPage: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: { DOCUMENT: 'DOCUMENT', FOLDER: 'FOLDER', TASK_LIST: 'TASK_LIST' },
  getDefaultContent: vi.fn(() => '{}'),
  logger: {
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

// Transaction mock factory for flexible configuration
const createTxMock = () => {
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
  const txInsertReturning = vi.fn().mockResolvedValue([{ id: 'new-tasklist' }]);
  const txInsertValues = vi.fn(() => ({ returning: txInsertReturning }));
  const txDeleteWhere = vi.fn().mockResolvedValue(undefined);

  return {
    update: vi.fn(() => ({ set: txUpdateSet })),
    insert: vi.fn(() => ({ values: txInsertValues })),
    delete: vi.fn(() => ({ where: txDeleteWhere })),
  };
};

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      taskLists: { findFirst: vi.fn() },
      taskStatusConfigs: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      taskItems: { findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    transaction: vi.fn(async (callback) => callback(createTxMock())),
  },
  taskLists: {},
  taskStatusConfigs: {},
  taskItems: {},
  DEFAULT_TASK_STATUSES: [
    { slug: 'pending', name: 'To Do', color: 'bg-slate-100', group: 'todo', position: 0 },
    { slug: 'in_progress', name: 'In Progress', color: 'bg-amber-100', group: 'in_progress', position: 1 },
    { slug: 'blocked', name: 'Blocked', color: 'bg-red-100', group: 'in_progress', position: 2 },
    { slug: 'completed', name: 'Done', color: 'bg-green-100', group: 'done', position: 3 },
  ],
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...c: unknown[]) => c),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  inArray: vi.fn((col, vals) => ({ col, vals })),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------- Imports (after mocks) ----------

import { GET, POST, PUT, DELETE } from '../route';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { broadcastTaskEvent } from '@/lib/websocket';

// ---------- Helpers ----------

const mockUserId = 'user-123';
const mockPageId = 'page-456';
const mockTaskListId = 'tasklist-789';

const context = { params: Promise.resolve({ pageId: mockPageId }) };

function createGetRequest() {
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/statuses`, {
    method: 'GET',
  });
}

function createPostRequest(body: Record<string, unknown>) {
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/statuses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createPutRequest(body: Record<string, unknown>) {
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/statuses`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createDeleteRequest(params: Record<string, string>) {
  const searchParams = new URLSearchParams(params);
  return new Request(`https://example.com/api/pages/${mockPageId}/tasks/statuses?${searchParams}`, {
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

// ---------- Tests ----------

describe('GET /api/pages/[pageId]/tasks/statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await GET(createGetRequest(), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope fails', async () => {
    setupMCPScopeError();
    const response = await GET(createGetRequest(), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks view permission', async () => {
    setupAuth();
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const response = await GET(createGetRequest(), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Access denied');
  });

  it('returns default statuses when no task list exists', async () => {
    setupAuth();
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await GET(createGetRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.statusConfigs).toHaveLength(4);
    expect(body.statusConfigs[0].slug).toBe('pending');
    expect(body.statusConfigs[0].id).toBe('default-pending');
  });

  it('returns saved status configs when task list exists', async () => {
    setupAuth();
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    const configs = [
      { id: 'cfg-1', slug: 'open', name: 'Open', position: 0 },
      { id: 'cfg-2', slug: 'closed', name: 'Closed', position: 1 },
    ];
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue(configs as never);

    const response = await GET(createGetRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.statusConfigs).toHaveLength(2);
    expect(body.statusConfigs[0].slug).toBe('open');
  });
});

describe('POST /api/pages/[pageId]/tasks/statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await POST(createPostRequest({ name: 'x', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope fails', async () => {
    setupMCPScopeError();
    const response = await POST(createPostRequest({ name: 'x', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks edit permission', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(false);

    const response = await POST(createPostRequest({ name: 'x', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('You need edit permission to manage statuses');
  });

  it('returns 400 when name is missing', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Name is required');
  });

  it('returns 400 when name is empty string', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ name: '   ', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Name is required');
  });

  it('returns 400 when name is not a string', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ name: 123, group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Name is required');
  });

  it('returns 400 when group is invalid', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ name: 'Review', group: 'invalid', color: '#fff' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Group must be one of: todo, in_progress, done');
  });

  it('returns 400 when group is missing', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ name: 'Review', color: '#fff' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Group must be one of: todo, in_progress, done');
  });

  it('returns 400 when color is missing', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ name: 'Review', group: 'todo' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Color is required');
  });

  it('returns 400 when color is not a string', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await POST(createPostRequest({ name: 'Review', group: 'todo', color: 123 }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Color is required');
  });

  it('returns 400 when slug would be empty (name with only special chars)', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await POST(createPostRequest({ name: '!!!', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Name must contain alphanumeric characters');
  });

  it('returns 409 when slug already exists', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue({ id: 'existing', slug: 'review' } as never);

    const response = await POST(createPostRequest({ name: 'Review', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('already exists');
  });

  it('creates task list if it does not exist', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    // Transaction for creating task list
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => {
      const tx = createTxMock();
      return callback(tx as never);
    });

    // After task list is created, no slug collision
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue(null as never);

    // Auto-position: no existing configs
    vi.mocked(db.query.taskStatusConfigs.findFirst)
      .mockResolvedValueOnce(null as never) // slug collision check
      .mockResolvedValueOnce(null as never); // lastConfig for position calc (via findFirst desc)

    const newConfig = { id: 'cfg-new', slug: 'review', name: 'Review', color: '#fff', group: 'todo', position: 0 };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([newConfig]),
      })),
    } as never);

    const response = await POST(createPostRequest({ name: 'Review', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(201);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(typeof vi.mocked(db.transaction).mock.calls[0][0]).toBe('function');
  });

  it('creates a status with auto-calculated position when position is not provided', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst)
      .mockResolvedValueOnce(null as never) // no slug collision
      .mockResolvedValueOnce({ position: 5 } as never); // lastConfig has position 5

    const newConfig = { id: 'cfg-new', slug: 'review', name: 'Review', color: '#fff', group: 'todo', position: 6 };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([newConfig]),
      })),
    } as never);

    const response = await POST(createPostRequest({ name: 'Review', group: 'todo', color: '#fff' }), context);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.position).toBe(6);
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_updated',
      data: expect.objectContaining({ statusConfigAdded: newConfig }),
    }));
  });

  it('uses provided position when position is specified', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue(null as never); // no collision

    const newConfig = { id: 'cfg-new', slug: 'review', name: 'Review', color: '#fff', group: 'done', position: 2 };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([newConfig]),
      })),
    } as never);

    const response = await POST(createPostRequest({ name: 'Review', group: 'done', color: '#fff', position: 2 }), context);
    expect(response.status).toBe(201);
  });

  it('auto-positions at 0 when no configs exist (lastConfig is null)', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst)
      .mockResolvedValueOnce(null as never) // no slug collision
      .mockResolvedValueOnce(null as never); // no lastConfig

    const newConfig = { id: 'cfg-new', slug: 'new_status', name: 'New Status', color: '#fff', group: 'in_progress', position: 0 };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([newConfig]),
      })),
    } as never);

    const response = await POST(createPostRequest({ name: 'New Status', group: 'in_progress', color: '#fff' }), context);
    expect(response.status).toBe(201);
  });
});

describe('PUT /api/pages/[pageId]/tasks/statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await PUT(createPutRequest({ statuses: [] }), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope fails', async () => {
    setupMCPScopeError();
    const response = await PUT(createPutRequest({ statuses: [] }), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks edit permission', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(false);

    const response = await PUT(createPutRequest({ statuses: [] }), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('You need edit permission to manage statuses');
  });

  it('returns 400 when statuses is not an array', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await PUT(createPutRequest({ statuses: 'not-array' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('statuses array is required');
  });

  it('returns 404 when task list not found', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await PUT(createPutRequest({ statuses: [] }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task list not found');
  });

  it('returns 400 when a status is missing id', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PUT(createPutRequest({
      statuses: [{ name: 'Open', group: 'todo' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Each status must have an id');
  });

  it('returns 400 when a status is missing name', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PUT(createPutRequest({
      statuses: [{ id: 'cfg-1', group: 'todo' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Each status must have a name');
  });

  it('returns 400 when name is not a string', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PUT(createPutRequest({
      statuses: [{ id: 'cfg-1', name: 123, group: 'todo' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Each status must have a name');
  });

  it('returns 400 when group is invalid', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const response = await PUT(createPutRequest({
      statuses: [{ id: 'cfg-1', name: 'Open', group: 'invalid' }],
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Each status group must be: todo, in_progress, or done');
  });

  it('updates statuses and returns updated configs', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);

    const updatedConfigs = [
      { id: 'cfg-1', slug: 'open', name: 'Open', color: '#green', group: 'todo', position: 0 },
      { id: 'cfg-2', slug: 'wip', name: 'WIP', color: '#blue', group: 'in_progress', position: 1 },
    ];
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue(updatedConfigs as never);

    const response = await PUT(createPutRequest({
      statuses: [
        { id: 'cfg-1', name: 'Open', color: '#green', group: 'todo', position: 0 },
        { id: 'cfg-2', name: 'WIP', color: '#blue', group: 'in_progress', position: 1 },
      ],
    }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.statusConfigs).toHaveLength(2);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(typeof vi.mocked(db.transaction).mock.calls[0][0]).toBe('function');
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_updated',
      data: expect.objectContaining({ statusConfigsUpdated: updatedConfigs }),
    }));
  });

  it('uses index as default position when position is not provided', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);

    const response = await PUT(createPutRequest({
      statuses: [
        { id: 'cfg-1', name: 'Open', color: '#green', group: 'todo' },
      ],
    }), context);
    expect(response.status).toBe(200);
  });
});

describe('DELETE /api/pages/[pageId]/tasks/statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as never);
  });

  it('returns 401 when not authenticated', async () => {
    setupAuthError();
    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(401);
  });

  it('returns 403 when MCP scope fails', async () => {
    setupMCPScopeError();
    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks edit permission', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(false);

    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('You need edit permission to manage statuses');
  });

  it('returns 400 when statusId is missing', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    const response = await DELETE(createDeleteRequest({}), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('statusId is required');
  });

  it('returns 404 when task list not found', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);

    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task list not found');
  });

  it('returns 404 when status config not found', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue(null as never);

    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Status config not found');
  });

  it('returns 400 when tasks use the status but no migrateToSlug provided', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue({
      id: 'cfg-1', slug: 'review', group: 'in_progress',
    } as never);
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([
      { id: 'task-1' }, { id: 'task-2' },
    ] as never);

    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Cannot delete a status that has tasks');
    expect(body.taskCount).toBe(2);
  });

  it('returns 400 when migration target slug not found', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst)
      .mockResolvedValueOnce({ id: 'cfg-1', slug: 'review', group: 'in_progress' } as never) // statusToDelete
      .mockResolvedValueOnce(null as never); // migration target not found
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([{ id: 'task-1' }] as never);

    const response = await DELETE(createDeleteRequest({
      statusId: 'cfg-1',
      migrateToSlug: 'nonexistent',
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Migration target status "nonexistent" not found');
  });

  it('returns 400 when deleting the last status in a group', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue({
      id: 'cfg-1', slug: 'done', group: 'done',
    } as never);
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);
    // allConfigs: only one config in the 'done' group
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { id: 'cfg-1', slug: 'done', group: 'done' },
      { id: 'cfg-2', slug: 'open', group: 'todo' },
    ] as never);

    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Cannot delete the last status in the "done" group');
  });

  it('deletes status without migration when no tasks use it', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst).mockResolvedValue({
      id: 'cfg-1', slug: 'review', group: 'in_progress',
    } as never);
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { id: 'cfg-1', slug: 'review', group: 'in_progress' },
      { id: 'cfg-2', slug: 'wip', group: 'in_progress' },
    ] as never);

    const response = await DELETE(createDeleteRequest({ statusId: 'cfg-1' }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(typeof vi.mocked(db.transaction).mock.calls[0][0]).toBe('function');
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_updated',
      data: expect.objectContaining({
        statusConfigDeleted: 'review',
        migratedTo: null,
        migratedCount: 0,
      }),
    }));
  });

  it('deletes status with task migration', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst)
      .mockResolvedValueOnce({ id: 'cfg-1', slug: 'review', group: 'in_progress' } as never) // statusToDelete
      .mockResolvedValueOnce({ id: 'cfg-2', slug: 'wip', group: 'in_progress' } as never); // migration target
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([
      { id: 'task-1' }, { id: 'task-2' },
    ] as never);
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
      { id: 'cfg-1', slug: 'review', group: 'in_progress' },
      { id: 'cfg-2', slug: 'wip', group: 'in_progress' },
    ] as never);

    const response = await DELETE(createDeleteRequest({
      statusId: 'cfg-1',
      migrateToSlug: 'wip',
    }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(typeof vi.mocked(db.transaction).mock.calls[0][0]).toBe('function');
    expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        statusConfigDeleted: 'review',
        migratedTo: 'wip',
        migratedCount: 2,
      }),
    }));
  });

  it('verifies migration target even when no tasks use the status', async () => {
    setupAuth();
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
    vi.mocked(db.query.taskStatusConfigs.findFirst)
      .mockResolvedValueOnce({ id: 'cfg-1', slug: 'review', group: 'in_progress' } as never) // statusToDelete
      .mockResolvedValueOnce(null as never); // migration target not found
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never); // no tasks

    const response = await DELETE(createDeleteRequest({
      statusId: 'cfg-1',
      migrateToSlug: 'nonexistent',
    }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Migration target status "nonexistent" not found');
  });
});
