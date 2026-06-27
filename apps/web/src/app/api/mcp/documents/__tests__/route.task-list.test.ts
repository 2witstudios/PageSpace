import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuthenticateMCPRequest = vi.fn();
const mockGetUserAccessLevel = vi.fn();
const mockFindFirstPage = vi.fn();
const mockFindFirstTaskList = vi.fn();
const mockFindManyStatusConfigs = vi.fn();
const mockInsertReturning = vi.fn();
const mockSelectChildPages = vi.fn();
const mockBackfillMissingTaskItems = vi.fn();
const mockFetchEnrichedTasks = vi.fn();
const mockSerializeTaskItem = vi.fn();

vi.mock('@/lib/auth', () => ({
  authenticateMCPRequest: (...args: unknown[]) => mockAuthenticateMCPRequest(...args),
  isAuthError: (result: unknown) => 'error' in (result as object),
  isMCPAuthResult: (result: unknown) =>
    !('error' in (result as object)) && (result as { tokenType?: string }).tokenType === 'mcp',
  getPrincipalAccessLevel: async (_auth: unknown, _pageId: string) => ({
    canView: true,
    canEdit: false,
    canShare: false,
    canDelete: false,
  }),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: (...args: unknown[]) => mockGetUserAccessLevel(...args),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppAccessLevel: vi.fn(),
}));
vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { TASK_LIST: 'TASK_LIST' },
}));
vi.mock('@pagespace/lib/sheets/sheet', () => ({
  isSheetType: vi.fn(() => false),
  parseSheetContent: vi.fn(),
  serializeSheetContent: vi.fn(),
  updateSheetCells: vi.fn(),
  isValidCellAddress: vi.fn(() => true),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class extends Error {},
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: (...args: unknown[]) => mockFindFirstPage(...args) },
      taskLists: { findFirst: (...args: unknown[]) => mockFindFirstTaskList(...args) },
      taskStatusConfigs: { findMany: (...args: unknown[]) => mockFindManyStatusConfigs(...args) },
    },
    insert: () => ({
      values: () => ({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (..._args: unknown[]) => mockSelectChildPages(),
      }),
    }),
  },
}));

vi.mock('@/services/api/task-sync-service', () => ({
  backfillMissingTaskItems: (...args: unknown[]) => mockBackfillMissingTaskItems(...args),
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  asc: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
}));

vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: { pageId: 'taskLists.pageId' },
  taskStatusConfigs: { taskListId: 'taskStatusConfigs.taskListId', position: 'taskStatusConfigs.position' },
  DEFAULT_TASK_STATUSES: [
    { slug: 'pending', name: 'To Do', group: 'todo', position: 0, color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
    { slug: 'in_progress', name: 'In Progress', group: 'in_progress', position: 1, color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
    { slug: 'blocked', name: 'Blocked', group: 'in_progress', position: 2, color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
    { slug: 'completed', name: 'Done', group: 'done', position: 3, color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  ],
}));

vi.mock('@/lib/ai/tools/task-helpers', () => ({
  fetchEnrichedTasks: (...args: unknown[]) => mockFetchEnrichedTasks(...args),
  serializeTaskItem: (...args: unknown[]) => mockSerializeTaskItem(...args),
}));

const TASK_LIST_PAGE = {
  id: 'page_tl',
  title: 'My Task List',
  content: '',
  type: 'TASK_LIST',
  revision: 1,
  parentId: null,
  driveId: 'drive_123',
};

const DOCUMENT_PAGE = {
  id: 'page_doc',
  title: 'My Doc',
  content: 'line 1\nline 2\nline 3',
  type: 'DOCUMENT',
  revision: 1,
  parentId: null,
  driveId: 'drive_123',
};

const EXISTING_TASK_LIST = {
  id: 'tl_1',
  pageId: 'page_tl',
  userId: 'user_123',
  title: 'My Task List',
  status: 'pending',
  description: null,
  metadata: null,
};

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mcp/documents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('MCP Documents API — TASK_LIST read', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthenticateMCPRequest.mockResolvedValue({
      userId: 'user_123',
      tokenType: 'mcp',
      tokenId: 'token_123',
      role: 'user',
      tokenVersion: 1,
      adminRoleVersion: 0,
      allowedDriveIds: [],
    });

    mockFindFirstPage.mockResolvedValue(TASK_LIST_PAGE);
    mockFindFirstTaskList.mockResolvedValue(EXISTING_TASK_LIST);
    mockFindManyStatusConfigs.mockResolvedValue([]);
    mockSelectChildPages.mockResolvedValue([{ id: 'child_1' }, { id: 'child_2' }]);
    mockBackfillMissingTaskItems.mockResolvedValue(undefined);
    mockFetchEnrichedTasks.mockResolvedValue([]);
    mockSerializeTaskItem.mockImplementation((t: unknown) => t);
  });

  it('returns structured task list data AND the page body for TASK_LIST pages', async () => {
    mockFindFirstPage.mockResolvedValue({ ...TASK_LIST_PAGE, content: 'task body line 1\ntask body line 2' });

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.pageType).toBe('TASK_LIST');
    expect(data.taskListId).toBe('tl_1');
    expect(data.tasks).toBeDefined();
    expect(data.availableStatuses).toBeDefined();
    expect(data.progress).toBeDefined();
    // The page's own content body is rendered alongside the task view.
    expect(data.numberedLines).toBeDefined();
    expect(data.content).toBe('task body line 1\ntask body line 2');
    expect(data.totalLines).toBe(2);
  });

  it('returns numberedLines for non-TASK_LIST pages (regression guard)', async () => {
    mockFindFirstPage.mockResolvedValue(DOCUMENT_PAGE);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_doc' }));

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.numberedLines).toBeDefined();
    expect(data.content).toBeDefined();
    expect(data.pageType).toBeUndefined();
    expect(data.tasks).toBeUndefined();
  });

  it('auto-creates taskLists record when none exists', async () => {
    mockFindFirstTaskList.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{ ...EXISTING_TASK_LIST, id: 'tl_new' }]);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.taskListId).toBe('tl_new');
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  it('does not insert when taskLists record already exists', async () => {
    const { POST } = await import('../route');
    await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('uses custom status configs when present', async () => {
    const customConfigs = [
      { slug: 'backlog', name: 'Backlog', group: 'todo', position: 0, color: '#aaa' },
      { slug: 'shipped', name: 'Shipped', group: 'done', position: 1, color: '#0f0' },
    ];
    mockFindManyStatusConfigs.mockResolvedValue(customConfigs);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    const data = await response.json();
    expect(data.availableStatuses).toHaveLength(2);
    expect(data.availableStatuses[0].slug).toBe('backlog');
    expect(data.availableStatuses[0].label).toBe('Backlog');
    expect(data.availableStatuses[1].slug).toBe('shipped');
  });

  it('falls back to DEFAULT_TASK_STATUSES when no custom configs exist', async () => {
    mockFindManyStatusConfigs.mockResolvedValue([]);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    const data = await response.json();
    expect(data.availableStatuses).toHaveLength(4);
    expect(data.availableStatuses.map((s: { slug: string }) => s.slug)).toEqual([
      'pending', 'in_progress', 'blocked', 'completed',
    ]);
  });

  it('computes progress from task statuses', async () => {
    const enrichedTasks = [
      { id: 't1', status: 'pending', completedAt: null },
      { id: 't2', status: 'in_progress', completedAt: null },
      { id: 't3', status: 'completed', completedAt: new Date().toISOString() },
      { id: 't4', status: 'completed', completedAt: new Date().toISOString() },
    ];
    mockFetchEnrichedTasks.mockResolvedValue(enrichedTasks);
    mockSerializeTaskItem.mockImplementation((t: unknown) => t);
    // custom configs so 'completed' maps to 'done'
    mockFindManyStatusConfigs.mockResolvedValue([
      { slug: 'pending', name: 'To Do', group: 'todo', position: 0, color: '#gray' },
      { slug: 'in_progress', name: 'In Progress', group: 'in_progress', position: 1, color: '#blue' },
      { slug: 'completed', name: 'Done', group: 'done', position: 2, color: '#green' },
    ]);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    const data = await response.json();
    expect(data.progress.total).toBe(4);
    expect(data.progress.percentage).toBe(50); // 2/4 done
    expect(data.progress.byGroup.done).toBe(2);
    expect(data.progress.byGroup.in_progress).toBe(1);
    expect(data.progress.byGroup.todo).toBe(1);
    expect(data.progress.bySlug.completed).toBe(2);
    expect(data.progress.bySlug.pending).toBe(1);
  });

  it('reports 0% progress for empty task list', async () => {
    mockFetchEnrichedTasks.mockResolvedValue([]);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    const data = await response.json();
    expect(data.progress.total).toBe(0);
    expect(data.progress.percentage).toBe(0);
  });

  it('calls fetchEnrichedTasks with the correct pageId', async () => {
    const { POST } = await import('../route');
    await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    expect(mockFetchEnrichedTasks).toHaveBeenCalledWith('page_tl');
  });

  it('calls backfillMissingTaskItems with child page ids before fetching tasks', async () => {
    mockSelectChildPages.mockResolvedValue([{ id: 'cp_1' }, { id: 'cp_2' }]);

    const { POST } = await import('../route');
    await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    expect(mockBackfillMissingTaskItems).toHaveBeenCalledWith(
      expect.anything(), // db
      { parentId: 'page_tl', childPageIds: ['cp_1', 'cp_2'], userId: 'user_123' },
    );
  });

  it('skips backfill when task list has no child pages', async () => {
    mockSelectChildPages.mockResolvedValue([]);

    const { POST } = await import('../route');
    await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    expect(mockBackfillMissingTaskItems).not.toHaveBeenCalled();
  });

  it('maps enriched tasks through serializeTaskItem and adds each task description', async () => {
    const raw = [{ id: 't1', status: 'pending', completedAt: null, page: { title: 'Task 1', content: 'do the thing' } }];
    const serialized = { id: 't1', title: 'Task 1', status: 'pending' };
    mockFetchEnrichedTasks.mockResolvedValue(raw);
    mockSerializeTaskItem.mockReturnValue(serialized);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    const data = await response.json();
    expect(mockSerializeTaskItem).toHaveBeenCalledWith(raw[0]);
    // Description comes from the task's own linked page content.
    expect(data.tasks[0]).toEqual({ ...serialized, description: 'do the thing' });
  });

  it('defaults task description to empty string when the linked page has no content', async () => {
    const raw = [{ id: 't1', status: 'pending', completedAt: null }];
    const serialized = { id: 't1', title: 'Task 1', status: 'pending' };
    mockFetchEnrichedTasks.mockResolvedValue(raw);
    mockSerializeTaskItem.mockReturnValue(serialized);

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));

    const data = await response.json();
    expect(data.tasks[0]).toEqual({ ...serialized, description: '' });
  });
});
