import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * #1762 — Read-path gaps in /api/mcp/documents vs internal read_page:
 * 1. startLine/endLine ignored on read.
 * 2. No CHANNEL branch (returns empty raw content).
 * 3. No FILE processing-status handling / fileMetadata.
 * 4. TASK_LIST reads omit parentTaskList and per-task subtask counts.
 */

const mockFindFirstPage = vi.fn();
const mockFindFirstTaskList = vi.fn();
const mockFindManyStatusConfigs = vi.fn();
const mockFindManyChannelMessages = vi.fn();
const mockFetchEnrichedTasks = vi.fn();
const mockSerializeTaskItem = vi.fn();
const mockSelectFrom = vi.fn();

vi.mock('@/lib/auth', () => ({
  authenticateMCPRequest: vi.fn().mockResolvedValue({
    userId: 'user_123',
    tokenType: 'mcp',
    tokenId: 'token_123',
    role: 'user',
    tokenVersion: 1,
    adminRoleVersion: 0,
    allowedDriveIds: [],
  }),
  isAuthError: (result: unknown) => 'error' in (result as object),
  isMCPAuthResult: () => true,
  getPrincipalAccessLevel: vi.fn().mockResolvedValue({
    canView: true,
    canEdit: true,
    canShare: false,
    canDelete: false,
  }),
}));

vi.mock('@pagespace/lib/sheets/sheet', () => ({
  isSheetType: vi.fn(() => false),
  parseSheetContent: vi.fn(),
  serializeSheetContent: vi.fn(),
  updateSheetCells: vi.fn(),
  isValidCellAddress: vi.fn(() => true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => {
  const childLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    loggers: {
      api: childLogger,
      security: { warn: vi.fn() },
      ai: { ...childLogger, child: vi.fn(() => childLogger) },
    },
    logger: { child: vi.fn(() => childLogger) },
  };
});

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'a@b.com', actorDisplayName: 'A' }),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class extends Error {},
}));

vi.mock('@/services/api/task-sync-service', () => ({
  backfillMissingTaskItems: vi.fn().mockResolvedValue(undefined),
  ensureTaskListForPage: vi.fn(async (_db: unknown, params: { pageId: string }) => {
    const existing = await mockFindFirstTaskList();
    if (existing) return existing;
    return { id: 'tl_new', pageId: params.pageId };
  }),
  seedDefaultTaskStatusConfigs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ai/tools/task-helpers', () => ({
  fetchEnrichedTasks: (...args: unknown[]) => mockFetchEnrichedTasks(...args),
  serializeTaskItem: (...args: unknown[]) => mockSerializeTaskItem(...args),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: (...args: unknown[]) => mockFindFirstPage(...args) },
      taskLists: { findFirst: (...args: unknown[]) => mockFindFirstTaskList(...args) },
      taskStatusConfigs: { findMany: (...args: unknown[]) => mockFindManyStatusConfigs(...args) },
      channelMessages: { findMany: (...args: unknown[]) => mockFindManyChannelMessages(...args) },
    },
    select: (...args: unknown[]) => mockSelectFrom(...args),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  asc: vi.fn(),
  and: vi.fn(),
  count: vi.fn(() => 'count()'),
  isNotNull: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', parentId: 'pages.parentId', isTrashed: 'pages.isTrashed' },
}));

vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { pageId: 'taskItems.pageId', completedAt: 'taskItems.completedAt' },
  taskLists: { pageId: 'taskLists.pageId' },
  taskStatusConfigs: { taskListId: 'taskStatusConfigs.taskListId', position: 'taskStatusConfigs.position' },
  DEFAULT_TASK_STATUSES: [
    { slug: 'pending', name: 'To Do', group: 'todo', position: 0, color: '#gray' },
    { slug: 'in_progress', name: 'In Progress', group: 'in_progress', position: 1, color: '#amber' },
    { slug: 'blocked', name: 'Blocked', group: 'in_progress', position: 2, color: '#red' },
    { slug: 'completed', name: 'Done', group: 'done', position: 3, color: '#green' },
  ],
}));

vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: { pageId: 'channelMessages.pageId', isActive: 'channelMessages.isActive', createdAt: 'channelMessages.createdAt' },
}));

// db.select(...).from(...) is used two shapes in the route:
// - .select({id}).from(pages).where(...) — awaited directly (child-page backfill check)
// - .select({...}).from(taskItems).innerJoin(pages, ...).where(...).groupBy(...) — sub-task counts
// Make the mock support both chains off a single .from() call.
function makeChainableSelectResult(baseRows: unknown[], groupedRows: unknown[]) {
  return {
    groupBy: () => Promise.resolve(groupedRows),
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(baseRows).then(resolve, reject),
  };
}

