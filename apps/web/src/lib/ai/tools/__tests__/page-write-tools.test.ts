import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

/**
 * Page Write Tools Tests
 *
 * These tests mock repository seams (pageRepository, driveRepository) at the
 * proper architectural boundary. This approach is:
 * - Refactor-resistant: internal query changes won't break tests
 * - Observable: tests verify behavior, not implementation
 * - Maintainable: single mock point per boundary
 */

// Mock repository seams - the proper architectural boundaries
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserEditPage: vi.fn(),
    canUserDeletePage: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/agent-permissions', () => ({
    getAgentAccessLevel: vi.fn(),
    hasAgentDriveMembership: vi.fn(),
    hasAgentDriveAdminRole: vi.fn(),
    getAgentAccessiblePagesInDrive: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
    logPageActivity: vi.fn(),
    logDriveActivity: vi.fn(),
    getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
}));
vi.mock('@pagespace/lib/content/page-content-format', () => ({
    detectPageContentFormat: vi.fn(() => 'text'),
}));
vi.mock('@pagespace/lib/utils/hash-utils', () => ({
    hashWithPrefix: vi.fn(() => 'content-ref'),
}));
vi.mock('@pagespace/lib/services/page-version-service', () => ({
    computePageStateHash: vi.fn(() => 'state-hash'),
    createPageVersion: vi.fn().mockResolvedValue({ id: 'version-1', contentRef: 'content-ref', contentSize: 0 }),
}));
vi.mock('@pagespace/lib/utils/enums', () => ({
    PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    AI_CHAT: 'AI_CHAT',
    CHANNEL: 'CHANNEL',
    CANVAS: 'CANVAS',
    SHEET: 'SHEET',
    TASK_LIST: 'TASK_LIST',
    FILE: 'FILE',
    CODE: 'CODE',
  },
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
    getDefaultContent: vi.fn(() => ''),
    getCreatablePageTypes: vi.fn(() => ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET', 'TASK_LIST', 'CODE']),
    // create_page's description interpolates each type's gloss from this config
    // so the prose can't drift from the schema (#2150).
    getPageTypeConfig: vi.fn((type: string) => ({ description: `${type} pages` })),
    isAIChatPage: vi.fn((type) => type === 'AI_CHAT'),
    isDocumentPage: vi.fn((type) => type === 'DOCUMENT'),
    isCodePage: vi.fn((type) => type === 'CODE'),
}));
// `edit_sheet_cells` parses through the ok/failure API so it can refuse to
// write over content it could not read; the mock has to expose that, or the
// tool throws before it reaches the branch under test.
const mockLogSheetCellActivity = vi.fn(async (..._args: unknown[]) => undefined);
const mockSetCells = vi.fn(async (..._args: unknown[]) => ({
  changed: ['A1'],
  recomputed: [] as string[],
  rowCount: 1,
  columnCount: 1,
}));
const mockParseSheetContentSafe = vi.fn(() => ({
  ok: true as const,
  sheet: { rowCount: 10, columnCount: 5 },
}));
vi.mock('@pagespace/lib/sheets/sheet', () => ({
    parseSheetContentSafe: (...args: unknown[]) => mockParseSheetContentSafe(...args as []),
    serializeSheetContent: vi.fn(() => ''),
    updateSheetCells: vi.fn((data) => data),
    isValidCellAddress: vi.fn((addr) => /^[A-Z]+\d+$/.test(addr.toUpperCase())),
    isSheetType: vi.fn((type) => type === 'SHEET'),
}));
vi.mock('@pagespace/lib/sheets/store', () => ({
    setCells: (...args: unknown[]) => mockSetCells(...args as []),
}));
vi.mock('@/services/api/sheet-activity', () => ({
    logSheetCellActivity: (...args: unknown[]) => mockLogSheetCellActivity(...args as []),
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
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/repositories/page-repository', () => ({
    pageRepository: {
    findById: vi.fn(),
    findTrashedById: vi.fn(),
    existsInDrive: vi.fn(),
    getNextPosition: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    trash: vi.fn(),
    trashMany: vi.fn(),
    restore: vi.fn(),
    getChildIds: vi.fn(),
    getDirectChildren: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/repositories/drive-repository', () => ({
    driveRepository: {
    findById: vi.fn(),
    findByIdBasic: vi.fn(),
    findByIdAndOwner: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
  },
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  // Real applyPageMutation resolves to a result object carrying deferredTrigger,
  // which callers passing their own tx must fire after commit.
  applyPageMutation: vi.fn().mockResolvedValue({ deferredTrigger: undefined }),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
  checkDriveAccess: vi.fn(),
}));

vi.mock('@/services/api/task-sync-service', () => ({
  ensureTaskListForPage: vi.fn().mockResolvedValue({ id: 'tasklist-1' }),
  syncTaskItemOnMove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({
  validatePageMove: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@/services/api/page-cross-drive-move-service', () => ({
  movePagesToDrive: vi.fn(),
}));

// Keep the REAL refusal strings — the tests assert the agent is told the actual
// user-facing reason, so a reworded constant must not silently keep passing.
vi.mock('@pagespace/lib/memory/memory-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/memory/memory-pages')>();
  return {
    ...actual,
    isProtectedMemoryPage: vi.fn().mockResolvedValue(false),
    findProtectedMemoryPages: vi.fn().mockResolvedValue(new Set<string>()),
  };
});

vi.mock('@/lib/canvas/publish-page', () => ({
  syncPublishedHomeRoot: vi.fn(),
}));

// resolveActingAgentId (internal to actor-permissions.ts) queries the acting
// page's type/userScopedAccess directly via db — mock that query boundary rather
// than the actor-permissions exports, since same-module internal calls aren't
// interceptable by mocking the module's exports. AI_CHAT: these agent fixtures
// are real agent pages, so they keep the agent-scoped path.
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ type: 'AI_CHAT', userScopedAccess: false }]) }) }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', userScopedAccess: 'userScopedAccess' },
}));

import { pageWriteTools, MAX_SHEET_CELLS_PER_EDIT } from '../page-write-tools';
import { ensureTaskListForPage, syncTaskItemOnMove } from '@/services/api/task-sync-service';
import { canUserEditPage, canUserDeletePage } from '@pagespace/lib/permissions/permissions';
import { getAgentAccessLevel, hasAgentDriveMembership, hasAgentDriveAdminRole } from '@pagespace/lib/permissions/agent-permissions';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { driveRepository } from '@pagespace/lib/repositories/drive-repository';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { movePagesToDrive } from '@/services/api/page-cross-drive-move-service';
import {
  isProtectedMemoryPage,
  findProtectedMemoryPages,
  MEMORY_PAGE_MOVE_ERROR,
} from '@pagespace/lib/memory/memory-pages';
import { broadcastPageEvent } from '@/lib/websocket';
import type { ToolExecutionContext } from '../../core/types';

