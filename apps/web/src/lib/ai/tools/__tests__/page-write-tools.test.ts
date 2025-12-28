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
vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  canUserDeletePage: vi.fn(),
  logPageActivity: vi.fn(),
  logDriveActivity: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  detectPageContentFormat: vi.fn(() => 'text'),
  hashWithPrefix: vi.fn(() => 'content-ref'),
  computePageStateHash: vi.fn(() => 'state-hash'),
  createPageVersion: vi.fn().mockResolvedValue({ id: 'version-1', contentRef: 'content-ref', contentSize: 0 }),
  PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    AI_CHAT: 'AI_CHAT',
    CHANNEL: 'CHANNEL',
    CANVAS: 'CANVAS',
    SHEET: 'SHEET',
    TASK_LIST: 'TASK_LIST',
    FILE: 'FILE',
  },
  isAIChatPage: vi.fn((type) => type === 'AI_CHAT'),
  isDocumentPage: vi.fn((type) => type === 'DOCUMENT'),
  parseSheetContent: vi.fn(() => ({ rowCount: 10, columnCount: 5 })),
  serializeSheetContent: vi.fn(() => ''),
  updateSheetCells: vi.fn((data) => data),
  isValidCellAddress: vi.fn((addr) => /^[A-Z]+\d+$/.test(addr.toUpperCase())),
  isSheetType: vi.fn((type) => type === 'SHEET'),
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
  // Repository seams
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
  },
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

import { pageWriteTools } from '../page-write-tools';
import { canUserEditPage, pageRepository, driveRepository } from '@pagespace/lib/server';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import type { ToolExecutionContext } from '../../core';

const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockPageRepo = vi.mocked(pageRepository);
const mockDriveRepo = vi.mocked(driveRepository);
const mockApplyPageMutation = vi.mocked(applyPageMutation);

describe('page-write-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          updates: { content: 'Line 1\nNew Line 2\nLine 3' },
          updatedFields: ['content'],
        })
      );

      // Activity logging is handled by mutation logging.
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

    it('creates page successfully at root level', async () => {
      // Arrange
      mockDriveRepo.findByIdBasic.mockResolvedValue({
        id: 'drive-1',
        ownerId: 'user-123',
      });
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

      // Act
      const result = await pageWriteTools.create_page.execute!(
        { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
        context
      );

      // Assert: observable outcomes
      if ('error' in result) throw new Error(`Expected success but got error`);
      const success = result as { success: boolean; id: string; title: string };
      expect(success.success).toBe(true);
      expect(success.id).toBe('new-page-1');
      expect(success.title).toBe('New Page');

      // Verify repository was called with correct payload
      expect(mockPageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Page',
          type: 'DOCUMENT',
          content: '',
          position: 1,
          driveId: 'drive-1',
          parentId: null,
          isTrashed: false,
        })
      );

      // Activity logging is handled by mutation logging.
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
          updates: { title: 'New Title' },
          updatedFields: ['title'],
        })
      );

      // Activity logging is handled by mutation logging.
    });
  });

  describe('trash', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.trash).toBeDefined();
      expect(pageWriteTools.trash.description).toContain('trash');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.trash.execute!(
          { type: 'page', id: 'page-1', withChildren: false },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('requires confirmDriveName for trashing drives', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash.execute!(
          { type: 'drive', id: 'drive-1', withChildren: false },
          context
        )
      ).rejects.toThrow('Drive name confirmation is required for trashing drives');
    });
  });

  describe('restore', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.restore).toBeDefined();
      expect(pageWriteTools.restore.description).toContain('Restore');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageWriteTools.restore.execute!(
          { type: 'page', id: 'page-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
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
