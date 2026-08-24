import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * #2463 — line accounting on the MCP documents route.
 *
 * The route reported `totalLines` from an intermediate array and THEN
 * normalized what it stored, so the count it returned was not the count the
 * next read produced. An agent that trusted it addressed its next edit against
 * a document eight lines shorter than the one on disk, replaced most of it,
 * and left the tail of the old content behind — invalid JSON, reported as
 * success.
 *
 * Every test here writes, then reads back what was actually stored.
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
  parseSheetContentSafe: vi.fn(),
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
  type: 'DOCUMENT',
  contentMode: 'html',
};

type PageOverrides = { type?: string; contentMode?: string; content: string };

function givenPage(overrides: PageOverrides) {
  mockFindFirstPage.mockResolvedValue({ ...BASE_PAGE, ...overrides });
}

/** The content the route actually handed to the database. */
function storedContent(): string {
  const call = mockApplyPageMutation.mock.calls.at(-1)?.[0] as { updates: { content: string } };
  return call.updates.content;
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('../route');
  const response = await POST(makeRequest(body));
  return { status: response.status, data: await response.json() };
}

/** Write, then read back what was stored — the round trip an agent performs. */
async function writeThenRead(page: PageOverrides, write: Record<string, unknown>) {
  givenPage(page);
  const written = await post({ pageId: 'page_123', ...write });
  givenPage({ ...page, content: storedContent() });
  const read = await post({ operation: 'read', pageId: 'page_123' });
  return { written, read, stored: storedContent() };
}