const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockCanUserDeletePage = vi.mocked(canUserDeletePage);
const mockGetAgentAccessLevel = vi.mocked(getAgentAccessLevel);
const mockHasAgentDriveMembership = vi.mocked(hasAgentDriveMembership);
const mockHasAgentDriveAdminRole = vi.mocked(hasAgentDriveAdminRole);
const mockPageRepo = vi.mocked(pageRepository);
const mockDriveRepo = vi.mocked(driveRepository);
const mockApplyPageMutation = vi.mocked(applyPageMutation);
const mockEnsureTaskListForPage = vi.mocked(ensureTaskListForPage);
const mockSyncTaskItemOnMove = vi.mocked(syncTaskItemOnMove);
const mockCheckDriveAccess = vi.mocked(checkDriveAccess);
const mockValidatePageMove = vi.mocked(validatePageMove);
const mockMovePagesToDrive = vi.mocked(movePagesToDrive);
const mockBroadcastPageEvent = vi.mocked(broadcastPageEvent);
const mockIsProtectedMemoryPage = vi.mocked(isProtectedMemoryPage);
const mockFindProtectedMemoryPages = vi.mocked(findProtectedMemoryPages);

const ownerAccess = { isOwner: true, isAdmin: true, isMember: true, drive: null };
const adminAccess = { isOwner: false, isAdmin: true, isMember: true, drive: null };
const deniedAccess = { isOwner: false, isAdmin: false, isMember: true, drive: null };

// ── Cross-drive move fixtures ───────────────────────────────────────────
const SOURCE_DRIVE = 'drive-1';
const TARGET_DRIVE = 'drive-2';
const HOME_DRIVE = 'drive-home';

const sourcePageRow = (
  overrides: Partial<{ id: string; title: string; driveId: string; parentId: string | null }> = {},
) => ({
  id: 'page-1', title: 'Test Page', type: 'DOCUMENT' as const,
  content: '', contentMode: 'html' as const,
  driveId: SOURCE_DRIVE, parentId: null as string | null, position: 1,
  isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
  ...overrides,
});