function makeFromResult(baseRows: unknown[] = [], groupedRows: unknown[] = []) {
  return {
    where: () => makeChainableSelectResult(baseRows, groupedRows),
    innerJoin: () => ({
      where: () => makeChainableSelectResult(baseRows, groupedRows),
    }),
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mcp/documents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const BASE_PAGE = {
  id: 'page_123',
  title: 'Test Page',
  revision: 1,
  parentId: null,
  driveId: 'drive_123',
  contentMode: 'html',
};

describe('MCP Documents API — read parity (#1762)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstTaskList.mockResolvedValue(null);
    mockFindManyStatusConfigs.mockResolvedValue([]);
    mockFetchEnrichedTasks.mockResolvedValue([]);
    mockSerializeTaskItem.mockImplementation((t: unknown) => t);
    mockSelectFrom.mockReturnValue({
      from: () => makeFromResult(),
    });
  });

  describe('1. ranged reads', () => {
    it('honors startLine/endLine on a document read', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'DOCUMENT',
        content: 'line one\nline two\nline three\nline four',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123', startLine: 2, endLine: 3 }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.rangeStart).toBe(2);
      expect(data.rangeEnd).toBe(3);
      expect(data.numberedLines.length).toBe(2);
      expect(data.content).toBe('line two\nline three');
      expect(data.content).not.toContain('line one');
      expect(data.content).not.toContain('line four');
    });

    it('reports out-of-range starts without erroring', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, type: 'DOCUMENT', content: 'only line' });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123', startLine: 50 }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.numberedLines).toEqual([]);
      expect(data.rangeMessage).toBeDefined();
    });
  });

  describe('2. CHANNEL pages', () => {
    it('returns a message transcript instead of empty raw content', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, type: 'CHANNEL', content: '' });
      mockFindManyChannelMessages.mockResolvedValue([
        {
          id: 'm1',
          content: JSON.stringify({ originalContent: 'hello there' }),
          userId: 'user_123',
          aiMeta: null,
          user: { id: 'user_123', name: 'Alice' },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'm2',
          content: JSON.stringify({ originalContent: 'general kenobi' }),
          userId: null,
          aiMeta: { senderType: 'agent', senderName: 'Bot' },
          user: null,
          createdAt: new Date('2026-01-01T00:01:00.000Z'),
        },
      ]);

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.totalMessages).toBe(2);
      expect(data.content).toContain('hello there');
      expect(data.content).toContain('general kenobi');
      expect(data.numberedLines.length).toBe(2);
    });

    it('returns an empty transcript summary for a channel with no messages', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, type: 'CHANNEL', content: '' });
      mockFindManyChannelMessages.mockResolvedValue([]);

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.totalMessages).toBe(0);
      expect(data.content).toBe('');
    });
  });

  describe('3. FILE pages', () => {
    it('reports pending processing status instead of returning empty content', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'FILE',
        content: '',
        processingStatus: 'pending',
        mimeType: 'application/pdf',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('pending');
      expect(data.error).toMatch(/processed/i);
    });

    it('reports failed processing with the processingError', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'FILE',
        content: '',
        processingStatus: 'failed',
        processingError: 'OCR timed out',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
      const data = await response.json();

      expect(data.status).toBe('failed');
      expect(data.processingError).toBe('OCR timed out');
    });

    it('includes fileMetadata for a completed file read', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'FILE',
        content: 'extracted text',
        processingStatus: 'completed',
        mimeType: 'text/plain',
        fileSize: 123,
        originalFileName: 'notes.txt',
        extractionMethod: 'text',
        extractionMetadata: null,
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.fileMetadata).toBeDefined();
      expect(data.fileMetadata.mimeType).toBe('text/plain');
      expect(data.fileMetadata.originalFileName).toBe('notes.txt');
      expect(data.content).toContain('extracted text');
    });
  });

  describe('4. TASK_LIST sub-task counts and parent list', () => {
    it('includes subTaskCount/subTaskCompletedCount per task', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, id: 'page_tl', type: 'TASK_LIST', content: '' });
      mockFindFirstTaskList.mockResolvedValue({ id: 'tl_1', pageId: 'page_tl' });
      mockFetchEnrichedTasks.mockResolvedValue([
        { id: 't1', status: 'pending', completedAt: null, pageId: 'task_page_1' },
      ]);
      mockSerializeTaskItem.mockImplementation((t: { id: string; pageId: string }) => ({ id: t.id, pageId: t.pageId }));
      mockSelectFrom.mockReturnValue({
        from: () => makeFromResult([], [{ parentId: 'task_page_1', total: 3 }]),
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.tasks[0].subTaskCount).toBe(3);
      expect(data.tasks[0]).toHaveProperty('subTaskCompletedCount');
    });

    it('includes parentTaskList when nested under another TASK_LIST page', async () => {
      mockFindFirstPage.mockImplementation(async () => {
        // First call resolves the requested page; second call (inside the route)
        // resolves the parent page lookup.
        const call = mockFindFirstPage.mock.calls.length;
        if (call === 1) {
          return { ...BASE_PAGE, id: 'page_child_tl', type: 'TASK_LIST', content: '', parentId: 'page_parent_tl' };
        }
        return { id: 'page_parent_tl', title: 'Parent List', type: 'TASK_LIST' };
      });
      mockFindFirstTaskList.mockImplementation(async () => {
        const call = mockFindFirstTaskList.mock.calls.length;
        if (call === 1) return { id: 'tl_child', pageId: 'page_child_tl' };
        return { id: 'tl_parent', pageId: 'page_parent_tl' };
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_child_tl' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.parentTaskList).toBeDefined();
      expect(data.parentTaskList.pageId).toBe('page_parent_tl');
      expect(data.parentTaskList.taskListId).toBe('tl_parent');
    });

    it('parentTaskList is null for a top-level task list', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, id: 'page_tl', type: 'TASK_LIST', content: '', parentId: null });
      mockFindFirstTaskList.mockResolvedValue({ id: 'tl_1', pageId: 'page_tl' });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read', pageId: 'page_tl' }));
      const data = await response.json();

      expect(data.parentTaskList).toBeNull();
    });
  });
});
