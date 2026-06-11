import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getPrincipalDriveIds: vi.fn(),
  getPrincipalBatchPagePermissions: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          as: vi.fn().mockReturnValue({}),
        }),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', title: 'title', content: 'content', type: 'type', isTrashed: 'isTrashed', updatedAt: 'updatedAt' },
  drives: { id: 'id', name: 'name', slug: 'slug', isTrashed: 'isTrashed' },
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn().mockReturnValue(20),
}));

import { authenticateRequestWithOptions, isAuthError, getPrincipalDriveIds } from '@/lib/auth';

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

describe('GET /api/search/multi-drive - principal drive universe', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('searches only the principal drive universe for a scoped MCP token', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockMCPAuthScoped);
    vi.mocked(isAuthError).mockReturnValue(false);
    // Scoped token: getPrincipalDriveIds returns the token's own memberships.
    // Empty here to trigger the early return (no drives accessible).
    vi.mocked(getPrincipalDriveIds).mockResolvedValue([]);

    const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
    const response = await GET(request);

    expect(getPrincipalDriveIds).toHaveBeenCalledWith(mockMCPAuthScoped);
    expect(response.status).toBe(200); // Returns success with empty results
  });

  it('uses the principal universe for session auth too (user drives)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth);
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getPrincipalDriveIds).mockResolvedValue([]);

    const request = new Request('https://example.com/api/search/multi-drive?searchQuery=test');
    const response = await GET(request);

    expect(getPrincipalDriveIds).toHaveBeenCalledWith(mockSessionAuth);
    expect(response.status).toBe(200);
  });
});