const crossDriveContext = (userId: string) => ({
  toolCallId: '1', messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

describe('page-write-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pages have no direct children unless a test says otherwise.
    mockPageRepo.getDirectChildren.mockResolvedValue([]);
    // Default: nothing is a memory page unless a test says otherwise.
    mockIsProtectedMemoryPage.mockResolvedValue(false);
    mockFindProtectedMemoryPages.mockResolvedValue(new Set<string>());
  });

  describe('replace_lines', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.replace_lines).toBeDefined();
      expect(pageWriteTools.replace_lines.description).toContain('Replace');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.replace_lines.execute!(
          { title: 'Test Doc', pageId: 'page-1', startLine: 1, content: 'new' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when page not found', async () => {
      // Arrange: repository returns null
      mockPageRepo.findById.mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act & Assert
      await expect(
        pageWriteTools.replace_lines.execute!(
          { title: 'Test Doc', pageId: 'non-existent', startLine: 1, content: 'new' },
          context
        )
      ).rejects.toThrow('Page with ID "non-existent" not found');

      // Verify repository was called with correct ID
      expect(mockPageRepo.findById).toHaveBeenCalledWith('non-existent');
    });

    it('returns error for FILE type pages', async () => {
      // Arrange: repository returns FILE page
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'uploaded.pdf',
        type: 'FILE',
        content: '',
        mimeType: 'application/pdf',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.replace_lines.execute!(
        { title: 'uploaded.pdf', pageId: 'page-1', startLine: 1, content: 'new' },
        context
      );

      // Assert: observable error response
      if (!('error' in result)) throw new Error('Expected error result');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot edit FILE pages');
    });

    it('returns error for SHEET type pages', async () => {
      // Arrange: repository returns SHEET page
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'My Sheet',
        type: 'SHEET',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.replace_lines.execute!(
        { title: 'My Sheet', pageId: 'page-1', startLine: 1, content: 'new' },
        context
      );

      // Assert: observable error response
      if (!('error' in result)) throw new Error('Expected error result');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot use line editing on sheets');
    });

    it('replaces lines in document successfully', async () => {
      // Arrange: repository returns DOCUMENT page
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Test Doc',
        type: 'DOCUMENT',
        content: 'Line 1\nLine 2\nLine 3',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.update.mockResolvedValue({
        id: 'page-1',
        title: 'Test Doc',
        type: 'DOCUMENT',
        parentId: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.replace_lines.execute!(
        { title: 'Test Doc', pageId: 'page-1', startLine: 2, content: 'New Line 2' },
        context
      );

      // Assert: observable outcomes
      if ('error' in result) throw new Error(`Expected success but got error: ${result.error}`);
      const success = result as { success: boolean; linesReplaced: number };
      expect(success.success).toBe(true);
      expect(success.linesReplaced).toBe(1);

      // Verify repository interactions with correct payloads
      expect(mockCanUserEditPage).toHaveBeenCalledWith('user-123', 'page-1');
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'page-1',
          operation: 'update',
          updates: { content: 'Line 1\nNew Line 2\nLine 3' },
          updatedFields: ['content'],
          context: expect.objectContaining({ userId: 'user-123', isAiGenerated: true }),
        })
      );
    });

    it('replaces lines in CODE page without HTML mangling', async () => {
      // CODE pages may contain raw HTML/XML source. addLineBreaksForAI must NOT
      // run on them, so the saved content should preserve angle brackets verbatim.
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'index.html',
        type: 'CODE',
        content: '<div>old</div>\n<p>keep</p>',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.replace_lines.execute!(
        { title: 'index.html', pageId: 'page-1', startLine: 1, content: '<div>new</div>' },
        context
      );

      if ('error' in result) throw new Error(`Expected success but got error: ${result.error}`);
      const success = result as { success: boolean };
      expect(success.success).toBe(true);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'page-1',
          operation: 'update',
          updates: { content: '<div>new</div>\n<p>keep</p>' },
        })
      );
    });
  });

  describe('create_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.create_page).toBeDefined();
      expect(pageWriteTools.create_page.description).toContain('Create');
    });

    // Regression test for #2150: the description used to hardcode 8 page
    // type names and glosses, so it could (and did) drift from the schema
    // built from getCreatablePageTypes(). It now interpolates each creatable
    // type's own gloss from page-types.config, so the two can't diverge.
    it('interpolates every creatable type and its gloss from page-types.config', () => {
      const description = pageWriteTools.create_page.description;
      for (const type of ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET', 'TASK_LIST', 'CODE']) {
        expect(description).toContain(`${type} (${type} pages)`);
      }
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.create_page.execute!(
          { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    // The bug this fixes: driveId used to be REQUIRED with no fallback, so a
    // model with no drive in its arguments guessed one — usually the user's Home
    // drive — and the page was created in the wrong workspace.
    describe('resolving an omitted driveId', () => {
      const setupCreate = () => {
        mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-loc', ownerId: 'owner-999' });
        mockCanUserEditPage.mockResolvedValue(true);
        mockPageRepo.getNextPosition.mockResolvedValue(1);
        mockPageRepo.create.mockResolvedValue({ id: 'new-page-1', title: 'New Page', type: 'DOCUMENT' } as never);
      };

      const contextInDrive = (driveId: string) => ({
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          locationContext: { currentDrive: { id: driveId, name: 'Work', slug: 'work' } },
        } as ToolExecutionContext,
      });

      it('uses the workspace currently in view', async () => {
        setupCreate();

        await pageWriteTools.create_page.execute!(
          { title: 'New Page', type: 'DOCUMENT' },
          contextInDrive('drive-loc')
        );

        expect(mockDriveRepo.findByIdBasic).toHaveBeenCalledWith('drive-loc');
      });

      // An explicit parent names the drive unambiguously; a location-derived
      // guess must never override it.
      it("prefers the parent's drive over the drive in view", async () => {
        setupCreate();
        mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-of-parent', ownerId: 'owner-999' });
        mockPageRepo.findById.mockResolvedValue(sourcePageRow({ id: 'parent-1', driveId: 'drive-of-parent' }));
        mockPageRepo.existsInDrive.mockResolvedValue(true);

        await pageWriteTools.create_page.execute!(
          { title: 'New Page', type: 'DOCUMENT', parentId: 'parent-1' },
          contextInDrive('drive-loc')
        );

        expect(mockDriveRepo.findByIdBasic).toHaveBeenCalledWith('drive-of-parent');
      });

      it('asks rather than guessing when no workspace is in view', async () => {
        setupCreate();

        await expect(
          pageWriteTools.create_page.execute!(
            { title: 'New Page', type: 'DOCUMENT' },
            { toolCallId: '1', messages: [], experimental_context: { userId: 'user-123' } as ToolExecutionContext }
          )
        ).rejects.toThrow('no workspace is currently in view');
      });

      it('still honors an explicit driveId over the drive in view', async () => {
        setupCreate();
        mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-explicit', ownerId: 'owner-999' });

        await pageWriteTools.create_page.execute!(
          { driveId: 'drive-explicit', title: 'New Page', type: 'DOCUMENT' },
          contextInDrive('drive-loc')
        );

        expect(mockDriveRepo.findByIdBasic).toHaveBeenCalledWith('drive-explicit');
      });

      // Defaulting must not widen authority: the resolved drive goes through the
      // same canActorEditPage gate an explicit one does.
      it('still denies a defaulted drive the actor cannot write to', async () => {
        setupCreate();
        mockCanUserEditPage.mockResolvedValue(false);

        await expect(
          pageWriteTools.create_page.execute!(
            { title: 'New Page', type: 'DOCUMENT' },
            contextInDrive('drive-loc')
          )
        ).rejects.toThrow('Insufficient permissions to create pages in this drive');
      });

      it('parks the agent in the drive it just wrote to for the rest of the turn', async () => {
        setupCreate();
        const context = contextInDrive('drive-loc');

        await pageWriteTools.create_page.execute!(
          { title: 'New Page', type: 'DOCUMENT' },
          context
        );

        expect(context.experimental_context.currentWorkingDrive).toEqual({ id: 'drive-loc' });
      });
    });

    it('throws error when drive not found', async () => {
      // Arrange: repository returns null
      mockDriveRepo.findByIdBasic.mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act & Assert
      await expect(
        pageWriteTools.create_page.execute!(
          { driveId: 'non-existent', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('Drive with ID "non-existent" not found');

      // Verify repository was called
      expect(mockDriveRepo.findByIdBasic).toHaveBeenCalledWith('non-existent');
    });

    it('creates page successfully at root level for a drive member (user)', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-999' });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.getNextPosition.mockResolvedValue(1);
      mockPageRepo.create.mockResolvedValue({
        id: 'new-page-1',
        title: 'New Page',
        type: 'DOCUMENT',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.create_page.execute!(
        { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
        context
      );

      if ('error' in result) throw new Error('Expected success');
      const success = result as { success: boolean; id: string; title: string };
      expect(success.success).toBe(true);
      expect(success.id).toBe('new-page-1');
      // drive treated as root parent: canUserEditPage called with driveId
      expect(mockCanUserEditPage).toHaveBeenCalledWith('user-123', 'drive-1');
      expect(mockPageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New Page', type: 'DOCUMENT', driveId: 'drive-1', parentId: null })
      );
    });

    it('blocks root-level creation when user lacks drive edit access', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-999' });
      mockCanUserEditPage.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.create_page.execute!(
          { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('Insufficient permissions to create pages in this drive');
    });

    it('allows ADMIN agent to create root-level pages', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-999' });
      mockGetAgentAccessLevel.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: true });
      mockPageRepo.getNextPosition.mockResolvedValue(1);
      mockPageRepo.create.mockResolvedValue({ id: 'new-page-1', title: 'New Page', type: 'DOCUMENT' });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          chatSource: { type: 'page', agentPageId: 'agent-page-1' },
        } as unknown as ToolExecutionContext,
      };

      const result = await pageWriteTools.create_page.execute!(
        { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
        context
      );

      if ('error' in result) throw new Error('Expected success');
      const success = result as { success: boolean; id: string };
      expect(success.success).toBe(true);
      // agent permission checked with drive ID as the node
      expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-page-1', 'drive-1');
    });

    it('blocks MEMBER agent (no custom role) from root-level page creation', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-999' });
      mockGetAgentAccessLevel.mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          chatSource: { type: 'page', agentPageId: 'agent-page-1' },
        } as unknown as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.create_page.execute!(
          { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('Insufficient permissions to create pages in this drive');
    });

    it('seeds task_lists + default task_status_configs when creating a TASK_LIST page', async () => {
      // Reproduces the bug: create_page uses pageRepository.create() directly (not
      // pageService.createPage()), so without an explicit TASK_LIST branch the new
      // page has no taskLists/taskStatusConfigs rows and the Kanban UI crashes on
      // first load with "Cannot read properties of undefined (reading 'color')".
      mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-999' });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.getNextPosition.mockResolvedValue(1);
      mockPageRepo.create.mockResolvedValue({
        id: 'new-tasklist-1',
        title: 'New Task List',
        type: 'TASK_LIST',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.create_page.execute!(
        { driveId: 'drive-1', title: 'New Task List', type: 'TASK_LIST' },
        context
      );

      if ('error' in result) throw new Error('Expected success');
      expect(mockEnsureTaskListForPage).toHaveBeenCalledWith(
        expect.anything(),
        { pageId: 'new-tasklist-1', title: 'New Task List', userId: 'user-123' }
      );
    });

    it('does not seed task_lists for non-TASK_LIST page types', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-999' });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.getNextPosition.mockResolvedValue(1);
      mockPageRepo.create.mockResolvedValue({ id: 'new-page-1', title: 'New Page', type: 'DOCUMENT' });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await pageWriteTools.create_page.execute!(
        { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
        context
      );

      expect(mockEnsureTaskListForPage).not.toHaveBeenCalled();
    });
  });

  describe('rename_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.rename_page).toBeDefined();
      expect(pageWriteTools.rename_page.description).toContain('title');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.rename_page.execute!(
          { currentTitle: 'Old Title', pageId: 'page-1', title: 'New Title' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('renames page successfully', async () => {
      // Arrange
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Old Title',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.update.mockResolvedValue({
        id: 'page-1',
        title: 'New Title',
        type: 'DOCUMENT',
        parentId: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.rename_page.execute!(
        { currentTitle: 'Old Title', pageId: 'page-1', title: 'New Title' },
        context
      );

      // Assert
      if ('error' in result) throw new Error('Expected success');
      const success = result as { success: boolean; title: string };
      expect(success.success).toBe(true);
      expect(success.title).toBe('New Title');
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'page-1',
          operation: 'update',
          updates: { title: 'New Title' },
          updatedFields: ['title'],
          context: expect.objectContaining({ userId: 'user-123', isAiGenerated: true }),
        })
      );
    });

    it('defaults pageId to the page currently in view when omitted', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'in-view-page',
        title: 'Old Title',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.update.mockResolvedValue({
        id: 'in-view-page',
        title: 'New Title',
        type: 'DOCUMENT',
        parentId: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          locationContext: { currentPage: { id: 'in-view-page', title: 'Old Title', type: 'DOCUMENT', path: '/p' } },
        } as ToolExecutionContext,
      };

      const result = await pageWriteTools.rename_page.execute!(
        { currentTitle: 'Old Title', title: 'New Title' },
        context
      );

      if ('error' in result) throw new Error('Expected success');
      expect(mockPageRepo.findById).toHaveBeenCalledWith('in-view-page');
    });

    it('throws a clear error when pageId is omitted and no page is in view', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.rename_page.execute!(
          { currentTitle: 'Old Title', title: 'New Title' },
          context
        )
      ).rejects.toThrow('pageId is required');
    });

    it('syncs currentWorkingPage.title when renaming the agent\'s current working page', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Old Title',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.update.mockResolvedValue({
        id: 'page-1',
        title: 'New Title',
        type: 'DOCUMENT',
        parentId: null,
      });

      const executionContext: ToolExecutionContext = {
        userId: 'user-123',
        currentWorkingPage: { id: 'page-1', title: 'Old Title', type: 'DOCUMENT' },
      } as ToolExecutionContext;
      const context = { toolCallId: '1', messages: [], experimental_context: executionContext };

      await pageWriteTools.rename_page.execute!(
        { currentTitle: 'Old Title', pageId: 'page-1', title: 'New Title' },
        context
      );

      expect(executionContext.currentWorkingPage).toEqual({ id: 'page-1', title: 'New Title', type: 'DOCUMENT' });
    });

    it('does not touch currentWorkingPage when renaming a different page', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'other-page',
        title: 'Old Title',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.update.mockResolvedValue({
        id: 'other-page',
        title: 'New Title',
        type: 'DOCUMENT',
        parentId: null,
      });

      const executionContext: ToolExecutionContext = {
        userId: 'user-123',
        currentWorkingPage: { id: 'page-1', title: 'Focused Page', type: 'DOCUMENT' },
      } as ToolExecutionContext;
      const context = { toolCallId: '1', messages: [], experimental_context: executionContext };

      await pageWriteTools.rename_page.execute!(
        { currentTitle: 'Old Title', pageId: 'other-page', title: 'New Title' },
        context
      );

      expect(executionContext.currentWorkingPage).toEqual({ id: 'page-1', title: 'Focused Page', type: 'DOCUMENT' });
    });
  });

  describe('trash_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.trash_page).toBeDefined();
      expect(pageWriteTools.trash_page.description).toContain('trash');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.trash_page.execute!(
          { id: 'page-1', title: 'Test Page', withChildren: false },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('trashes a page successfully', async () => {
      // Arrange
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Test Page',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.trash_page.execute!(
        { id: 'page-1', title: 'Test Page', withChildren: false },
        context
      ) as { success: boolean; type: string; id: string; message: string };

      // Assert
      expect(result.success).toBe(true);
      expect(result.type).toBe('page');
      expect(result.id).toBe('page-1');
      expect(result.message).toContain('to trash');
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({ pageId: 'page-1', operation: 'trash' })
      );
    });

    it('defaults withChildren to true in the input schema (cascade by default)', () => {
      const schema = pageWriteTools.trash_page.inputSchema as unknown as {
        parse: (value: unknown) => { withChildren: boolean };
      };
      expect(schema.parse({ id: 'page-1' }).withChildren).toBe(true);
    });

    it('cascades to children when withChildren is true', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Parent Page',
        type: 'TASK_LIST',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserDeletePage.mockResolvedValue(true);
      mockPageRepo.getChildIds.mockResolvedValue([]);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.trash_page.execute!(
        { id: 'page-1', withChildren: true },
        context
      ) as { success: boolean; childrenCount?: number };

      expect(result.success).toBe(true);
      // Cascade branch was taken: delete permission checked and descendants enumerated.
      expect(mockCanUserDeletePage).toHaveBeenCalledWith('user-123', 'page-1');
      expect(mockPageRepo.getChildIds).toHaveBeenCalledWith('drive-1', 'page-1');
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({ pageId: 'page-1', operation: 'trash' })
      );
    });

    // This branch walks descendants itself rather than going through
    // pageService.recursivelyTrash, so it needs its own guard. The check at the
    // top of the helper only sees the page the agent named — an agent told to
    // "clean up this folder" would otherwise take a memory page down with it.
    it('skips a protected memory page inside the cascade but still trashes its siblings', async () => {
      mockPageRepo.findById.mockImplementation(async (id: string) => ({
        id,
        title: id,
        type: 'DOCUMENT' as const,
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      }));
      mockCanUserDeletePage.mockResolvedValue(true);
      mockPageRepo.getChildIds.mockResolvedValue(['child-1', 'memory-bio', 'child-2']);
      mockFindProtectedMemoryPages.mockResolvedValue(new Set(['memory-bio']));

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.trash_page.execute!(
        { id: 'page-1', withChildren: true },
        context
      ) as { success: boolean; childrenCount?: number };

      expect(result.success).toBe(true);

      const trashedIds = mockApplyPageMutation.mock.calls
        .map(([arg]) => arg as { pageId: string; operation: string })
        .filter((arg) => arg.operation === 'trash')
        .map((arg) => arg.pageId);

      // The unrelated children still go; the memory page does not.
      expect(trashedIds).toContain('child-1');
      expect(trashedIds).toContain('child-2');
      expect(trashedIds).not.toContain('memory-bio');

      // The count reported back to the model must describe what was actually
      // trashed, or the agent tells the user it deleted something it did not.
      expect(result.childrenCount).toBe(2);
    });

    it('checks delete permission before revealing that a page is a memory page', async () => {
      // Same ordering as pageService.trashPage: authorization first, so a
      // caller who cannot delete the page is not told what it holds.
      mockPageRepo.findById.mockResolvedValue({
        id: 'memory-bio', title: 'About You', type: 'DOCUMENT',
        content: '', contentMode: 'html' as const,
        driveId: 'drive-1', parentId: null, position: 1,
        isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(false);
      mockIsProtectedMemoryPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash_page.execute!({ id: 'memory-bio', withChildren: false }, context)
      ).rejects.toThrow('Insufficient permissions to trash this page');

      expect(mockIsProtectedMemoryPage).not.toHaveBeenCalled();
    });

    it('re-homes live children to the grandparent when withChildren is false', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Parent Page',
        type: 'TASK_LIST',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: 'grandparent-1',
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 7,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockPageRepo.getDirectChildren.mockResolvedValue([
        { id: 'child-1', revision: 2 },
        { id: 'child-2', revision: 3 },
      ]);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.trash_page.execute!(
        { id: 'page-1', withChildren: false },
        context
      ) as { success: boolean };

      expect(result.success).toBe(true);
      // Each live child is moved up to the grandparent (originalParentId recorded for restore)...
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'child-1',
          operation: 'move',
          updates: { parentId: 'grandparent-1', originalParentId: 'page-1' },
        })
      );
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'child-2',
          operation: 'move',
          updates: { parentId: 'grandparent-1', originalParentId: 'page-1' },
        })
      );
      // ...and only then is the parent trashed (children are never stranded under it).
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({ pageId: 'page-1', operation: 'trash' })
      );
    });

    it('trashes a page given only an id (title is optional, fetched by id)', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Test Page',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.trash_page.execute!(
        { id: 'page-1', withChildren: false },
        context
      ) as { success: boolean; message: string };

      expect(result.success).toBe(true);
      // Display title comes from the fetched page, not the (omitted) input param
      expect(result.message).toContain('Test Page');
    });

    it('rejects when the page is not found', async () => {
      mockPageRepo.findById.mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash_page.execute!(
          { id: 'missing', title: 'Ghost', withChildren: false },
          context
        )
      ).rejects.toThrow('not found');
    });
  });

  describe('trash_drive', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.trash_drive).toBeDefined();
      expect(pageWriteTools.trash_drive.description).toContain('drive');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.trash_drive.execute!(
          { id: 'drive-1', confirmDriveName: 'My Drive' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('trashes a drive when confirmDriveName matches', async () => {
      // Arrange
      mockCheckDriveAccess.mockResolvedValue(ownerAccess);
      mockDriveRepo.findById.mockResolvedValue({
        id: 'drive-1',
        name: 'My Drive',
        slug: 'my-drive',
        ownerId: 'user-123',
        kind: 'STANDARD' as const,
        isTrashed: false,
        trashedAt: null,
      });
      mockDriveRepo.trash.mockResolvedValue(undefined);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.trash_drive.execute!(
        { id: 'drive-1', confirmDriveName: 'My Drive' },
        context
      ) as { success: boolean; type: string; id: string; name: string };

      // Assert
      expect(result.success).toBe(true);
      expect(result.type).toBe('drive');
      expect(result.name).toBe('My Drive');
      expect(mockDriveRepo.trash).toHaveBeenCalledWith('drive-1');
    });

    it('rejects when confirmDriveName does not match the drive name', async () => {
      mockCheckDriveAccess.mockResolvedValue(ownerAccess);
      mockDriveRepo.findById.mockResolvedValue({
        id: 'drive-1',
        name: 'My Drive',
        slug: 'my-drive',
        ownerId: 'user-123',
        kind: 'STANDARD' as const,
        isTrashed: false,
        trashedAt: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash_drive.execute!(
          { id: 'drive-1', confirmDriveName: 'Wrong Name' },
          context
        )
      ).rejects.toThrow('Drive name confirmation failed');
      expect(mockDriveRepo.trash).not.toHaveBeenCalled();
    });

    it('rejects when confirmDriveName is missing', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash_drive.execute!(
          { id: 'drive-1', confirmDriveName: '' },
          context
        )
      ).rejects.toThrow('Drive name confirmation is required');
      expect(mockDriveRepo.trash).not.toHaveBeenCalled();
    });

    it('schema rejects blank/whitespace confirmDriveName and trims valid input', () => {
      const schema = pageWriteTools.trash_drive.inputSchema as {
        safeParse: (v: unknown) => { success: boolean; data?: { confirmDriveName?: string } };
      };
      expect(schema.safeParse({ id: 'drive-1', confirmDriveName: '' }).success).toBe(false);
      expect(schema.safeParse({ id: 'drive-1', confirmDriveName: '   ' }).success).toBe(false);
      const ok = schema.safeParse({ id: 'drive-1', confirmDriveName: '  My Drive  ' });
      expect(ok.success).toBe(true);
      expect(ok.data?.confirmDriveName).toBe('My Drive');
    });

    // Regression coverage for #1772: trash_drive was owner-only, unlike
    // DELETE /api/drives/[driveId] which allows owner OR admin.
    it('allows a drive admin (not just the owner) to trash the drive — matches DELETE /api/drives/[driveId]', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockDriveRepo.findById.mockResolvedValue({
        id: 'drive-1',
        name: 'My Drive',
        slug: 'my-drive',
        ownerId: 'owner-999',
        kind: 'STANDARD' as const,
        isTrashed: false,
        trashedAt: null,
      });
      mockDriveRepo.trash.mockResolvedValue(undefined);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'admin-user' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.trash_drive.execute!(
        { id: 'drive-1', confirmDriveName: 'My Drive' },
        context
      ) as { success: boolean };

      expect(result.success).toBe(true);
      expect(mockDriveRepo.trash).toHaveBeenCalledWith('drive-1');
    });

    it('denies a plain member (not owner or admin) from trashing the drive', async () => {
      mockCheckDriveAccess.mockResolvedValue(deniedAccess);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'member-user' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash_drive.execute!(
          { id: 'drive-1', confirmDriveName: 'My Drive' },
          context
        )
      ).rejects.toThrow('do not have permission');
      expect(mockDriveRepo.trash).not.toHaveBeenCalled();
    });
  });

  describe('restore_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.restore_page).toBeDefined();
      expect(pageWriteTools.restore_page.description).toContain('Restore');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.restore_page.execute!(
          { id: 'page-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('restores a trashed page successfully', async () => {
      mockPageRepo.findTrashedById.mockResolvedValue({
        id: 'page-1',
        title: 'Trashed Page',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: true,
        trashedAt: new Date(),
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.restore_page.execute!(
        { id: 'page-1' },
        context
      ) as { success: boolean; type: string; id: string; message: string };

      expect(result.success).toBe(true);
      expect(result.type).toBe('page');
      expect(result.id).toBe('page-1');
      expect(result.message).toContain('restored');
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({ pageId: 'page-1', operation: 'restore' })
      );
    });

    it('rejects when the trashed page is not found', async () => {
      mockPageRepo.findTrashedById.mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.restore_page.execute!(
          { id: 'missing' },
          context
        )
      ).rejects.toThrow('not found');
    });
  });

  describe('restore_drive', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.restore_drive).toBeDefined();
      expect(pageWriteTools.restore_drive.description).toContain('Restore');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.restore_drive.execute!(
          { id: 'drive-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('restores a trashed drive successfully', async () => {
      mockDriveRepo.findByIdAndOwner.mockResolvedValue({
        id: 'drive-1',
        name: 'My Drive',
        slug: 'my-drive',
        ownerId: 'user-123',
        kind: 'STANDARD' as const,
        isTrashed: true,
        trashedAt: new Date(),
      });
      mockDriveRepo.restore.mockResolvedValue({
        id: 'drive-1',
        name: 'My Drive',
        slug: 'my-drive',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.restore_drive.execute!(
        { id: 'drive-1' },
        context
      ) as { success: boolean; type: string; id: string; name: string };

      expect(result.success).toBe(true);
      expect(result.type).toBe('drive');
      expect(result.name).toBe('My Drive');
      expect(mockDriveRepo.restore).toHaveBeenCalledWith('drive-1');
    });

    it('rejects when the drive is not in trash', async () => {
      mockDriveRepo.findByIdAndOwner.mockResolvedValue({
        id: 'drive-1',
        name: 'My Drive',
        slug: 'my-drive',
        ownerId: 'user-123',
        kind: 'STANDARD' as const,
        isTrashed: false,
        trashedAt: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.restore_drive.execute!(
          { id: 'drive-1' },
          context
        )
      ).rejects.toThrow('not in trash');
      expect(mockDriveRepo.restore).not.toHaveBeenCalled();
    });
  });

  describe('move_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.move_page).toBeDefined();
      expect(pageWriteTools.move_page.description).toContain('Move');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', newParentTitle: 'New Folder', position: 1 },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    // Regression coverage for #1772: move_page only required per-page edit
    // permission, unlike /api/pages/reorder which requires drive owner/admin
    // for the same move+position operation. The bars must agree.
    // Moving is what makes the cascade hole reachable: relocate a memory page
    // under an ordinary page and that page's delete takes it too.
    //
    // Only the SAME-DRIVE move is refused here. The cross-drive path enforces
    // it inside movePagesToDrive, because that service is shared with
    // /api/pages/bulk-move — guarding it at this call site would leave the REST
    // route open. See page-cross-drive-move-service.test.ts.
    it('refuses a same-drive move of a memory page', async () => {
      mockPageRepo.findById.mockResolvedValue(sourcePageRow({ id: 'memory-bio' }));
      mockCheckDriveAccess.mockResolvedValue(ownerAccess);
      mockIsProtectedMemoryPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'About You', pageId: 'memory-bio', position: 1 },
          context
        )
      ).rejects.toThrow(MEMORY_PAGE_MOVE_ERROR);

      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('checks move permission before revealing that a page is a memory page', async () => {
      // Refusing first would tell a caller who cannot move the page at all that
      // it holds the user's profile. pageService.updatePage checks permission
      // first; this path must agree.
      mockPageRepo.findById.mockResolvedValue(sourcePageRow({ id: 'memory-bio' }));
      mockCheckDriveAccess.mockResolvedValue(deniedAccess);
      mockIsProtectedMemoryPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'member-user' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'About You', pageId: 'memory-bio', position: 1 },
          context
        )
      ).rejects.toThrow('Only drive owners and admins can move pages');

      expect(mockIsProtectedMemoryPage).not.toHaveBeenCalled();
    });

    it('denies a member with page-edit access but no drive owner/admin role', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1', title: 'Test Page', type: 'DOCUMENT',
        content: '', contentMode: 'html' as const,
        driveId: 'drive-1', parentId: null, position: 1,
        isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
      });
      // Edit permission is granted, but the actor is a plain member — under
      // the aligned bar this must NOT be enough to move the page.
      mockCanUserEditPage.mockResolvedValue(true);
      mockCheckDriveAccess.mockResolvedValue(deniedAccess);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'member-user' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', position: 1 },
          context
        )
      ).rejects.toThrow('Only drive owners and admins can move pages');
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('allows a drive admin to move a page, matching /api/pages/reorder', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1', title: 'Test Page', type: 'DOCUMENT',
        content: '', contentMode: 'html' as const,
        driveId: 'drive-1', parentId: null, position: 1,
        isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
      });
      mockCheckDriveAccess.mockResolvedValue(adminAccess);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'admin-user' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', position: 2 },
        context
      ) as { success: boolean };

      expect(result.success).toBe(true);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({ pageId: 'page-1', operation: 'move' })
      );
    });

    // Every other move path in the codebase syncs task_items; this one did not,
    // so after the cross-drive work landed the SAME tool kept the row correct
    // only when the move happened to cross a drive boundary.
    it('syncs the task_items row on a same-drive move, like every other move path', async () => {
      mockPageRepo.findById.mockResolvedValue(sourcePageRow({ id: 'page-1', parentId: 'old-parent' }));
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockPageRepo.existsInDrive.mockResolvedValue(true);
      mockValidatePageMove.mockResolvedValue({ valid: true });

      await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', newParentId: 'new-parent', position: 1 },
        crossDriveContext('admin-user')
      );

      expect(mockSyncTaskItemOnMove).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          movedPageId: 'page-1',
          oldParentId: 'old-parent',
          newParentId: 'new-parent',
          userId: 'admin-user',
        }),
      );
    });

    // Cycle guard was missing on this path entirely: /api/pages/reorder and
    // /api/pages/bulk-move both run validatePageMove, the AI tool did not, so an
    // agent could reparent a page under its own descendant.
    it('refuses a same-drive move that would create a circular reference', async () => {
      mockPageRepo.findById.mockResolvedValue(sourcePageRow());
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockPageRepo.existsInDrive.mockResolvedValue(true);
      mockValidatePageMove.mockResolvedValue({
        valid: false,
        error: 'Cannot set parent: would create circular reference in page tree',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'admin-user' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', newParentId: 'descendant-1', position: 1 },
          context
        )
      ).rejects.toThrow('circular reference');
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });
  });

  // ── Cross-drive moves ─────────────────────────────────────────────────
  //
  // The reason this path exists: content the assistant files in the user's Home
  // drive (generated images, drafts, plans) was previously unreachable from any
  // other workspace, because move_page could not cross a drive boundary.
  describe('move_page across drives', () => {
    beforeEach(() => {
      mockPageRepo.findById.mockResolvedValue(sourcePageRow());
      mockDriveRepo.findById.mockImplementation(async (id: string) =>
        ({ id, name: id === TARGET_DRIVE ? 'Work' : 'Home', slug: id }) as never
      );
      // Faithful stand-in for the service: same authorization ORDER as the real
      // implementation (covered by page-cross-drive-move-service.test.ts), so
      // these tests exercise the tool's authorizer wiring for real.
      mockMovePagesToDrive.mockImplementation((async (params: Parameters<typeof movePagesToDrive>[0]) => {
        if (!(await params.authorize.isDriveInScope(params.targetDriveId))) {
          return { success: false, code: 'TARGET_DRIVE_OUT_OF_SCOPE', status: 403,
            message: 'This token does not have access to the target drive' };
        }
        if (!(await params.authorize.canAdministerDrive(params.targetDriveId))) {
          return { success: false, code: 'TARGET_DRIVE_FORBIDDEN', status: 403,
            message: 'You do not have permission to move pages to this drive' };
        }
        for (const id of params.pageIds) {
          if (!(await params.authorize.canEditPage(id))) {
            return { success: false, code: 'SOURCE_PAGE_FORBIDDEN', status: 403,
              message: `You do not have permission to move page: ${id}` };
          }
        }
        return {
          success: true,
          moved: [{ id: 'page-1', title: 'Test Page', type: 'DOCUMENT',
            previousDriveId: SOURCE_DRIVE, previousParentId: null, position: 7 }],
          descendantCount: 2,
          affectedDriveIds: [params.targetDriveId, SOURCE_DRIVE],
          clearedHomePageDriveIds: [],
        };
      }) as never);
    });

    it('does not take the cross-drive path when targetDriveId is omitted', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);

      await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', position: 1 },
        crossDriveContext('admin-user')
      );

      expect(mockMovePagesToDrive).not.toHaveBeenCalled();
      expect(mockApplyPageMutation).toHaveBeenCalled();
    });

    // A model that helpfully echoes back the CURRENT workspace id must not
    // thereby swap which authorization bar applies.
    it('takes the same-drive path when targetDriveId equals the current drive', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);

      await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', targetDriveId: SOURCE_DRIVE, position: 1 },
        crossDriveContext('admin-user')
      );

      expect(mockMovePagesToDrive).not.toHaveBeenCalled();
      expect(mockCheckDriveAccess).toHaveBeenCalledWith(SOURCE_DRIVE, 'admin-user');
    });

    it('denies when the actor cannot administer the DESTINATION drive', async () => {
      mockCheckDriveAccess.mockImplementation(async (driveId: string) =>
        driveId === TARGET_DRIVE ? deniedAccess : adminAccess
      );
      mockCanUserEditPage.mockResolvedValue(true);

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
          crossDriveContext('user-1')
        )
      ).rejects.toThrow('You do not have permission to move pages to this drive');
    });

    it('denies when the actor cannot edit the source page', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(false);

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
          crossDriveContext('user-1')
        )
      ).rejects.toThrow('You do not have permission to move page');
    });

    // THE ACCEPTED AUTHORITY DELTA, pinned deliberately. Before this change
    // move_page required owner/admin on the page's own drive for any move. The
    // cross-drive bar mirrors /api/pages/bulk-move instead: edit on the page plus
    // admin on the DESTINATION. So a user who is merely an editor in the source
    // drive can now move a page out of it. That is parity with what the Move
    // dialog already allows — not an escalation beyond the user's own reach.
    it('allows an editor in the source drive who administers the destination', async () => {
      mockCheckDriveAccess.mockImplementation(async (driveId: string) =>
        driveId === TARGET_DRIVE ? adminAccess : deniedAccess
      );
      mockCanUserEditPage.mockResolvedValue(true);

      const result = await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
        crossDriveContext('editor-user')
      ) as { success: boolean; crossDrive: boolean };

      expect(result.success).toBe(true);
      expect(result.crossDrive).toBe(true);
      expect(mockMovePagesToDrive).toHaveBeenCalledWith(
        expect.objectContaining({
          pageIds: ['page-1'],
          targetDriveId: TARGET_DRIVE,
          targetParentId: null,
        })
      );
    });

    // The Home drive is an exfiltration boundary for rename/trash/share/publish
    // (drive-guards), never for move. Moving generated images and drafts OUT of
    // Home is the whole point — this pins that decision against a future "helpful"
    // Home guard.
    it('moves out of the Home drive without special-casing it', async () => {
      mockPageRepo.findById.mockResolvedValue(sourcePageRow({ driveId: HOME_DRIVE }));
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(true);

      const result = await pageWriteTools.move_page.execute!(
        { title: 'Generated image', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
        crossDriveContext('owner-user')
      ) as { success: boolean };

      expect(result.success).toBe(true);
      expect(mockMovePagesToDrive).toHaveBeenCalled();
    });

    const agentContext = () => ({
      toolCallId: '1', messages: [],
      experimental_context: {
        userId: 'user-1',
        chatSource: { type: 'page' as const, agentPageId: 'agent-1' },
      } as ToolExecutionContext,
    });

    it('denies an agent actor without membership in the destination drive', async () => {
      mockGetAgentAccessLevel.mockResolvedValue({ canView: true, canEdit: true, canShare: false, canDelete: false });
      mockHasAgentDriveAdminRole.mockResolvedValue(false);

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
          agentContext()
        )
      ).rejects.toThrow('You do not have permission to move pages to this drive');
    });

    // The destination bar is OWNER/ADMIN, not "has a membership row". Agent
    // authority is normally resolved via hasAgentDriveMembership, which ignores
    // `role` entirely — using it here would let a plain MEMBER agent pull a whole
    // subtree into a drive that bulk-move guards with OWNER/ADMIN for humans.
    it('denies an agent that is only a MEMBER of the destination drive', async () => {
      mockGetAgentAccessLevel.mockResolvedValue({ canView: true, canEdit: true, canShare: false, canDelete: false });
      mockHasAgentDriveMembership.mockResolvedValue(true);   // a row exists...
      mockHasAgentDriveAdminRole.mockResolvedValue(false);   // ...but it is not OWNER/ADMIN

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
          agentContext()
        )
      ).rejects.toThrow('You do not have permission to move pages to this drive');
    });

    it('allows an agent that administers the destination drive', async () => {
      mockGetAgentAccessLevel.mockResolvedValue({ canView: true, canEdit: true, canShare: false, canDelete: false });
      mockHasAgentDriveAdminRole.mockResolvedValue(true);

      const result = await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
        agentContext()
      ) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('denies a scoped MCP caller whose token cannot reach the destination drive', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(true);

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
          {
            toolCallId: '1', messages: [],
            experimental_context: {
              userId: 'user-1',
              mcpAllowedDriveIds: [SOURCE_DRIVE],
            } as ToolExecutionContext,
          }
        )
      ).rejects.toThrow('does not have access to the target drive');
    });

    it('reports the new location, the previous one, and the subtree size', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(true);

      const result = await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
        crossDriveContext('owner-user')
      ) as Record<string, unknown>;

      expect(result).toMatchObject({
        crossDrive: true,
        driveId: TARGET_DRIVE,
        driveName: 'Work',
        previousDriveId: SOURCE_DRIVE,
        previousDriveName: 'Home',
        movedDescendants: 2,
        position: 7,
      });
      expect(result.message).toContain('2 nested pages');
      expect(result.message).toContain('"Home"');
      expect(result.message).toContain('"Work"');
    });

    // Broadcasting only to the destination leaves a ghost row in the source
    // drive's sidebar until the next full refresh.
    it('broadcasts to the source drive as well as the destination', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(true);

      await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, position: 1 },
        crossDriveContext('owner-user')
      );

      expect(mockBroadcastPageEvent).toHaveBeenCalledTimes(2);
    });

    // parentId and newParentTitle are independently optional; keying the message
    // off the title alone reported "at the top level" while the same result
    // carried a parentId.
    it('names the destination folder even when no parent title was supplied', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(true);

      const result = await pageWriteTools.move_page.execute!(
        { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, newParentId: 'folder-x', position: 1 },
        crossDriveContext('owner-user')
      ) as { parentId: string; message: string };

      expect(result.parentId).toBe('folder-x');
      expect(result.message).not.toContain('at the top level');
      expect(result.message).toContain('destination folder');
    });

    it('surfaces a service failure through the tool error envelope', async () => {
      mockCheckDriveAccess.mockResolvedValue(adminAccess);
      mockCanUserEditPage.mockResolvedValue(true);
      mockMovePagesToDrive.mockResolvedValue({
        success: false, code: 'TARGET_PARENT_NOT_FOUND', status: 404,
        message: 'Target folder not found',
      } as never);

      await expect(
        pageWriteTools.move_page.execute!(
          { title: 'Test Page', pageId: 'page-1', targetDriveId: TARGET_DRIVE, newParentId: 'nope', position: 1 },
          crossDriveContext('owner-user')
        )
      ).rejects.toThrow('Failed to move page "Test Page": Target folder not found');
    });
  });

  describe('insert_content', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.insert_content).toBeDefined();
      expect(pageWriteTools.insert_content.description).toContain('insert');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.insert_content.execute!(
          { title: 'Doc', pageId: 'page-1', anchor: 'Heading', content: 'new line', position: 'after' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws when page not found', async () => {
      mockPageRepo.findById.mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.insert_content.execute!(
          { title: 'Doc', pageId: 'missing', anchor: 'Heading', content: 'new', position: 'after' },
          context
        )
      ).rejects.toThrow('not found');
    });

    it('returns not-found result when anchor is absent', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1', title: 'Doc', type: 'DOCUMENT',
        content: 'line one\nline two', contentMode: 'html' as const,
        driveId: 'drive-1', parentId: null, position: 1,
        isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.insert_content.execute!(
        { title: 'Doc', pageId: 'page-1', anchor: 'missing anchor', content: 'new', position: 'after' },
        context
      ) as { success: boolean; inserted: boolean };

      expect(result.success).toBe(true);
      expect(result.inserted).toBe(false);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('inserts after anchor and calls applyPageMutation', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1', title: 'Doc', type: 'DOCUMENT',
        content: 'line one\nline two\nline three', contentMode: 'html' as const,
        driveId: 'drive-1', parentId: null, position: 1,
        isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.insert_content.execute!(
        { title: 'Doc', pageId: 'page-1', anchor: 'line two', content: 'inserted', position: 'after' },
        context
      ) as { success: boolean; inserted: boolean; anchorLine: number };

      expect(result.success).toBe(true);
      expect(result.inserted).toBe(true);
      expect(result.anchorLine).toBe(2);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'page-1',
          operation: 'update',
          updates: { content: 'line one\nline two\ninserted\nline three' },
          updatedFields: ['content'],
        })
      );
    });

    it('inserts before anchor', async () => {
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1', title: 'Doc', type: 'DOCUMENT',
        content: 'line one\nline two', contentMode: 'html' as const,
        driveId: 'drive-1', parentId: null, position: 1,
        isTrashed: false, trashedAt: null, revision: 1, stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.insert_content.execute!(
        { title: 'Doc', pageId: 'page-1', anchor: 'line two', content: 'prepended', position: 'before' },
        context
      ) as { success: boolean; inserted: boolean };

      expect(result.success).toBe(true);
      expect(result.inserted).toBe(true);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: { content: 'line one\nprepended\nline two' },
        })
      );
    });
  });

  describe('edit_sheet_cells', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.edit_sheet_cells).toBeDefined();
      expect(pageWriteTools.edit_sheet_cells.description).toContain('SHEET');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.edit_sheet_cells.execute!(
          { pageId: 'page-1', cells: [{ address: 'A1', value: 'test' }] },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('writes only the addressed cells, never the rest of the sheet', async () => {
      // Replaces "refuses to edit a sheet whose stored content could not be
      // read". That guard protected a read-modify-write of the whole document:
      // an unparseable read would have replaced the spreadsheet with just these
      // cells. The tool addresses cells now, so there is no document read to
      // fail — the stronger property is asserted directly.
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Budget',
        type: 'SHEET',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await pageWriteTools.edit_sheet_cells.execute!(
        { pageId: 'page-1', cells: [{ address: 'A1', value: 'test' }] },
        context
      );

      expect(mockSetCells).toHaveBeenCalledTimes(1);
      const [ref, cells] = mockSetCells.mock.calls[0] as [unknown, unknown];
      expect(ref).toEqual({ pageId: 'page-1' });
      expect(cells).toEqual([{ address: 'A1', value: 'test' }]);
    });

    it('caps the batch at MAX_SHEET_CELLS_PER_EDIT and says so in the schema', () => {
      // The cap has to be REACHABLE by the model, not just enforced: it is the
      // schema, and the description, that stop an agent from inferring a batch
      // size by trial and error the way issue #2467 reports having to. An
      // enforcement with no advertisement would just move the folklore.
      const schema = pageWriteTools.edit_sheet_cells.inputSchema as z.ZodType<unknown>;
      const cell = (index: number) => ({ address: `A${index + 1}`, value: 'x' });

      const atCap = schema.safeParse({
        pageId: 'page-1',
        cells: Array.from({ length: MAX_SHEET_CELLS_PER_EDIT }, (_, i) => cell(i)),
      });
      const overCap = schema.safeParse({
        pageId: 'page-1',
        cells: Array.from({ length: MAX_SHEET_CELLS_PER_EDIT + 1 }, (_, i) => cell(i)),
      });

      expect(atCap.success).toBe(true);
      expect(overCap.success).toBe(false);
      expect(pageWriteTools.edit_sheet_cells.description).toContain(String(MAX_SHEET_CELLS_PER_EDIT));
    });

    it('still rejects an empty batch', () => {
      const schema = pageWriteTools.edit_sheet_cells.inputSchema as z.ZodType<unknown>;
      expect(schema.safeParse({ pageId: 'page-1', cells: [] }).success).toBe(false);
    });

    it('returns error for non-sheet pages', async () => {
      // Arrange: repository returns non-SHEET page
      mockPageRepo.findById.mockResolvedValue({
        id: 'page-1',
        title: 'Document',
        type: 'DOCUMENT',
        content: '',
        contentMode: 'html' as const,
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await pageWriteTools.edit_sheet_cells.execute!(
        { pageId: 'page-1', cells: [{ address: 'A1', value: 'test' }] },
        context
      );

      // Assert: observable error response
      if (!('error' in result)) throw new Error('Expected error result');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Page is not a sheet');
    });
  });
});

