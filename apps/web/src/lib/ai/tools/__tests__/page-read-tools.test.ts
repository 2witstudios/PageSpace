import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    query: {
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: vi.fn(),
  getUserAccessLevel: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
  canUserViewPage: vi.fn(),
  isDocumentPage: vi.fn((type) => type === 'DOCUMENT'),
  isAIChatPage: vi.fn((type) => type === 'AI_CHAT'),
  isChannelPage: vi.fn((type) => type === 'CHANNEL'),
  formatContentForAI: vi.fn((content) => content),
  formatSheetForAI: vi.fn(),
  formatTaskListForAI: vi.fn(),
  getPagePath: vi.fn().mockResolvedValue('/drive/page'),
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

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

import { pageReadTools } from '../page-read-tools';
import { db } from '@pagespace/db';
import { getUserDriveAccess } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockGetUserDriveAccess = vi.mocked(getUserDriveAccess);

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

    it('throws error when drive not found', async () => {
      mockGetUserDriveAccess.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageReadTools.list_pages.execute!({ driveId: 'non-existent' }, context)
      ).rejects.toThrow(); // Throws an error when drive access is denied
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

  });
});
