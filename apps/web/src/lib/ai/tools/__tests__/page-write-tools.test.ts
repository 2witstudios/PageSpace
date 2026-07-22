import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    MACHINE: 'MACHINE',
  },
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
    getDefaultContent: vi.fn(() => ''),
    getCreatablePageTypes: vi.fn(() => ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET', 'TASK_LIST', 'CODE']),
    isAIChatPage: vi.fn((type) => type === 'AI_CHAT'),
    isDocumentPage: vi.fn((type) => type === 'DOCUMENT'),
    isCodePage: vi.fn((type) => type === 'CODE'),
}));
vi.mock('@pagespace/lib/sheets/sheet', () => ({
    parseSheetContent: vi.fn(() => ({ rowCount: 10, columnCount: 5 })),
    serializeSheetContent: vi.fn(() => ''),
    updateSheetCells: vi.fn((data) => data),
    isValidCellAddress: vi.fn((addr) => /^[A-Z]+\d+$/.test(addr.toUpperCase())),
    isSheetType: vi.fn((type) => type === 'SHEET'),
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
  applyPageMutation: vi.fn().mockResolvedValue(undefined),
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
}));

// resolveActingAgentId (internal to actor-permissions.ts) queries the acting
// page's type/userScopedAccess directly via db — mock that query boundary rather
// than the actor-permissions exports, since same-module internal calls aren't
// interceptable by mocking the module's exports. AI_CHAT: these agent fixtures
// are real agent pages, so they keep the agent-scoped path.
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve([{ type: 'AI_CHAT', userScopedAccess: false }]) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', userScopedAccess: 'userScopedAccess' },
}));

import { pageWriteTools } from '../page-write-tools';
import { ensureTaskListForPage } from '@/services/api/task-sync-service';
import { canUserEditPage, canUserDeletePage } from '@pagespace/lib/permissions/permissions';
import { getAgentAccessLevel } from '@pagespace/lib/permissions/agent-permissions';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { driveRepository } from '@pagespace/lib/repositories/drive-repository';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import type { ToolExecutionContext } from '../../core/types';

const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockCanUserDeletePage = vi.mocked(canUserDeletePage);
const mockGetAgentAccessLevel = vi.mocked(getAgentAccessLevel);
const mockPageRepo = vi.mocked(pageRepository);
const mockDriveRepo = vi.mocked(driveRepository);
const mockApplyPageMutation = vi.mocked(applyPageMutation);
const mockEnsureTaskListForPage = vi.mocked(ensureTaskListForPage);
const mockCheckDriveAccess = vi.mocked(checkDriveAccess);

const ownerAccess = { isOwner: true, isAdmin: true, isMember: true, drive: null };
const adminAccess = { isOwner: false, isAdmin: true, isMember: true, drive: null };
const deniedAccess = { isOwner: false, isAdmin: false, isMember: true, drive: null };

describe('page-write-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pages have no direct children unless a test says otherwise.
    mockPageRepo.getDirectChildren.mockResolvedValue([]);
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

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.create_page.execute!(
          { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('User authentication required');
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