describe('MCP Documents API — line accounting (#2463)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockResolvedValue({ actorEmail: 'a@b.com', actorDisplayName: 'A' });
    mockApplyPageMutation.mockResolvedValue(undefined);
  });

  describe('the reported failure', () => {
    it('reports 91 lines for a 91-line replacement, not 9', async () => {
      const document = Array.from({ length: 89 }, (_, i) => `"old ${i + 1}",`).join('\n');
      const payload = Array.from({ length: 91 }, (_, i) => `"new ${i + 1}",`).join('\n');

      const { written, read } = await writeThenRead(
        { content: document },
        { operation: 'replace', startLine: 1, endLine: 89, content: payload },
      );

      expect(written.data.totalLines).toBe(91);
      expect(written.data.previousTotalLines).toBe(89);
      expect(read.data.totalLines).toBe(91);
    });

    it('leaves no stale tail behind when the whole range is replaced', async () => {
      const document = Array.from({ length: 89 }, (_, i) => `"old ${i + 1}",`).join('\n');
      const payload = '{"rewritten": true}';

      const { stored } = await writeThenRead(
        { content: document },
        { operation: 'replace', startLine: 1, endLine: 89, content: payload },
      );

      expect(stored).toBe(payload);
      expect(stored).not.toContain('old');
    });
  });

  describe('round trip: write N lines -> read -> get N lines back', () => {
    const cases = [
      {
        name: 'markdown mode',
        page: { contentMode: 'markdown', content: '# old\n\nbody' },
        payload: '# new\n\n- one\n- two\n- three',
        expectedLines: 5,
      },
      {
        name: 'html mode holding HTML',
        page: { contentMode: 'html', content: '<p>old</p>' },
        payload: '<p>one</p><p>two</p>',
        // <p>\none\n</p>\n<p>\ntwo\n</p>
        expectedLines: 6,
      },
      {
        name: 'html mode holding raw JSON (the #2463 page)',
        page: { contentMode: 'html', content: '{\n  "leads": []\n}' },
        payload: '{\n  "leads": [\n    {"name": "a"},\n    {"name": "b"}\n  ]\n}',
        expectedLines: 6,
      },
      {
        // Review catch: JSON carrying scraped markup. A "contains a tag
        // anywhere" HTML test lets the normalizer inject a newline INSIDE a
        // string value and the write path then stores it — the page ends up
        // holding invalid JSON, which is #2463's own failure mode.
        name: 'html mode holding JSON that carries scraped markup',
        page: { contentMode: 'html', content: '{\n  "leads": [{"note": "call<br>then email"}]\n}' },
        payload: '{\n  "leads": [\n    {"note": "call<br>then email"},\n    {"note": "<p>sent</p>"}\n  ]\n}',
        expectedLines: 6,
      },
      {
        name: 'html mode holding markdown',
        page: { contentMode: 'html', content: 'old report' },
        payload: '# Report\n\n- one\n- two',
        expectedLines: 4,
      },
      {
        name: 'CODE page',
        page: { type: 'CODE', contentMode: 'html', content: '<Foo/>' },
        payload: 'const a = 1;\nconst b = 2;',
        expectedLines: 2,
      },
    ];

    for (const { name, page, payload, expectedLines } of cases) {
      it(`agrees with the next read — ${name}`, async () => {
        // Address the edit the way an agent does: read first, then replace the
        // range that read reported — passing it back as the staleness guard.
        givenPage(page);
        const before = await post({ operation: 'read', pageId: 'page_123' });

        const { written, read, stored } = await writeThenRead(page, {
          operation: 'replace',
          startLine: 1,
          endLine: before.data.totalLines,
          expectedTotalLines: before.data.totalLines,
          content: payload,
        });

        expect(written.status).toBe(200);
        expect(written.data.totalLines).toBe(expectedLines);
        expect(read.data.totalLines).toBe(expectedLines);
        expect(written.data.numberedLines).toHaveLength(expectedLines);
        expect(stored.split('\n')).toHaveLength(expectedLines);
        // Anything that is not an HTML document must be stored byte-exact —
        // markdown, CODE, and an html-mode page holding JSON, tags and all.
        if (!payload.trimStart().startsWith('<')) {
          expect(stored).toBe(payload);
        }
      });
    }

    it('counts insert and delete against the stored content too', async () => {
      const inserted = await writeThenRead(
        { contentMode: 'markdown', content: 'a\nb' },
        { operation: 'insert', startLine: 2, content: 'x\ny\nz' },
      );
      expect(inserted.written.data.totalLines).toBe(5);
      expect(inserted.read.data.totalLines).toBe(5);
      expect(inserted.stored).toBe('a\nx\ny\nz\nb');

      vi.clearAllMocks();
      mockApplyPageMutation.mockResolvedValue(undefined);
      mockGetActorInfo.mockResolvedValue({ actorEmail: 'a@b.com', actorDisplayName: 'A' });

      const deleted = await writeThenRead(
        { contentMode: 'markdown', content: 'a\nb\nc\nd' },
        { operation: 'delete', startLine: 2, endLine: 3 },
      );
      expect(deleted.written.data.totalLines).toBe(2);
      expect(deleted.read.data.totalLines).toBe(2);
      expect(deleted.stored).toBe('a\nd');
    });
  });

  describe('single normalization', () => {
    it('stores content that is already the canonical projection', async () => {
      const { stored, read } = await writeThenRead(
        { content: '<p>old</p>' },
        { operation: 'replace', startLine: 1, endLine: 3, content: '<h1>Title</h1><p>Body</p>' },
      );

      // Idempotent: the read path re-normalizes what is stored, and if the
      // write had stored a non-canonical form the two counts would differ.
      const { addLineBreaksForAI } = await import('@/lib/editor/line-breaks');
      expect(addLineBreaksForAI(stored)).toBe(stored);
      expect(read.data.content).toBe(stored);
    });

    it('answers the same count the shared line-edit core computes', async () => {
      const { replaceLines } = await import('@/lib/editor/line-edit');
      const content = '<p>a</p><p>b</p>';
      const payload = '<ul><li>one</li><li>two</li></ul>';

      givenPage({ content });
      const { data } = await post({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 1,
        endLine: 6,
        content: payload,
      });

      const core = replaceLines({
        content,
        startLine: 1,
        endLine: 6,
        replacement: payload,
        isRawText: false,
      });

      expect(data.totalLines).toBe(core.newLineCount);
      expect(storedContent()).toBe(core.newContent);
    });
  });

  describe('loud refusals', () => {
    it('409s an edit addressed against a stale line count, without writing', async () => {
      const document = Array.from({ length: 89 }, (_, i) => `line ${i + 1}`).join('\n');
      givenPage({ contentMode: 'markdown', content: document });

      const { status, data } = await post({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 1,
        endLine: 81,
        content: 'new content',
        expectedTotalLines: 81,
      });

      expect(status).toBe(409);
      expect(data.message).toMatch(/89 lines/);
      expect(data.message).toMatch(/addressed against 81/);
      expect(data.totalLines).toBe(89);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('accepts the edit when the expected count is right', async () => {
      givenPage({ contentMode: 'markdown', content: 'a\nb\nc' });
      const { status } = await post({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 2,
        endLine: 2,
        content: 'B',
        expectedTotalLines: 3,
      });
      expect(status).toBe(200);
      expect(storedContent()).toBe('a\nB\nc');
    });

    it('400s an out-of-range range with the real line count, without writing', async () => {
      givenPage({ contentMode: 'markdown', content: 'a\nb\nc' });
      const { status, data } = await post({
        operation: 'replace',
        pageId: 'page_123',
        startLine: 2,
        endLine: 9,
        content: 'x',
      });

      expect(status).toBe(400);
      expect(data.totalLines).toBe(3);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('guards insert and delete the same way', async () => {
      givenPage({ contentMode: 'markdown', content: 'a\nb' });
      const insert = await post({
        operation: 'insert', pageId: 'page_123', startLine: 1, content: 'x', expectedTotalLines: 9,
      });
      expect(insert.status).toBe(409);

      givenPage({ contentMode: 'markdown', content: 'a\nb' });
      const remove = await post({
        operation: 'delete', pageId: 'page_123', startLine: 1, endLine: 1, expectedTotalLines: 9,
      });
      expect(remove.status).toBe(409);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('content-mode warning', () => {
    it('warns on read and on write for an html-mode page holding JSON', async () => {
      givenPage({ content: '{\n  "leads": []\n}' });
      const read = await post({ operation: 'read', pageId: 'page_123' });
      expect(read.data.contentModeWarning).toMatch(/html contentMode/);

      givenPage({ content: '{\n  "leads": []\n}' });
      const write = await post({
        operation: 'replace', pageId: 'page_123', startLine: 2, endLine: 2, content: '  "leads": [1],',
      });
      expect(write.data.contentModeWarning).toMatch(/html contentMode/);
    });

    it('stays silent for a real HTML document and for markdown mode', async () => {
      givenPage({ content: '<p>hello</p>' });
      const html = await post({ operation: 'read', pageId: 'page_123' });
      expect(html.data.contentModeWarning).toBeUndefined();

      givenPage({ contentMode: 'markdown', content: '# hello' });
      const markdown = await post({ operation: 'read', pageId: 'page_123' });
      expect(markdown.data.contentModeWarning).toBeUndefined();
    });
  });

  describe('<br>-laid-out documents (the totalLines: 1 report)', () => {
    // Wrapped in the paragraph Tiptap always emits, which is what such a page
    // actually holds. The <p> lines make it 20: <p>, 18 text lines, </p>.
    const brDocument = `<p>${Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join('<br>')}</p>`;

    it('numbers an 18-line <br> document by its breaks, not as one line', async () => {
      givenPage({ content: brDocument });

      const { data } = await post({ operation: 'read', pageId: 'page_123' });
      expect(data.totalLines).toBe(20);
      expect(data.numberedLines).toHaveLength(20);
      expect(data.numberedLines[4]).toContain('line 4<br>');
    });

    it('round-trips an edit to one of those lines', async () => {
      const { written, read, stored } = await writeThenRead(
        { content: brDocument },
        { operation: 'replace', startLine: 5, endLine: 5, content: 'replaced<br>' },
      );

      expect(written.data.totalLines).toBe(20);
      expect(read.data.totalLines).toBe(20);
      expect(stored).toContain('replaced<br>');
      expect(stored).not.toContain('line 4<br>');
      expect(stored).toContain('line 5<br>');
    });
  });
});
