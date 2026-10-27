import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * #1761 — Three write-path hazards in /api/mcp/documents:
 * 1. Unconditional addLineBreaksForAI corrupts CODE/markdown content on write.
 * 2. No FILE/SHEET guardrails — MCP splices lines into any page type.
 * 3. Silent current-page fallback when pageId is omitted.
 */

const mockFindFirstPage = vi.fn();
const mockApplyPageMutation = vi.fn();
const mockGetActorInfo = vi.fn();
const mockIsSheetType = vi.fn((..._args: unknown[]) => false);
const mockSetCells = vi.fn(async (..._args: unknown[]) => ({
  changed: ['A1'],
  recomputed: [] as string[],
  rowCount: 1,
  columnCount: 1,
}));
const mockReadSheetDocument = vi.fn(async (..._args: unknown[]) => null);
const mockLogSheetCellActivity = vi.fn(async (..._args: unknown[]) => undefined);

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
  isSheetType: (...args: unknown[]) => mockIsSheetType(...args),
  isValidCellAddress: vi.fn(() => true),
}));

vi.mock('@pagespace/lib/sheets/store', () => ({
  setCells: (...args: unknown[]) => mockSetCells(...args),
  readSheetDocument: (...args: unknown[]) => mockReadSheetDocument(...args),
  // The route uses this in an `instanceof` check to answer 400 rather than 500,
  // so the mock has to provide a real class.
  SheetAddressError: class SheetAddressError extends Error {},
}));

vi.mock('@/services/api/sheet-activity', () => ({
  logSheetCellActivity: (...args: unknown[]) => mockLogSheetCellActivity(...args),
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
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
  PageRevisionMismatchError: class extends Error {},
}));

vi.mock('@/services/api/task-sync-service', () => ({
  backfillMissingTaskItems: vi.fn(),
  ensureTaskListForPage: vi.fn(),
}));

vi.mock('@/lib/ai/tools/task-helpers', () => ({
  fetchEnrichedTasks: vi.fn().mockResolvedValue([]),
  serializeTaskItem: vi.fn((t: unknown) => t),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: (...args: unknown[]) => mockFindFirstPage(...args) },
      taskLists: { findFirst: vi.fn() },
      taskStatusConfigs: { findMany: vi.fn().mockResolvedValue([]) },
      channelMessages: { findMany: vi.fn() },
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  asc: vi.fn(),
  and: vi.fn(),
  count: vi.fn(),
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
  DEFAULT_TASK_STATUSES: [],
}));

vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: { pageId: 'channelMessages.pageId', isActive: 'channelMessages.isActive', createdAt: 'channelMessages.createdAt' },
}));

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
};

describe('MCP Documents API — write guardrails (#1761)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSheetType.mockReturnValue(false);
    mockGetActorInfo.mockResolvedValue({ actorEmail: 'a@b.com', actorDisplayName: 'A' });
    mockApplyPageMutation.mockResolvedValue(undefined);
  });

  describe('1. normalization must not corrupt CODE/markdown content', () => {
    it('does not run addLineBreaksForAI on a CODE page replace', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'CODE',
        contentMode: 'html',
        content: '<Foo>\n<Bar/>\n</Foo>',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 2,
        content: '<Baz/>',
      }));

      expect(response.status).toBe(200);
      const mutationCall = mockApplyPageMutation.mock.calls[0][0];
      // addLineBreaksForAI would inject newlines around block-like tags —
      // raw code content must pass through untouched apart from the edited line.
      expect(mutationCall.updates.content).toBe('<Foo>\n<Baz/>\n</Foo>');
    });

    it('does not run addLineBreaksForAI on a markdown-mode insert', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'DOCUMENT',
        contentMode: 'markdown',
        content: '# Title\n\nBody',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({
        operation: 'insert',
        pageId: 'page_123',
        startLine: 1,
        content: '<div>raw html the user typed</div>',
      }));

      expect(response.status).toBe(200);
      const mutationCall = mockApplyPageMutation.mock.calls[0][0];
      expect(mutationCall.updates.content).toBe('<div>raw html the user typed</div>\n# Title\n\nBody');
    });

    it('still normalizes HTML document writes (unchanged behavior for DOCUMENT/html)', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'DOCUMENT',
        contentMode: 'html',
        content: '<p>Hello</p>',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({
        operation: 'delete',
        pageId: 'page_123',
        startLine: 1,
        endLine: 1,
      }));

      expect(response.status).toBe(200);
      expect(mockApplyPageMutation).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. FILE/SHEET guardrails', () => {
    it('rejects replace on a FILE page', async () => {
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'FILE',
        content: 'extracted text',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 1,
        content: 'malicious overwrite',
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/FILE/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('rejects insert on a FILE page', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, type: 'FILE', content: 'x' });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'insert', pageId: 'page_123', startLine: 1, content: 'y' }));

      expect(response.status).toBe(400);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('rejects delete on a FILE page', async () => {
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, type: 'FILE', content: 'x\ny' });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'delete', pageId: 'page_123', startLine: 1 }));

      expect(response.status).toBe(400);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('rejects line-replace on a SHEET page and redirects to edit-cells', async () => {
      mockIsSheetType.mockReturnValue(true);
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'SHEET',
        content: '[cells]\nA1 = "1"',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 1,
        content: 'garbage',
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/sheet/i);
      expect(data.message ?? data.suggestion).toMatch(/edit-cells/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('still allows edit-cells on a SHEET page (guardrail only blocks line ops)', async () => {
      mockIsSheetType.mockReturnValue(true);
      mockFindFirstPage.mockResolvedValue({
        ...BASE_PAGE,
        type: 'SHEET',
        content: '[cells]\nA1 = "1"',
      });

      const { POST } = await import('../route');
      const response = await POST(makeRequest({
        operation: 'edit-cells',
        pageId: 'page_123',
        cells: [{ address: 'A1', value: '2' }],
      }));

      expect(response.status).toBe(200);
      // Addressed cell writes now, not a document mutation.
      expect(mockSetCells).toHaveBeenCalledTimes(1);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('writes only the addressed cells, never the rest of the sheet', async () => {
      // Replaces "refuses edit-cells when the sheet content could not be read".
      // That 409 guarded a read-modify-write of the whole document: a lossy
      // parse would have yielded an empty sheet and the write would have
      // replaced the spreadsheet with just these cells. The route addresses
      // cells now — there is no document read to fail, so the stronger property
      // (only the named cells are written) is asserted instead.
      mockIsSheetType.mockReturnValue(true);
      mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, type: 'SHEET', content: '' });

      const { POST } = await import('../route');
      const response = await POST(
        makeRequest({
          operation: 'edit-cells',
          pageId: 'page-1',
          cells: [{ address: 'A1', value: '2' }],
        })
      );

      expect(response.status).toBe(200);
      const [, cells] = mockSetCells.mock.calls[0];
      expect(cells).toEqual([{ address: 'A1', value: '2' }]);
    });
  });

  describe('3. pageId is required — no silent current-page fallback', () => {
    it('returns a 400 validation error when pageId is omitted on read', async () => {
      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'read' }));

      expect(response.status).toBe(400);
      expect(mockFindFirstPage).not.toHaveBeenCalled();
    });

    it('returns a 400 validation error when pageId is omitted on replace', async () => {
      const { POST } = await import('../route');
      const response = await POST(makeRequest({ operation: 'replace', startLine: 1, content: 'x' }));

      expect(response.status).toBe(400);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });
  });
});
