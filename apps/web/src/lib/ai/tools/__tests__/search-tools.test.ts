import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the boundary we actually test
vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: vi.fn(),
}));

import { searchTools } from '../search-tools';
import { getUserDriveAccess } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockGetUserDriveAccess = vi.mocked(getUserDriveAccess);

/**
 * @scaffold - happy path coverage deferred
 *
 * These tests cover authentication and authorization error paths.
 * Happy path tests (actual search results, filtering, pagination) are deferred
 * because they require either:
 * - A SearchRepository seam to avoid complex DB iteration mocking, OR
 * - Integration tests against a real database with seeded content
 *
 * The search logic involves iterating over pages and matching patterns,
 * which is impractical to mock without coupling to implementation details.
 *
 * TODO: Add SearchService seam with methods like:
 * - searchByRegex(driveId, pattern, options): SearchResult[]
 * - searchByGlob(driveId, pattern, options): SearchResult[]
 * Then test happy paths against that seam.
 */
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
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        searchTools.regex_search.execute!(
          { driveId: 'drive-1', pattern: 'TODO.*', searchIn: 'both', maxResults: 10 },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive access denied', async () => {
      mockGetUserDriveAccess.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        searchTools.regex_search.execute!(
          { driveId: 'drive-1', pattern: 'TODO.*', searchIn: 'both', maxResults: 10 },
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
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        searchTools.glob_search.execute!(
          { driveId: 'drive-1', pattern: '**/README*', maxResults: 10 },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive access denied', async () => {
      mockGetUserDriveAccess.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        searchTools.glob_search.execute!(
          { driveId: 'drive-1', pattern: '**/README*', maxResults: 10 },
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
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        searchTools.multi_drive_search.execute!(
          { searchQuery: 'test', searchType: 'text', maxResultsPerDrive: 5 },
          context
        )
      ).rejects.toThrow('User authentication required');
    });
  });
});
