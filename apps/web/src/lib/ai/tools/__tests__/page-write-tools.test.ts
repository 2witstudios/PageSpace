import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    query: {
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  canUserDeletePage: vi.fn(),
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
import { db } from '@pagespace/db';
import { canUserEditPage, canUserDeletePage } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockCanUserDeletePage = vi.mocked(canUserDeletePage);

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
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.replace_lines.execute(
          { path: '/drive/page', pageId: 'page-1', startLine: 1, content: 'new' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.replace_lines.execute(
          { path: '/drive/page', pageId: 'non-existent', startLine: 1, content: 'new' },
          context
        )
      ).rejects.toThrow('Page with ID "non-existent" not found');
    });

    it('returns error for FILE type pages', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'page-1',
        title: 'uploaded.pdf',
        type: 'FILE',
        content: '',
        mimeType: 'application/pdf',
        driveId: 'drive-1',
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.replace_lines.execute(
        { path: '/drive/page', pageId: 'page-1', startLine: 1, content: 'new' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot edit FILE pages');
    });

    it('returns error for SHEET type pages', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'page-1',
        title: 'My Sheet',
        type: 'SHEET',
        content: '',
        driveId: 'drive-1',
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.replace_lines.execute(
        { path: '/drive/page', pageId: 'page-1', startLine: 1, content: 'new' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot use line editing on sheets');
    });

    it('replaces lines in document successfully', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'page-1',
        title: 'Test Doc',
        type: 'DOCUMENT',
        content: 'Line 1\nLine 2\nLine 3',
        driveId: 'drive-1',
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.replace_lines.execute(
        { path: '/drive/page', pageId: 'page-1', startLine: 2, content: 'New Line 2' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.linesReplaced).toBe(1);
    });
  });

  describe('create_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.create_page).toBeDefined();
      expect(pageWriteTools.create_page.description).toContain('Create');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.create_page.execute(
          { driveId: 'drive-1', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive not found', async () => {
      (mockDb.where as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.create_page.execute(
          { driveId: 'non-existent', title: 'New Page', type: 'DOCUMENT' },
          context
        )
      ).rejects.toThrow('Drive with ID "non-existent" not found');
    });
  });

  describe('rename_page', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.rename_page).toBeDefined();
      expect(pageWriteTools.rename_page.description).toContain('title');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.rename_page.execute(
          { path: '/drive/page', pageId: 'page-1', title: 'New Title' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });
  });

  describe('trash', () => {
    it('has correct tool definition', () => {
      expect(pageWriteTools.trash).toBeDefined();
      expect(pageWriteTools.trash.description).toContain('trash');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.trash.execute(
          { type: 'page', id: 'page-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('requires confirmDriveName for trashing drives', async () => {
      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageWriteTools.trash.execute(
          { type: 'drive', id: 'drive-1' },
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
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.restore.execute(
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
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.move_page.execute(
          { path: '/old', pageId: 'page-1', newParentPath: '/new', position: 1 },
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
      const context = { experimental_context: {} };

      await expect(
        pageWriteTools.edit_sheet_cells.execute(
          { pageId: 'page-1', cells: [{ address: 'A1', value: 'test' }] },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error for non-sheet pages', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'page-1',
        title: 'Document',
        type: 'DOCUMENT',
        content: '',
        driveId: 'drive-1',
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await pageWriteTools.edit_sheet_cells.execute(
        { pageId: 'page-1', cells: [{ address: 'A1', value: 'test' }] },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Page is not a sheet');
    });
  });
});
