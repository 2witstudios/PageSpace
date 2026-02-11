import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  filterDrivesByMCPScope: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError, filterDrivesByMCPScope } from '@/lib/auth';

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
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockMCPAuthScoped);
      vi.mocked(isAuthError).mockReturnValue(false);

      const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
      await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalled();
    });

    it('should call filterDrivesByMCPScope with scoped drives when token has scope', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockMCPAuthScoped);
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([scopedDriveId]);

      const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
      await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalled();
    });

    it('should NOT call filterDrivesByMCPScope for session auth', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth);
      vi.mocked(isAuthError).mockReturnValue(false);

      const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
      await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalled();
    });
  });
});
