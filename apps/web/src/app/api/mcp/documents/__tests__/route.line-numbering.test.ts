import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * #1760 — MCP documents API line numbers must be computed from the same
 * serialized content the internal read_page/replace_lines tools use
 * (serializePageContentForAI), not raw stored TipTap HTML (which has no
 * newlines and collapses a whole document to one "line").
 */

const mockFindFirstPage = vi.fn();
const mockApplyPageMutation = vi.fn();
const mockGetActorInfo = vi.fn();

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
  seedDefaultTaskStatusConfigs: vi.fn(),
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
  contentMode: 'html',
};

describe('MCP Documents API — line numbering parity (#1760)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockResolvedValue({ actorEmail: 'a@b.com', actorDisplayName: 'A' });
    mockApplyPageMutation.mockResolvedValue(undefined);
  });

  it('numbers an HTML document by its AI-serialized (line-broken) form, not raw stored HTML', async () => {
    mockFindFirstPage.mockResolvedValue({
      ...BASE_PAGE,
      type: 'DOCUMENT',
      content: '<p>First</p><p>Second</p>',
    });

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
    const data = await response.json();

    // Raw stored content has zero newlines and would collapse to 1 line —
    // the fix must expand it via the same addLineBreaksForAI normalization
    // the internal read_page/replace_lines tools use.
    expect(data.totalLines).toBeGreaterThan(1);
    expect(data.numberedLines.length).toBe(data.totalLines);
    expect(data.content).not.toBe('<p>First</p><p>Second</p>');
  });

  it('leaves CODE page content raw (unbroken) — matches internal isRawText handling', async () => {
    const codeContent = '<Foo>\n<Bar/>\n</Foo>';
    mockFindFirstPage.mockResolvedValue({
      ...BASE_PAGE,
      type: 'CODE',
      contentMode: 'html',
      content: codeContent,
    });

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
    const data = await response.json();

    // CODE pages must never be run through addLineBreaksForAI (it would mangle
    // raw markup) — line count must match the raw newline-delimited source.
    expect(data.totalLines).toBe(3);
    expect(data.content).toBe(codeContent);
  });

  it('leaves markdown contentMode content raw', async () => {
    const mdContent = '# Heading\n\nSome *text*';
    mockFindFirstPage.mockResolvedValue({
      ...BASE_PAGE,
      type: 'DOCUMENT',
      contentMode: 'markdown',
      content: mdContent,
    });

    const { POST } = await import('../route');
    const response = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
    const data = await response.json();

    expect(data.content).toBe(mdContent);
    expect(data.totalLines).toBe(3);
  });

  it('replace targets the line numbers from the serialized form, agreeing with what read returned', async () => {
    mockFindFirstPage.mockResolvedValue({
      ...BASE_PAGE,
      type: 'DOCUMENT',
      content: '<p>First</p><p>Second</p>',
    });

    const { POST } = await import('../route');

    // First, read to discover line numbers the way an MCP agent would.
    const readResponse = await POST(makeRequest({ operation: 'read', pageId: 'page_123' }));
    const readData = await readResponse.json();
    expect(readData.totalLines).toBe(6); // <p> \n First \n </p> \n <p> \n Second \n </p>

    // Replacing line 2 ("First") must succeed against that same numbering —
    // before the fix, raw content was 1 line and this would 400 as out-of-range.
    const replaceResponse = await POST(makeRequest({
      operation: 'replace',
      pageId: 'page_123',
      startLine: 2,
      content: 'Replaced',
    }));

    expect(replaceResponse.status).toBe(200);
    expect(mockApplyPageMutation).toHaveBeenCalledTimes(1);
    const mutationCall = mockApplyPageMutation.mock.calls[0][0];
    expect(mutationCall.updates.content).toContain('Replaced');
    expect(mutationCall.updates.content).not.toContain('First');
  });
});
