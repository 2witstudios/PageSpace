import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// Mock database and dependencies
vi.mock('@pagespace/db/db', () => {
  const dbMock: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    selectDistinct: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    insert: vi.fn(),
    // The repair path seeds the ancestor's vocabulary and then conforms any
    // rows already in the list to it — two set-based UPDATEs that match nothing
    // in these fixtures, but still have to be callable.
    update: vi.fn(() => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })),
    query: {
      pages: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      drives: { findFirst: vi.fn() },
      taskItems: { findFirst: vi.fn() },
      taskLists: { findFirst: vi.fn() },
      taskStatusConfigs: {
        // The sweep reads the replacement statuses one at a time, directly,
        // rather than paging the vocabulary — nothing caps how many a list has.
        findFirst: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
      },
      channelMessages: { findMany: vi.fn() },
    },
  };
  // The repair runs in one transaction now: a half-applied repair is permanent,
  // because it only ever fires while the vocabulary is empty. The tx is the same
  // surface as `db` here.
  dbMock.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(dbMock));
  return { db: dbMock };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  ne: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  inArray: vi.fn(),
  notInArray: vi.fn(),
  sql: vi.fn(),
  count: vi.fn(),
  max: vi.fn(),
  min: vi.fn(),
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'id', type: 'type', contextId: 'contextId' },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    content: 'content',
    role: 'role',
    userId: 'userId',
    status: 'status',
    sourceAgentId: 'sourceAgentId',
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed' },
  drives: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { pageId: 'pageId', position: 'position' },
  taskLists: { pageId: 'pageId' },
  taskStatusConfigs: { taskListId: 'taskListId', position: 'position' },
  DEFAULT_TASK_STATUSES: [
    { slug: 'pending', name: 'To Do', color: 'bg-slate-100', group: 'todo', position: 0 },
    { slug: 'in_progress', name: 'In Progress', color: 'bg-amber-100', group: 'in_progress', position: 1 },
    { slug: 'blocked', name: 'Blocked', color: 'bg-red-100', group: 'in_progress', position: 2 },
    { slug: 'completed', name: 'Done', color: 'bg-green-100', group: 'done', position: 3 },
  ],
}));
vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: {
    pageId: 'pageId',
    isActive: 'isActive',
    createdAt: 'createdAt',
  },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    getUserAccessLevel: vi.fn(),
    getUserAccessiblePagesInDriveWithDetails: vi.fn(),
    getUserDriveAccess: vi.fn(),
    canUserViewPage: vi.fn(),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
    getPageTypeEmoji: vi.fn((_type: string) => '📄'),
    isFolderPage: vi.fn((type: string) => type === 'FOLDER'),
    isCodePage: vi.fn((type: string) => type === 'CODE'),
    getCreatablePageTypes: vi.fn(() => []),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    ai: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
    api: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/sheets/store', () => ({
  getTab: (...args: unknown[]) => mockGetTab(...args as []),
  listTabs: (...args: unknown[]) => mockListTabs(...args as []),
  readRows: (...args: unknown[]) => mockReadRows(...args as []),
}));
const mockGetTab = vi.hoisted(() => vi.fn());
const mockListTabs = vi.hoisted(() => vi.fn());
const mockReadRows = vi.hoisted(() => vi.fn());

vi.mock('../../core/image-preset-fetch', () => ({
  fetchCachedImagePreset: vi.fn(),
}));