// ============================================================================
// Home Drive Guards — trash_drive and restore_drive
// ============================================================================

describe('trash_drive — Home drive guard', () => {
  const context = {
    toolCallId: '1', messages: [],
    experimental_context: { userId: 'user-123' } as ToolExecutionContext,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when trying to trash a Home drive', async () => {
    mockCheckDriveAccess.mockResolvedValue(ownerAccess);
    mockDriveRepo.findById.mockResolvedValue({
      id: 'home-drive',
      name: 'Home',
      slug: 'home',
      ownerId: 'user-123',
      kind: 'HOME',
      isTrashed: false,
      trashedAt: null,
    });

    await expect(
      pageWriteTools.trash_drive.execute!(
        { id: 'home-drive', confirmDriveName: 'Home' },
        context
      )
    ).rejects.toThrow();
  });

  it('driveRepository.findById selects kind column', async () => {
    // This test verifies kind is included in the drive record returned by
    // findById so guards can fire. If kind is missing, Home drives would be
    // silently treated as STANDARD.
    mockCheckDriveAccess.mockResolvedValue(ownerAccess);
    mockDriveRepo.findById.mockResolvedValue({
      id: 'home-drive',
      name: 'Home',
      slug: 'home',
      ownerId: 'user-123',
      kind: 'HOME',
      isTrashed: false,
      trashedAt: null,
    });

    try {
      await pageWriteTools.trash_drive.execute!(
        { id: 'home-drive', confirmDriveName: 'Home' },
        context
      );
    } catch {
      // Expected to throw
    }

    // The key assertion: findById was called (proving kind flows through)
    expect(mockDriveRepo.findById).toHaveBeenCalledWith('home-drive');
  });
});

describe('restore_drive — Home drive guard', () => {
  const context = {
    toolCallId: '1', messages: [],
    experimental_context: { userId: 'user-123' } as ToolExecutionContext,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when trying to restore a Home drive', async () => {
    mockDriveRepo.findByIdAndOwner.mockResolvedValue({
      id: 'home-drive',
      name: 'Home',
      slug: 'home',
      ownerId: 'user-123',
      kind: 'HOME',
      isTrashed: true,  // technically trashed (shouldn't happen, but defensive)
      trashedAt: new Date(),
    });

    await expect(
      pageWriteTools.restore_drive.execute!(
        { id: 'home-drive' },
        context
      )
    ).rejects.toThrow();
  });
});
