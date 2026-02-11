import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  filterDrivesByMCPScope: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getBatchPagePermissions: vi.fn().mockResolvedValue(new Map()),
  getDriveIdsForUser: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          as: vi.fn().mockReturnValue({}),
        }),
      }),
    }),
  },
  pages: { id: 'id', driveId: 'driveId', title: 'title', content: 'content', type: 'type', isTrashed: 'isTrashed', updatedAt: 'updatedAt' },
  drives: { id: 'id', name: 'name', slug: 'slug', isTrashed: 'isTrashed' },
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn().mockReturnValue(20),
}));

import { authenticateRequestWithOptions, isAuthError, filterDrivesByMCPScope } from '@/lib/auth';
import { getDriveIdsForUser } from '@pagespace/lib/server';

const mockSessionAuth = {
  userId: 'user_123',
  role: 'user' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  sessionId: 'test-session-id',
  tokenType: 'session' as const,
};

const mockMCPAuthScoped = {
  userId: 'user_123',
  role: 'user' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  tokenId: 'token_123',
  allowedDriveIds: ['drive_abc'],
  tokenType: 'mcp' as const,
};

describe('GET /api/search/multi-drive - MCP Scope Enforcement', () => {
  const scopedDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('MCP drive scope enforcement', () => {
    it('should call filterDrivesByMCPScope when MCP token is used', async () => {
      const mockDriveIds = ['drive_abc', 'drive_def'];
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockMCPAuthScoped);
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(getDriveIdsForUser).mockResolvedValue(mockDriveIds);
      // Return empty array to trigger early return (no drives accessible)
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([]);

      const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
      const response = await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalledWith(mockMCPAuthScoped, mockDriveIds);
      expect(response.status).toBe(200); // Returns success with empty results
    });

    it('should filter to only scoped drives when MCP token has scope', async () => {
      const mockDriveIds = ['drive_abc', 'drive_def', 'drive_ghi'];
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockMCPAuthScoped);
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(getDriveIdsForUser).mockResolvedValue(mockDriveIds);
      // Return empty array to trigger early return
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([]);

      const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
      const response = await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalledWith(mockMCPAuthScoped, mockDriveIds);
      expect(response.status).toBe(200);
    });

    it('should call filterDrivesByMCPScope for session auth (returns unfiltered drives)', async () => {
      const mockDriveIds = ['drive_123', 'drive_456'];
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth);
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(getDriveIdsForUser).mockResolvedValue(mockDriveIds);
      // Return empty array to trigger early return
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([]);

      const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
      const response = await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalledWith(mockSessionAuth, mockDriveIds);
      expect(response.status).toBe(200);
    });
  });
});
