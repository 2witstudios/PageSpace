import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    selectDistinct: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    limit: vi.fn(),
    query: {
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', driveId: 'driveId', content: 'content', title: 'title' },
  drives: { id: 'id', isTrashed: 'isTrashed' },
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
}));

import { searchTools } from '../search-tools';
import { getUserDriveAccess } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockGetUserDriveAccess = vi.mocked(getUserDriveAccess);

describe('search-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('regex_search', () => {
    it('has correct tool definition', () => {
      expect(searchTools.regex_search).toBeDefined();
      expect(searchTools.regex_search.description).toBeDefined();
      // Uses 'regular expression' not 'regex' in description
      expect(searchTools.regex_search.description).toContain('regular expression');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        searchTools.regex_search.execute(
          { driveId: 'drive-1', pattern: 'TODO.*' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive access denied', async () => {
      mockGetUserDriveAccess.mockResolvedValue(null);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        searchTools.regex_search.execute(
          { driveId: 'drive-1', pattern: 'TODO.*' },
          context
        )
      ).rejects.toThrow("You don't have access to this drive");
    });

  });

  describe('glob_search', () => {
    it('has correct tool definition', () => {
      expect(searchTools.glob_search).toBeDefined();
      expect(searchTools.glob_search.description).toBeDefined();
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        searchTools.glob_search.execute(
          { driveId: 'drive-1', pattern: '**/README*' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive access denied', async () => {
      mockGetUserDriveAccess.mockResolvedValue(null);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        searchTools.glob_search.execute(
          { driveId: 'drive-1', pattern: '**/README*' },
          context
        )
      ).rejects.toThrow("You don't have access to this drive");
    });

  });

  describe('multi_drive_search', () => {
    it('has correct tool definition', () => {
      expect(searchTools.multi_drive_search).toBeDefined();
      expect(searchTools.multi_drive_search.description).toBeDefined();
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        searchTools.multi_drive_search.execute(
          { searchQuery: 'test' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });
  });
});