import { pageReadTools } from '../page-read-tools';
import { db } from '@pagespace/db/db';
import { getUserAccessLevel, getUserAccessiblePagesInDriveWithDetails, getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { fetchCachedImagePreset } from '../../core/image-preset-fetch';
import type { ToolExecutionContext } from '../../core/types';

const mockDb = vi.mocked(db);
const mockGetUserAccessLevel = vi.mocked(getUserAccessLevel);
const mockGetUserAccessiblePagesInDrive = vi.mocked(getUserAccessiblePagesInDriveWithDetails);
const mockGetUserDriveAccess = vi.mocked(getUserDriveAccess);
const mockCheckDriveAccess = vi.mocked(checkDriveAccess);
const mockFetchCachedImagePreset = vi.mocked(fetchCachedImagePreset);

const createMockPage = (content: string, type = 'DOCUMENT') => ({
  id: 'page-1',
  title: 'Test Page',
  type,
  content,
  isTrashed: false,
  driveId: 'drive-1',
});

const sheetTab = { id: 'tab-1', tabIndex: 0, name: 'Sheet1', rowCount: 500, columnCount: 16 };

const createAuthContext = (userId = 'user-123') => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

// Helper for mock access levels - getUserAccessLevel returns an object with permission booleans
const createMockAccessLevel = (level: 'viewer' | 'editor' | 'admin') => ({
  canView: true,
  canEdit: level === 'editor' || level === 'admin',
  canShare: level === 'admin',
  canDelete: level === 'admin',
});


/**
 * Chainable drizzle SELECT stub.
 *
 * The unified-message readers join `conversations` to derive the page from
 * `contextId` (epic "Agent-Session Single Source of Truth", Phase 4 / D6 —
 * reader cutover), so a mocked chain must tolerate `.innerJoin(...)` between
 * `.from(...)` and `.where(...)`. Non-terminal steps return the chain; the
 * terminals a given test needs are supplied by name.
 */
function mockSelectChain(terminals: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  for (const step of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit']) {
    chain[step] = vi.fn(() => chain);
  }
  for (const [name, value] of Object.entries(terminals)) {
    chain[name] = vi.fn().mockResolvedValue(value);
  }
  return chain;
}

describe('page-read-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_pages', () => {
    it('has correct tool definition', () => {
      expect(pageReadTools.list_pages).toBeDefined();
      expect(pageReadTools.list_pages.description).toContain('List');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.list_pages.execute!({ driveId: 'drive-1' }, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when actor has no accessible pages in drive', async () => {
      mockGetUserAccessiblePagesInDrive.mockResolvedValue([]);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageReadTools.list_pages.execute!(
        { driveId: 'non-existent', driveSlug: 'test-drive' },
        context
      );
      expect(result).toMatchObject({ success: false });
    });

    // driveId used to be required, which pushed the model into guessing a
    // workspace whenever it didn't have one in its arguments.
    describe('resolving an omitted driveId', () => {
      const contextInDrive = (driveId: string) => ({
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId: 'user-123',
          locationContext: { currentDrive: { id: driveId, name: 'Work', slug: 'work' } },
        } as ToolExecutionContext,
      });

      const allowDrive = () => {
        mockGetUserDriveAccess.mockResolvedValue(true as unknown as never);
        mockGetUserAccessiblePagesInDrive.mockResolvedValue([] as unknown as never);
        (mockDb.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        });
      };

      // The echo matters: a defaulted scope that looked in the wrong workspace
      // returns an empty list, and an empty list reads as "it doesn't exist"
      // unless the model can see where we actually looked.
      it('lists the workspace in view and echoes the scope it used', async () => {
        allowDrive();

        const result = await pageReadTools.list_pages.execute!(
          {},
          contextInDrive('drive-loc')
        ) as Record<string, unknown>;

        expect(result).toMatchObject({
          success: true,
          driveId: 'drive-loc',
          scopeSource: 'current_location',
        });
      });

      it('marks an explicitly supplied driveId as an explicit scope', async () => {
        allowDrive();

        const result = await pageReadTools.list_pages.execute!(
          { driveId: 'drive-explicit' },
          contextInDrive('drive-loc')
        ) as Record<string, unknown>;

        expect(result).toMatchObject({ driveId: 'drive-explicit', scopeSource: 'explicit' });
      });

      it('asks rather than guessing when no workspace is in view', async () => {
        allowDrive();

        await expect(
          pageReadTools.list_pages.execute!({}, createAuthContext())
        ).rejects.toThrow('no workspace is currently in view');
      });

      // Defaulting must not widen reach.
      it('still denies a defaulted drive the actor cannot access', async () => {
        mockGetUserDriveAccess.mockResolvedValue(false as unknown as never);

        const result = await pageReadTools.list_pages.execute!(
          {},
          contextInDrive('drive-forbidden')
        ) as Record<string, unknown>;

        expect(result.success).toBe(false);
        // driveSlug is absent on a defaulted scope — the message must not say "undefined".
        expect(result.error).toContain('drive-forbidden');
      });
    });

    describe('ls-mode navigation (new behavior)', () => {
      const driveSlug = 'my-drive';
      const driveId = 'drive-1';

      const rootFolder = { id: 'folder-1', title: 'Docs', type: 'FOLDER', parentId: null, position: 1, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };
      const rootDoc = { id: 'doc-1', title: 'README', type: 'DOCUMENT', parentId: null, position: 2, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };
      const childPage = { id: 'child-1', title: 'Setup Guide', type: 'DOCUMENT', parentId: 'folder-1', position: 1, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };

      const setupDriveAccess = () => {
        mockGetUserDriveAccess.mockResolvedValue(true as unknown as never);
        mockGetUserAccessiblePagesInDrive.mockResolvedValue([rootFolder, rootDoc, childPage] as unknown as never);
        (mockDb.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        });
      };

      it('returns only root-level pages when no parentId supplied', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug },
          createAuthContext()
        ) as Record<string, unknown>;

        assert({
          given: 'list_pages with no parentId',
          should: 'return success',
          actual: result.success,
          expected: true,
        });

        const pages = result.pages as Array<{ id: string }>;
        assert({
          given: 'list_pages with no parentId',
          should: 'return only root-level pages (2, not 3)',
          actual: pages.length,
          expected: 2,
        });

        assert({
          given: 'list_pages with no parentId',
          should: 'not include nested child page',
          actual: pages.some(p => p.id === 'child-1'),
          expected: false,
        });
      });

      it('treats parentId: "" the same as omitting parentId at drive root', async () => {
        setupDriveAccess();
        const omittedResult = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug },
          createAuthContext()
        ) as Record<string, unknown>;
        const emptyStringResult = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, parentId: '' },
          createAuthContext()
        ) as Record<string, unknown>;

        assert({
          given: 'list_pages with parentId: "" at drive root',
          should: 'return success',
          actual: emptyStringResult.success,
          expected: true,
        });

        const omittedPageIds = (omittedResult.pages as Array<{ id: string }>).map(p => p.id).sort();
        const emptyStringPageIds = (emptyStringResult.pages as Array<{ id: string }>).map(p => p.id).sort();

        assert({
          given: 'list_pages with parentId: "" at drive root',
          should: 'return the same pages as omitting parentId',
          actual: emptyStringPageIds,
          expected: omittedPageIds,
        });

        assert({
          given: 'list_pages with parentId: "" at drive root',
          should: 'return the same location as omitting parentId',
          actual: emptyStringResult.location,
          expected: omittedResult.location,
        });

        assert({
          given: 'list_pages with parentId: "" at drive root',
          should: 'not include the nested child page',
          actual: emptyStringPageIds.includes('child-1'),
          expected: false,
        });
      });

      it('includes hasChildren flag indicating whether folder has children', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug },
          createAuthContext()
        ) as Record<string, unknown>;

        const pages = result.pages as Array<{ id: string; hasChildren: boolean }>;
        const folder = pages.find(p => p.id === 'folder-1');
        const doc = pages.find(p => p.id === 'doc-1');

        assert({
          given: 'a folder that has children',
          should: 'have hasChildren: true',
          actual: folder?.hasChildren,
          expected: true,
        });

        assert({
          given: 'a document with no children',
          should: 'have hasChildren: false',
          actual: doc?.hasChildren,
          expected: false,
        });
      });

      it('returns only children of parentId when supplied', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, parentId: 'folder-1' },
          createAuthContext()
        ) as Record<string, unknown>;

        const pages = result.pages as Array<{ id: string }>;
        assert({
          given: 'list_pages with parentId = folder-1',
          should: 'return only direct children of that folder',
          actual: pages.length,
          expected: 1,
        });

        assert({
          given: 'list_pages with parentId = folder-1',
          should: 'return the child page',
          actual: pages[0]?.id,
          expected: 'child-1',
        });
      });

      it('returns error when parentId is not accessible', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, parentId: 'nonexistent-id' },
          createAuthContext()
        ) as Record<string, unknown>;

        assert({
          given: 'list_pages with inaccessible parentId',
          should: 'return success: false',
          actual: result.success,
          expected: false,
        });
      });

      it('returns all pages when recursive is true', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, recursive: true },
          createAuthContext()
        ) as Record<string, unknown>;

        const pages = result.pages as Array<{ id: string }>;
        assert({
          given: 'list_pages with recursive: true',
          should: 'return all 3 pages',
          actual: pages.length,
          expected: 3,
        });
      });

      it('includes totalInDrive to signal overall drive scale', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug },
          createAuthContext()
        ) as Record<string, unknown>;

        assert({
          given: 'list_pages',
          should: 'include totalInDrive count',
          actual: result.totalInDrive,
          expected: 3,
        });
      });

      it('includes breadcrumb when parentId is supplied', async () => {
        setupDriveAccess();
        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, parentId: 'folder-1' },
          createAuthContext()
        ) as Record<string, unknown>;

        const breadcrumb = result.breadcrumb as Array<{ id: string; title: string }>;
        assert({
          given: 'list_pages navigating into a folder',
          should: 'include breadcrumb with parent folder',
          actual: breadcrumb.length,
          expected: 1,
        });

        assert({
          given: 'breadcrumb entry',
          should: 'contain folder id and title',
          actual: breadcrumb[0],
          expected: { id: 'folder-1', title: 'Docs' },
        });
      });
    });

    describe('include=content', () => {
      const driveSlug = 'my-drive';
      const driveId = 'drive-1';

      const docPage = { id: 'doc-1', title: 'README', type: 'DOCUMENT', parentId: null, position: 1, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };
      const codePage = { id: 'code-1', title: 'index.ts', type: 'CODE', parentId: null, position: 2, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };
      const taskListPage = { id: 'tasks-1', title: 'Sprint Tasks', type: 'TASK_LIST', parentId: null, position: 3, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };
      const channelPage = { id: 'channel-1', title: 'General', type: 'CHANNEL', parentId: null, position: 4, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };
      const filePage = { id: 'file-1', title: 'report.pdf', type: 'FILE', parentId: null, position: 5, driveId, isTrashed: false, permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } };

      const setupDriveAccessWithContent = (
        visiblePages: unknown[],
        contentRows: Array<{ id: string; content: string; contentMode: string; type: string }>,
      ) => {
        mockGetUserDriveAccess.mockResolvedValue(true as unknown as never);
        mockGetUserAccessiblePagesInDrive.mockResolvedValue(visiblePages as unknown as never);
        (mockDb.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        });
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(contentRows),
          }),
        });
      };

      it('returns content for a DOCUMENT and CODE page', async () => {
        setupDriveAccessWithContent(
          [docPage, codePage],
          [
            { id: 'doc-1', content: 'Hello world', contentMode: 'html', type: 'DOCUMENT' },
            { id: 'code-1', content: 'export const x = 1;', contentMode: 'markdown', type: 'CODE' },
          ],
        );

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as { pages: Array<{ id: string; content?: string; contentOmitted?: string }> };

        const doc = result.pages.find(p => p.id === 'doc-1');
        const code = result.pages.find(p => p.id === 'code-1');

        assert({
          given: 'include=content with a DOCUMENT page',
          should: 'attach serialized content',
          actual: doc?.content,
          expected: 'Hello world',
        });

        assert({
          given: 'include=content with a CODE page',
          should: 'attach raw content untouched',
          actual: code?.content,
          expected: 'export const x = 1;',
        });

        assert({
          given: 'text-serializable pages',
          should: 'not set contentOmitted',
          actual: [doc?.contentOmitted, code?.contentOmitted],
          expected: [undefined, undefined],
        });
      });

      it('omits content with a reason for TASK_LIST, CHANNEL, and FILE pages', async () => {
        setupDriveAccessWithContent(
          [taskListPage, channelPage, filePage],
          [
            { id: 'tasks-1', content: '', contentMode: 'html', type: 'TASK_LIST' },
            { id: 'channel-1', content: '', contentMode: 'html', type: 'CHANNEL' },
            { id: 'file-1', content: '', contentMode: 'html', type: 'FILE' },
          ],
        );

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as { pages: Array<{ id: string; content?: string; contentOmitted?: string }> };

        for (const id of ['tasks-1', 'channel-1', 'file-1']) {
          const entry = result.pages.find(p => p.id === id);
          assert({
            given: `a structured page type (${id})`,
            should: 'not include a content field',
            actual: entry?.content,
            expected: undefined,
          });
          assert({
            given: `a structured page type (${id})`,
            should: 'include a contentOmitted explanation',
            actual: typeof entry?.contentOmitted,
            expected: 'string',
          });
        }
      });

      it('reports the guardrail when the page count exceeds the content cap', async () => {
        const manyPages = Array.from({ length: 60 }, (_, i) => ({
          id: `page-${i}`,
          title: `Page ${i}`,
          type: 'DOCUMENT',
          parentId: null,
          position: i,
          driveId,
          isTrashed: false,
          permissions: { canView: true, canEdit: true, canShare: false, canDelete: false },
        }));
        const contentRows = manyPages
          .slice(0, 50)
          .map(p => ({ id: p.id, content: 'x', contentMode: 'html', type: 'DOCUMENT' }));

        setupDriveAccessWithContent(manyPages, contentRows);

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as {
          pages: Array<{ id: string; content?: string }>;
          contentTruncated: boolean;
          contentPageCap: number;
          nextSteps: string[];
        };

        assert({
          given: '60 pages with include=content and a cap of 50',
          should: 'flag contentTruncated as true',
          actual: result.contentTruncated,
          expected: true,
        });

        assert({
          given: '60 pages with include=content',
          should: 'only attach content to the first 50 pages',
          actual: result.pages.filter(p => p.content !== undefined).length,
          expected: 50,
        });

        assert({
          given: 'truncated content batch',
          should: 'report what was dropped in nextSteps rather than staying silent',
          actual: result.nextSteps.some(s => s.includes('50') && s.includes('60')),
          expected: true,
        });
      });

      it('clips a single page whose content exceeds the per-page character cap', async () => {
        const hugeContent = 'x'.repeat(10000);
        setupDriveAccessWithContent(
          [docPage],
          [{ id: 'doc-1', content: hugeContent, contentMode: 'html', type: 'DOCUMENT' }],
        );

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as {
          pages: Array<{ id: string; content?: string; contentClipped?: boolean; contentClippedAfterLine?: number }>;
          contentClippedCount: number;
          contentCharCapPerPage: number;
          nextSteps: string[];
        };

        const doc = result.pages.find(p => p.id === 'doc-1');

        assert({
          given: 'a page whose content exceeds the per-page char cap with no newlines to cut at',
          should: 'fall back to a hard clip at the cap length',
          actual: doc?.content?.length,
          expected: result.contentCharCapPerPage,
        });

        assert({
          given: 'a clipped page',
          should: 'flag contentClipped: true on that entry',
          actual: doc?.contentClipped,
          expected: true,
        });

        assert({
          given: 'a clipped page with no newlines',
          should: 'report a single-line contentClippedAfterLine',
          actual: doc?.contentClippedAfterLine,
          expected: 1,
        });

        assert({
          given: 'a batch with one clipped page',
          should: 'report contentClippedCount',
          actual: result.contentClippedCount,
          expected: 1,
        });

        assert({
          given: 'a batch with a clipped page',
          should: 'mention the clip in nextSteps rather than staying silent',
          actual: result.nextSteps.some(s => s.includes('clipped')),
          expected: true,
        });
      });

      it('cuts a clipped page at the last newline instead of mid-line', async () => {
        // 900 lines of 10 chars + newline = 9900 chars, over the 8000 cap.
        // The clip should land on a line boundary, not mid-line.
        const lines = Array.from({ length: 900 }, (_, i) => `line${String(i).padStart(5, '0')}`);
        const longContent = lines.join('\n');

        setupDriveAccessWithContent(
          [docPage],
          [{ id: 'doc-1', content: longContent, contentMode: 'html', type: 'DOCUMENT' }],
        );

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as {
          pages: Array<{ id: string; content?: string; contentClipped?: boolean; contentClippedAfterLine?: number }>;
        };

        const doc = result.pages.find(p => p.id === 'doc-1');
        const clippedLines = doc?.content?.split('\n') ?? [];

        assert({
          given: 'clipped content cut at a newline boundary',
          should: 'not end mid-line (every line is a full "lineNNNNN" token)',
          actual: clippedLines.every(l => /^line\d{5}$/.test(l)),
          expected: true,
        });

        assert({
          given: 'clipped content cut at a newline boundary',
          should: 'stay under the char cap',
          actual: (doc?.content?.length ?? Infinity) <= 8000,
          expected: true,
        });

        assert({
          given: '900 ten-char lines clipped at an 8000-char cap (800 full lines fit exactly)',
          should: 'keep exactly 800 complete lines',
          actual: clippedLines.length,
          expected: 800,
        });

        assert({
          given: 'clipped content cut at a newline boundary',
          should: 'report contentClippedAfterLine matching the number of lines kept',
          actual: doc?.contentClippedAfterLine,
          expected: clippedLines.length,
        });
      });

      it('does not clip content exactly at the per-page character cap', async () => {
        const exactContent = 'x'.repeat(8000);
        setupDriveAccessWithContent(
          [docPage],
          [{ id: 'doc-1', content: exactContent, contentMode: 'html', type: 'DOCUMENT' }],
        );

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as {
          pages: Array<{ id: string; content?: string; contentClipped?: boolean }>;
          contentClippedCount: number;
        };

        const doc = result.pages.find(p => p.id === 'doc-1');

        assert({
          given: 'content exactly at the per-page char cap (not exceeding it)',
          should: 'not be clipped',
          actual: doc?.contentClipped,
          expected: undefined,
        });

        assert({
          given: 'content exactly at the per-page char cap',
          should: 'keep the full content',
          actual: doc?.content?.length,
          expected: 8000,
        });

        assert({
          given: 'content exactly at the per-page char cap',
          should: 'report contentClippedCount of 0',
          actual: result.contentClippedCount,
          expected: 0,
        });
      });

      it('does not truncate content when exactly at the page-count cap (50 pages)', async () => {
        const exactlyFiftyPages = Array.from({ length: 50 }, (_, i) => ({
          id: `page-${i}`,
          title: `Page ${i}`,
          type: 'DOCUMENT',
          parentId: null,
          position: i,
          driveId,
          isTrashed: false,
          permissions: { canView: true, canEdit: true, canShare: false, canDelete: false },
        }));
        const contentRows = exactlyFiftyPages.map(p => ({ id: p.id, content: 'x', contentMode: 'html', type: 'DOCUMENT' }));

        setupDriveAccessWithContent(exactlyFiftyPages, contentRows);

        const result = await pageReadTools.list_pages.execute!(
          { driveId, driveSlug, include: 'content' },
          createAuthContext()
        ) as {
          pages: Array<{ id: string; content?: string }>;
          contentTruncated: boolean;
        };

        assert({
          given: 'exactly 50 pages (the page-count cap) with include=content',
          should: 'not flag contentTruncated',
          actual: result.contentTruncated,
          expected: false,
        });

        assert({
          given: 'exactly 50 pages with include=content',
          should: 'attach content to all 50 pages',
          actual: result.pages.filter(p => p.content !== undefined).length,
          expected: 50,
        });
      });
    });

  });

  describe('list_trash', () => {
    it('has correct tool definition', () => {
      expect(pageReadTools.list_trash).toBeDefined();
      expect(pageReadTools.list_trash.description).toContain('trash');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.list_trash.execute!({ driveSlug: 'my-drive', driveId: 'drive-1' }, context)
      ).rejects.toThrow('User authentication required');
    });

    // Regression test for #1774: list_trash's output had no page id, so an
    // agent that just listed trash had nothing to pass to restore_page (which
    // requires { id }) — it could see a trashed page but not restore it.
    it('includes the page id for each trashed page, so restore_page can act on it', async () => {
      mockCheckDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, drive: null });
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                id: 'page-trashed-1',
                title: 'Old Notes',
                type: 'DOCUMENT',
                trashedAt: new Date('2026-01-01'),
                parentId: null,
                position: 0,
                driveId: 'drive-1',
              },
            ]),
          }),
        }),
      });

      const result = await pageReadTools.list_trash.execute!(
        { driveSlug: 'my-drive', driveId: 'drive-1' },
        createAuthContext()
      ) as Record<string, unknown>;

      const trashedPages = result.trashedPages as Array<{ id: string; title: string }>;
      assert({
        given: 'list_trash result',
        should: 'include the id of each trashed page',
        actual: trashedPages[0]?.id,
        expected: 'page-trashed-1',
      });
    });

    // ========================================================================
    // Regression coverage for #1772: list_trash only required drive
    // membership, unlike GET /api/drives/[driveId]/trash which requires
    // owner/admin. The bars must agree.
    // ========================================================================
    it('denies a plain drive member (not owner or admin) from listing trash', async () => {
      mockCheckDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: true, drive: null });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'member-user' } as ToolExecutionContext,
      };

      await expect(
        pageReadTools.list_trash.execute!(
          { driveSlug: 'my-drive', driveId: 'drive-1' },
          context
        )
      ).rejects.toThrow('Only drive owners and admins');
    });

    it('allows the drive owner to list trash', async () => {
      mockCheckDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, drive: null });
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue(
        mockSelectChain({ orderBy: [] }),
      );

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'owner-user' } as ToolExecutionContext,
      };

      const result = await pageReadTools.list_trash.execute!(
        { driveSlug: 'my-drive', driveId: 'drive-1' },
        context
      ) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe('read_page', () => {
    it('has correct tool definition', () => {
      expect(pageReadTools.read_page).toBeDefined();
      expect(pageReadTools.read_page.description).toContain('Read');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'non-existent' },
          context
        )
      ).rejects.toThrow('Page with ID "non-existent" not found');
    });

    it('returns a SHEET as bounded rows, not as thousands of lines of TOML', async () => {
      // The defect in issue #2467: a 500-row sheet came back as ~23,700
      // numbered lines of SheetDoc TOML, one table per cell, with no way to ask
      // for a row range. What comes back now is the sheet's shape plus a window.
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'SHEET'));
      mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      mockListTabs.mockResolvedValue([sheetTab]);
      mockGetTab.mockResolvedValue(sheetTab);
      mockReadRows.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => ({
          rowIndex: index,
          cells: { A: { raw: `row-${index}`, value: `row-${index}` } },
        })),
      );

      const result = await pageReadTools.read_page.execute!(
        { title: 'Members', pageId: 'page-1' },
        createAuthContext()
      ) as Record<string, unknown>;

      assert({
        given: 'a 500-row sheet read with no range',
        should: 'report its true dimensions and return only the preview window',
        actual: { dimensions: result.dimensions, rowsReturned: result.rowsReturned },
        expected: { dimensions: { rowCount: 500, columnCount: 16 }, rowsReturned: 25 },
      });
      // 25 rows + one column header line, not 23,715 lines of TOML.
      expect(String(result.content).split('\n')).toHaveLength(26);
      expect(String(result.content)).not.toContain('PAGESPACE_SHEETDOC');
      expect(result.hasMoreRows).toBe(true);
      expect(String((result.nextSteps as string[]).join(' '))).toContain('read_sheet');
    });

    it('reads lineStart/lineEnd on a SHEET as row numbers', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'SHEET'));
      mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      mockListTabs.mockResolvedValue([sheetTab]);
      mockGetTab.mockResolvedValue(sheetTab);
      mockReadRows.mockResolvedValue([
        { rowIndex: 4, cells: { A: { raw: 'five', value: 'five' } } },
        { rowIndex: 5, cells: { A: { raw: 'six', value: 'six' } } },
      ]);

      const result = await pageReadTools.read_page.execute!(
        { title: 'Members', pageId: 'page-1', lineStart: 5, lineEnd: 6 },
        createAuthContext()
      ) as Record<string, unknown>;

      const [, options] = mockReadRows.mock.calls[0] as [string, { fromRow: number; limit: number }];
      assert({
        given: 'lineStart 5 and lineEnd 6 on a sheet',
        should: 'fetch rows 5 and 6, translating to the store\'s 0-based index',
        actual: options,
        expected: { fromRow: 4, limit: 2 },
      });
      expect(result.content).toBe('columns→A\n5→five\n6→six');
    });

    it('clips a sparse sheet window to the requested last row', async () => {
      // Rows are sparse — rows 1-10 then 500-509 is a normal shape — so a
      // window that starts inside the range can still run past its end.
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'SHEET'));
      mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      mockListTabs.mockResolvedValue([sheetTab]);
      mockGetTab.mockResolvedValue(sheetTab);
      mockReadRows.mockResolvedValue([
        { rowIndex: 0, cells: { A: { raw: 'one', value: 'one' } } },
        { rowIndex: 400, cells: { A: { raw: 'far', value: 'far' } } },
      ]);

      const result = await pageReadTools.read_page.execute!(
        { title: 'Members', pageId: 'page-1', lineStart: 1, lineEnd: 2 },
        createAuthContext()
      ) as Record<string, unknown>;

      expect((result.rows as { rowNumber: number }[]).map(row => row.rowNumber)).toEqual([1]);
    });

    it('keeps formulas and errors reachable on a SHEET read', async () => {
      // The spreadsheets skill documents reading a sheet back to confirm a
      // formula was stored and to see the expected cross-page-reference error.
      // A read that showed only computed values would break that workflow and
      // could not tell "5" from "=2+3".
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'SHEET'));
      mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      mockListTabs.mockResolvedValue([sheetTab]);
      mockGetTab.mockResolvedValue(sheetTab);
      mockReadRows.mockResolvedValue([
        {
          rowIndex: 3,
          cells: {
            B: { raw: '=SUM(B2:B3)', value: 2200 },
            C: { raw: '=OTHER!A1', error: { type: 'error', message: 'Cross-page references are not supported in this context' } },
          },
        },
      ]);

      const result = await pageReadTools.read_page.execute!(
        { title: 'Budget', pageId: 'page-1' },
        createAuthContext()
      ) as Record<string, unknown>;

      expect(result.formulas).toEqual({ B4: '=SUM(B2:B3)', C4: '=OTHER!A1' });
      expect(result.errors).toEqual({
        C4: 'Cross-page references are not supported in this context',
      });
    });

    it('returns channel messages when reading a CHANNEL page', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'CHANNEL'));
      mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
      mockDb.query.channelMessages = {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'msg-1',
            content: 'First channel message',
            createdAt: new Date('2025-01-15T10:00:00.000Z'),
            userId: 'user-1',
            aiMeta: null,
            user: { id: 'user-1', name: 'Alice' },
          },
          {
            id: 'msg-2',
            content: 'AI follow-up',
            createdAt: new Date('2025-01-15T10:05:00.000Z'),
            userId: 'user-2',
            aiMeta: { senderType: 'global_assistant', senderName: 'Assistant' },
            user: { id: 'user-2', name: 'Bob' },
          },
        ]),
      } as unknown as typeof mockDb.query.channelMessages;
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));

      const result = await pageReadTools.read_page.execute!(
        { title: 'General', pageId: 'page-1' },
        createAuthContext()
      );

      assert({
        given: 'a CHANNEL page with two messages',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'a CHANNEL page',
        should: 'return messageCount for messages read',
        actual: (result as { messageCount: number }).messageCount,
        expected: 2,
      });

      assert({
        given: 'channel output',
        should: 'include formatted assistant attribution in transcript',
        actual: (result as { content: string }).content.includes('[assistant] Assistant'),
        expected: true,
      });

      assert({
        given: 'channel output',
        should: 'include structured channelMessages array',
        actual: Array.isArray((result as { channelMessages: unknown[] }).channelMessages),
        expected: true,
      });
    });

    describe('visual FILE pages', () => {
      const createMockVisualFilePage = () => ({
        id: 'page-1',
        title: 'diagram.png',
        type: 'FILE',
        isTrashed: false,
        driveId: 'drive-1',
        processingStatus: 'visual',
        mimeType: 'image/png',
        contentHash: 'hash-abc',
        fileSize: 5000,
        originalFileName: 'diagram.png',
      });

      const createVisionAuthContext = (userId = 'user-123') => ({
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId,
          modelCapabilities: { hasVision: true, hasTools: true, model: 'gpt-5.4', provider: 'openai' },
        } as ToolExecutionContext,
      });

      beforeEach(() => {
        mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
        mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      });

      it('returns delivered image content for a visual FILE page on a vision-capable model', async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockVisualFilePage());
        mockFetchCachedImagePreset.mockResolvedValue({
          base64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
          mediaType: 'image/jpeg',
          preset: 'ai-vision',
        });

        const result = await pageReadTools.read_page.execute!(
          { title: 'diagram.png', pageId: 'page-1' },
          createVisionAuthContext()
        ) as { type: string; imageBase64: string; mimeType: string; originalMimeType: string; success: boolean };

        assert({
          given: 'a visual FILE page and a vision-capable model',
          should: 'return a visual_content_delivered result',
          actual: result.type,
          expected: 'visual_content_delivered',
        });

        assert({
          given: 'a visual FILE page and a vision-capable model',
          should: 'deliver the base64 bytes from fetchCachedImagePreset',
          actual: result.imageBase64,
          expected: 'ZmFrZS1pbWFnZS1ieXRlcw==',
        });

        assert({
          given: 'a visual FILE page and a vision-capable model',
          should: "deliver the fetched preset's mediaType rather than the page's declared mimeType",
          actual: result.mimeType,
          expected: 'image/jpeg',
        });

        assert({
          given: "a visual FILE page whose delivered preset was re-encoded to a different format (png page, jpeg preset)",
          should: "still carry the page's true mimeType as originalMimeType, for correct reporting if this result later degrades to metadata-only",
          actual: result.originalMimeType,
          expected: 'image/png',
        });
      });

      it('falls back to metadata-only when no cached preset is available', async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockVisualFilePage());
        mockFetchCachedImagePreset.mockResolvedValue(null);

        const result = await pageReadTools.read_page.execute!(
          { title: 'diagram.png', pageId: 'page-1' },
          createVisionAuthContext()
        ) as { type: string };

        assert({
          given: 'a visual FILE page with no usable cached preset',
          should: 'fall back to the existing visual_content_metadata result',
          actual: result.type,
          expected: 'visual_content_metadata',
        });
      });
    });

    describe('line range support', () => {
      const tenLineContent = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage(tenLineContent));
        mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
        mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      });

      it('returns full content when no line params provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1' },
          createAuthContext()
        );

        assert({
          given: 'no lineStart or lineEnd params',
          should: 'return all 10 lines',
          actual: (result as { lineCount: number }).lineCount,
          expected: 10,
        });
      });

      it('returns lines in range when lineStart and lineEnd provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 3, lineEnd: 5 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=3 and lineEnd=5',
          should: 'return only lines 3-5',
          actual: (result as { content: string }).content,
          expected: '3→line3\n4→line4\n5→line5',
        });
      });

      it('returns from lineStart to end when only lineStart provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 8 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=8 with no lineEnd',
          should: 'return lines 8 through end',
          actual: (result as { content: string }).content,
          expected: '8→line8\n9→line9\n10→line10',
        });
      });

      it('returns from start to lineEnd when only lineEnd provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineEnd: 3 },
          createAuthContext()
        );

        assert({
          given: 'lineEnd=3 with no lineStart',
          should: 'return lines 1 through 3',
          actual: (result as { content: string }).content,
          expected: '1→line1\n2→line2\n3→line3',
        });
      });

      it('returns empty content with message when lineStart exceeds total lines', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 15 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=15 on a 10-line document',
          should: 'return empty content',
          actual: (result as { content: string }).content,
          expected: '',
        });

        assert({
          given: 'lineStart exceeds total lines',
          should: 'include message about range',
          actual: (result as { rangeMessage?: string }).rangeMessage,
          expected: 'Requested range (15-10) is beyond document length (10 lines)',
        });
      });

      it('clamps lineEnd to actual document length', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 8, lineEnd: 15 },
          createAuthContext()
        );

        assert({
          given: 'lineEnd=15 exceeding document length',
          should: 'return lines 8-10 (clamped)',
          actual: (result as { content: string }).content,
          expected: '8→line8\n9→line9\n10→line10',
        });
      });

      it('returns error when lineStart greater than lineEnd', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 5, lineEnd: 3 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=5 and lineEnd=3 (invalid range)',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });

        assert({
          given: 'invalid line range',
          should: 'include error message',
          actual: (result as { error?: string }).error,
          expected: 'Invalid line range: lineStart (5) cannot be greater than lineEnd (3)',
        });
      });

      it('returns error when lineStart is negative', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: -1 },
          createAuthContext()
        );

        assert({
          given: 'negative lineStart',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });

        assert({
          given: 'negative lineStart',
          should: 'include error message about valid range',
          actual: (result as { error?: string }).error,
          expected: 'Invalid line range: line numbers must be positive integers',
        });
      });

      it('returns error when lineEnd is negative', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineEnd: -5 },
          createAuthContext()
        );

        assert({
          given: 'negative lineEnd',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });
      });

      it('includes rangeStart and rangeEnd in response', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 3, lineEnd: 7 },
          createAuthContext()
        );

        assert({
          given: 'line range request',
          should: 'include rangeStart in response',
          actual: (result as { rangeStart?: number }).rangeStart,
          expected: 3,
        });

        assert({
          given: 'line range request',
          should: 'include rangeEnd in response',
          actual: (result as { rangeEnd?: number }).rangeEnd,
          expected: 7,
        });
      });

      it('includes totalLines in response for context', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 3, lineEnd: 5 },
          createAuthContext()
        );

        assert({
          given: 'line range request',
          should: 'include totalLines for context',
          actual: (result as { totalLines?: number }).totalLines,
          expected: 10,
        });
      });
    });

    describe('TASK_LIST page', () => {
      const setupTaskListMocks = (opts: {
        tasks: Array<{ id: string; status: string; completedAt?: Date | null; position?: number; title?: string }>;
        statusConfigs?: Array<{ slug: string; name: string; color: string; group: 'todo' | 'in_progress' | 'done'; position: number }>;
      }) => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'TASK_LIST'));
        mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) } as unknown as typeof mockDb.query.taskItems;
        mockDb.query.taskLists = {
          findFirst: vi.fn().mockResolvedValue({
            id: 'list-1',
            pageId: 'page-1',
            title: 'My Tasks',
          }),
        } as unknown as typeof mockDb.query.taskLists;
        mockDb.query.taskStatusConfigs = {
          // findFirst too: the post-seed sweep reads its replacement statuses
          // one at a time rather than paging the vocabulary, since nothing caps
          // how many statuses a list may define.
          findFirst: vi.fn().mockResolvedValue(undefined),
          findMany: vi.fn().mockResolvedValue(opts.statusConfigs ?? []),
        } as unknown as typeof mockDb.query.taskStatusConfigs;
        // Default no-op insert: most of these tests aren't asserting on the
        // legacy-backfill insert this triggers when statusConfigs is empty
        // (see the dedicated backfill test below, which overrides this).
        mockDb.insert = vi.fn(() => ({
          values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
        })) as unknown as typeof mockDb.insert;

        // db.select().from().innerJoin().where().orderBy() for tasks (title joined from pages)
        // db.select().from().innerJoin().where().groupBy() for sub-task count aggregates
        mockDb.select = vi.fn(() => ({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue(
            opts.tasks.map((t, i) => ({
              id: t.id,
              title: t.title ?? `Task ${i}`,
              description: null,
              status: t.status,
              priority: 'medium',
              position: t.position ?? i,
              assigneeId: null,
              dueDate: null,
              completedAt: t.completedAt ?? null,
              pageId: `page-task-${i}`,
            }))
          ),
          groupBy: vi.fn().mockResolvedValue([]),
          // ensureTaskListForPage now walks the page tree to inherit its nearest
          // ancestor task list's status vocabulary before seeding, which adds a
          // `.where().limit()` shape. An empty result ends the walk immediately
          // and the seed falls back to DEFAULT_TASK_STATUSES — what these cases
          // assert.
          limit: vi.fn().mockResolvedValue([]),
        })) as unknown as typeof mockDb.select;

        mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      };

      it('returns availableStatuses with documented defaults when no custom configs exist', async () => {
        setupTaskListMocks({ tasks: [{ id: 't1', status: 'pending' }] });

        const result = await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        ) as {
          availableStatuses: Array<{ slug: string; group: string; label: string }>;
        };

        const slugs = result.availableStatuses.map(s => s.slug).sort();
        assert({
          given: 'a TASK_LIST page with no custom status configs',
          should: 'return the four documented default statuses',
          actual: slugs,
          expected: ['blocked', 'completed', 'in_progress', 'pending'],
        });

        const completedGroup = result.availableStatuses.find(s => s.slug === 'completed')?.group;
        assert({
          given: 'default availableStatuses',
          should: 'include the done group on the completed status',
          actual: completedGroup,
          expected: 'done',
        });
      });

      it('returns availableStatuses describing every configured custom status', async () => {
        setupTaskListMocks({
          tasks: [],
          statusConfigs: [
            { slug: 'backlog', name: 'Backlog', color: 'bg-slate-100', group: 'todo', position: 0 },
            { slug: 'shipped', name: 'Shipped', color: 'bg-green-100', group: 'done', position: 1 },
          ],
        });

        const result = await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        ) as {
          availableStatuses: Array<{ slug: string; group: string; label: string; color: string }>;
        };

        assert({
          given: 'a TASK_LIST page with custom status configs',
          should: 'surface custom slugs',
          actual: result.availableStatuses.map(s => s.slug),
          expected: ['backlog', 'shipped'],
        });
        assert({
          given: 'a custom status config',
          should: 'surface label, group, and color',
          actual: result.availableStatuses.map(s => ({ label: s.label, group: s.group, color: s.color })),
          expected: [
            { label: 'Backlog', group: 'todo', color: 'bg-slate-100' },
            { label: 'Shipped', group: 'done', color: 'bg-green-100' },
          ],
        });
      });

      it('returns dynamic progress counts keyed by every status group present', async () => {
        setupTaskListMocks({
          tasks: [
            { id: 't1', status: 'backlog' },
            { id: 't2', status: 'shipped', completedAt: new Date() },
            { id: 't3', status: 'shipped', completedAt: new Date() },
          ],
          statusConfigs: [
            { slug: 'backlog', name: 'Backlog', color: '', group: 'todo', position: 0 },
            { slug: 'shipped', name: 'Shipped', color: '', group: 'done', position: 1 },
          ],
        });

        const result = await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        ) as {
          progress: { total: number; percentage: number; byGroup: Record<string, number>; bySlug: Record<string, number> };
        };

        assert({
          given: 'tasks with custom statuses',
          should: 'count tasks by group',
          actual: result.progress.byGroup,
          expected: { todo: 1, in_progress: 0, done: 2 },
        });
        assert({
          given: 'tasks with custom statuses',
          should: 'also expose per-slug counts so custom statuses surface',
          actual: result.progress.bySlug,
          expected: { backlog: 1, shipped: 2 },
        });
        assert({
          given: 'progress',
          should: 'compute percentage from the done group',
          actual: result.progress.percentage,
          expected: 67,
        });
      });

      it('persists a task_lists row AND seeds task_status_configs when auto-creating (not just the response fallback)', async () => {
        setupTaskListMocks({ tasks: [{ id: 't1', status: 'pending' }] });

        // No taskLists row exists yet for this page.
        mockDb.query.taskLists = {
          findFirst: vi.fn().mockResolvedValue(undefined),
        } as unknown as typeof mockDb.query.taskLists;
        // Simulates the findMany the tool runs right after creation seeing the rows
        // ensureTaskListForPage just inserted, so the separate empty-configs backfill
        // check doesn't also fire and double-insert.
        mockDb.query.taskStatusConfigs = {
          findFirst: vi.fn().mockResolvedValue(undefined),
          findMany: vi.fn().mockResolvedValue([
            { slug: 'pending', name: 'To Do', group: 'todo', position: 0, color: '#gray' },
          ]),
        } as unknown as typeof mockDb.query.taskStatusConfigs;

        const taskListInserts: Array<Record<string, unknown>> = [];
        const statusConfigInserts: Array<Record<string, unknown>> = [];
        mockDb.insert = vi.fn((table: { pageId?: string }) => ({
          values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
            if (table?.pageId === 'pageId') {
              taskListInserts.push(vals as Record<string, unknown>);
              return { returning: () => Promise.resolve([{ id: 'list-new', pageId: 'page-1', title: 'My Tasks' }]) };
            }
            statusConfigInserts.push(...(Array.isArray(vals) ? vals : [vals]));
            // Status-config seeding uses ON CONFLICT DO NOTHING.
            return { onConflictDoNothing: () => Promise.resolve(undefined) };
          },
        })) as unknown as typeof mockDb.insert;

        await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        );

        assert({
          given: 'a TASK_LIST page with no task_lists row yet',
          should: 'insert exactly one task_lists row',
          actual: taskListInserts.length,
          expected: 1,
        });
        assert({
          given: 'a newly auto-created task_lists row',
          should: 'persist the 4 default task_status_configs (not just return them in the response)',
          actual: statusConfigInserts.map(c => c.slug),
          expected: ['pending', 'in_progress', 'blocked', 'completed'],
        });
        assert({
          given: 'the persisted status configs',
          should: 'link each row to the new task_lists id',
          actual: statusConfigInserts.every(c => c.taskListId === 'list-new'),
          expected: true,
        });
      });

      it('backfills status configs for a legacy task_lists row that exists but has none', async () => {
        // Reproduces the gap flagged in review: a task_lists row created by a pre-fix
        // lazy-init path (or one seeded before this fix shipped) has zero configs.
        // ensureTaskListForPage no-ops since the row already exists, so read_page
        // itself must backfill once it observes the empty configs, instead of
        // leaving that row permanently half-initialized.
        setupTaskListMocks({ tasks: [{ id: 't1', status: 'pending' }], statusConfigs: [] });

        const statusConfigInserts: Array<Record<string, unknown>> = [];
        mockDb.insert = vi.fn(() => ({
          values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
            statusConfigInserts.push(...(Array.isArray(vals) ? vals : [vals]));
            // Status-config seeding uses ON CONFLICT DO NOTHING.
            return { onConflictDoNothing: () => Promise.resolve(undefined) };
          },
        })) as unknown as typeof mockDb.insert;

        await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        );

        assert({
          given: 'a task_lists row that already exists but has zero status configs',
          should: 'backfill the 4 default status configs',
          actual: statusConfigInserts.map(c => c.slug),
          expected: ['pending', 'in_progress', 'blocked', 'completed'],
        });
        assert({
          given: 'the backfilled status configs',
          should: 'link each row to the existing task_lists id',
          actual: statusConfigInserts.every(c => c.taskListId === 'list-1'),
          expected: true,
        });
        assert({
          given: 'a repair that both writes configs and rewrites task statuses',
          should: 'run as one transaction, since a half-applied repair is permanent',
          // It fires only while the vocabulary is empty, so once the configs
          // commit there is no later read that would come back and finish the
          // job. Structural, but the alternative is unobservable through a mock.
          // Two: the create-path seed opens one as well now, since it runs the
          // same two-write sequence and a page can hold task rows before its own
          // task_lists row exists. That one wraps a pair of reads on the common
          // path where the list is already there — a BEGIN/COMMIT for a
          // correctness cliff is a trade worth making.
          actual: (mockDb.transaction as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
          expected: 2,
        });
      });

      it('reports the vocabulary it just seeded, not the one it read before seeding', async () => {
        // statusConfigs is read BEFORE the repair. Without a re-read the same
        // response that seeds icebox/shipped tells the agent the statuses are
        // the four built-ins — and the agent then writes a status the list does
        // not define, which PATCH rejects.
        setupTaskListMocks({ tasks: [{ id: 't1', status: 'pending' }], statusConfigs: [] });
        const seeded = [
          { slug: 'icebox', name: 'Icebox', group: 'todo', position: 0, color: 'x' },
          { slug: 'shipped', name: 'Shipped', group: 'done', position: 1, color: 'x' },
        ];
        vi.mocked(mockDb.query.taskStatusConfigs.findMany)
          .mockResolvedValueOnce([] as never)
          .mockResolvedValue(seeded as never);
        mockDb.insert = vi.fn(() => ({
          values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
        })) as unknown as typeof mockDb.insert;

        const result = await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        ) as { availableStatuses?: Array<{ slug: string }> };

        assert({
          given: 'a read that repaired the vocabulary on its way through',
          should: 'return the seeded slugs AND re-read the rows the repair moved',
          // Both halves, because the repair writes twice. Re-reading only the
          // vocabulary reports statuses beside rows the sweep has already moved
          // off — naming slugs the same response says do not exist, which is the
          // pairing this block exists to prevent.
          actual: {
            statuses: result.availableStatuses?.map(s => s.slug),
            // The task read specifically — this route selects several other
            // shapes, so a bare call count is already >1 without the re-read.
            taskReads: (mockDb.select as ReturnType<typeof vi.fn>).mock.calls
              .filter((c) => !!c[0] && 'completedAt' in (c[0] as Record<string, unknown>)).length,
          },
          expected: { statuses: ['icebox', 'shipped'], taskReads: 2 },
        });
      });

      it('still returns the DEFAULT_TASK_STATUSES fallback when the legacy backfill insert fails', async () => {
        // The backfill is best-effort: this branch used to be a pure read (no
        // write) that could never fail. A transient DB error on the backfill
        // insert must not turn a previously-safe display fallback into a
        // failed tool call -- it should log and let the read still succeed.
        setupTaskListMocks({ tasks: [{ id: 't1', status: 'pending' }], statusConfigs: [] });

        // The failure has to come from the awaited call. Seeding is
        // `.values(...).onConflictDoNothing()`, so rejecting at `values()`
        // would build a promise nothing ever awaits — an unhandled rejection
        // that fails the run while every test still reports green.
        mockDb.insert = vi.fn(() => ({
          values: () => ({
            onConflictDoNothing: () => Promise.reject(new Error('connection reset')),
          }),
        })) as unknown as typeof mockDb.insert;

        const result = await pageReadTools.read_page.execute!(
          { title: 'My Tasks', pageId: 'page-1' },
          createAuthContext()
        ) as { availableStatuses: Array<{ slug: string }> };

        assert({
          given: 'a legacy list whose backfill insert fails with an unrelated error',
          should: 'still return the documented default statuses instead of throwing',
          actual: result.availableStatuses.map(s => s.slug).sort(),
          expected: ['blocked', 'completed', 'in_progress', 'pending'],
        });
      });
    });

  });

  describe('list_conversations', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'list_conversations tool',
        should: 'be defined',
        actual: pageReadTools.list_conversations !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.list_conversations.execute!(
          { pageId: 'page-1', title: 'Test Agent' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'non-existent', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent page',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when page is not AI_CHAT type', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('content', 'DOCUMENT'));
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Doc' },
        createAuthContext()
      );

      assert({
        given: 'a DOCUMENT page type',
        should: 'return error about invalid page type',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'a non-AI_CHAT page',
        should: 'include error message mentioning AI_CHAT',
        actual: (result as { error?: string }).error?.includes('AI_CHAT'),
        expected: true,
      });
    });

    it('returns error when user lacks permission', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(null);

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'user without page access',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns empty array when AI_CHAT has no conversations', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      // Mock empty conversations query
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue(
        mockSelectChain({ groupBy: [] }),
      );

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'AI_CHAT with no conversations',
        should: 'return success with empty array',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'AI_CHAT with no conversations',
        should: 'return empty conversations array',
        actual: (result as { conversations: unknown[] }).conversations,
        expected: [],
      });
    });

    it('returns conversation list with metadata', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));

      // Both selects in this tool share one chain stub: the aggregation
      // terminates on `.groupBy(...)`, the first-message preview on
      // `.limit(1)` (a plain SELECT since the cutover, where it used to be
      // `db.query.chatMessages.findFirst`).
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue(
        mockSelectChain({
          groupBy: [
            {
              conversationId: 'conv-1',
              messageCount: 5,
              lastActivity: new Date('2025-01-15'),
            },
            {
              conversationId: 'conv-2',
              messageCount: 10,
              lastActivity: new Date('2025-01-20'),
            },
          ],
          limit: [{ content: 'Hello, how can I help?', role: 'user', userId: 'user-1' }],
        }),
      );

      // Mock selectDistinct for participants
      (mockDb.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { userId: 'user-1' },
          ]),
        }),
      });

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'AI_CHAT with 2 conversations',
        should: 'return 2 conversations',
        actual: (result as { conversations: unknown[] }).conversations.length,
        expected: 2,
      });

      assert({
        given: 'a conversation in results',
        should: 'include conversationId',
        actual: typeof (result as { conversations: { conversationId: string }[] }).conversations[0].conversationId,
        expected: 'string',
      });

      assert({
        given: 'a conversation in results',
        should: 'include messageCount',
        actual: typeof (result as { conversations: { messageCount: number }[] }).conversations[0].messageCount,
        expected: 'number',
      });
    });
  });

  describe('read_conversation', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'read_conversation tool',
        should: 'be defined',
        actual: pageReadTools.read_conversation !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const result = await pageReadTools.read_conversation.execute!(
        { pageId: 'non-existent', conversationId: 'conv-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent page',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when user lacks permission', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(null);

      const result = await pageReadTools.read_conversation.execute!(
        { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'user without page access',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when conversation not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
      // Mock empty messages for this conversation
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue(
        mockSelectChain({ orderBy: [] }),
      );

      const result = await pageReadTools.read_conversation.execute!(
        { pageId: 'page-1', conversationId: 'non-existent', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent conversation',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-existent conversation',
        should: 'include error message',
        actual: (result as { error?: string }).error?.includes('not found'),
        expected: true,
      });
    });

    describe('message formatting', () => {
      const mockMessages = [
        { id: 'm1', role: 'user', content: 'Hello there', userId: 'user-1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:00:00') },
        { id: 'm2', role: 'assistant', content: 'Hi! How can I help?', userId: null, sourceAgentId: null, createdAt: new Date('2025-01-15T10:01:00') },
        { id: 'm3', role: 'user', content: 'Check other agent', userId: 'user-1', sourceAgentId: 'global-assistant-id', createdAt: new Date('2025-01-15T10:02:00') },
      ];

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn()
          .mockResolvedValue(createMockPage('', 'AI_CHAT')); // Main page lookup
        // Mock findMany for batched source agent lookups
        mockDb.query.pages.findMany = vi.fn()
          .mockResolvedValue([{ id: 'global-assistant-id', title: 'Global Assistant' }]);
        mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue(
          mockSelectChain({ orderBy: mockMessages }),
        );
      });

      it('returns all messages when no line params', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'a conversation with 3 messages',
          should: 'return messageCount of 3',
          actual: (result as { messageCount: number }).messageCount,
          expected: 3,
        });
      });

      it('formats direct user message with [user] prefix', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'a direct user message',
          should: 'include [user] prefix in content',
          actual: (result as { content: string }).content.includes('[user]'),
          expected: true,
        });
      });

      it('formats assistant message with [assistant] prefix', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'an assistant message',
          should: 'include [assistant] prefix in content',
          actual: (result as { content: string }).content.includes('[assistant]'),
          expected: true,
        });
      });

      it('formats message via another agent with [user@AgentName] prefix', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'a message sent via Global Assistant',
          should: 'include [user@Global Assistant] prefix',
          actual: (result as { content: string }).content.includes('[user@Global Assistant]'),
          expected: true,
        });
      });
    });

    describe('line range support', () => {
      const fiveMessages = [
        { id: 'm1', role: 'user', content: 'Message 1', userId: 'u1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:00:00') },
        { id: 'm2', role: 'assistant', content: 'Message 2', userId: null, sourceAgentId: null, createdAt: new Date('2025-01-15T10:01:00') },
        { id: 'm3', role: 'user', content: 'Message 3', userId: 'u1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:02:00') },
        { id: 'm4', role: 'assistant', content: 'Message 4', userId: null, sourceAgentId: null, createdAt: new Date('2025-01-15T10:03:00') },
        { id: 'm5', role: 'user', content: 'Message 5', userId: 'u1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:04:00') },
      ];

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
        mockGetUserAccessLevel.mockResolvedValue(createMockAccessLevel('editor'));
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue(
          mockSelectChain({ orderBy: fiveMessages }),
        );
      });

      it('returns only messages in range when lineStart and lineEnd provided', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 2, lineEnd: 4 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=2 and lineEnd=4',
          should: 'return 3 messages',
          actual: (result as { content: string }).content.split('\n').length,
          expected: 3,
        });

        assert({
          given: 'lineStart=2 and lineEnd=4',
          should: 'include rangeStart in response',
          actual: (result as { rangeStart: number }).rangeStart,
          expected: 2,
        });

        assert({
          given: 'lineStart=2 and lineEnd=4',
          should: 'include rangeEnd in response',
          actual: (result as { rangeEnd: number }).rangeEnd,
          expected: 4,
        });
      });

      it('includes totalMessages in response', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 2, lineEnd: 3 },
          createAuthContext()
        );

        assert({
          given: 'line range request',
          should: 'include totalMessages for context',
          actual: (result as { totalMessages: number }).totalMessages,
          expected: 5,
        });
      });

      it('returns empty with message when lineStart exceeds total', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 10 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=10 on a 5-message conversation',
          should: 'return empty content',
          actual: (result as { content: string }).content,
          expected: '',
        });

        assert({
          given: 'lineStart exceeds total',
          should: 'include rangeMessage',
          actual: (result as { rangeMessage?: string }).rangeMessage !== undefined,
          expected: true,
        });
      });

      it('returns error for invalid range (lineStart > lineEnd)', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 4, lineEnd: 2 },
          createAuthContext()
        );

        assert({
          given: 'lineStart > lineEnd',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });
      });
    });
  });
});
