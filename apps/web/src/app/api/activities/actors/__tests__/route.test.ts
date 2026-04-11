/**
 * Security audit tests for /api/activities/actors
 * Verifies securityAudit.logDataAccess is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  getAllowedDriveIds: vi.fn().mockReturnValue(null),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    query: {
      users: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
  activityLogs: { userId: 'userId' },
  users: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn().mockResolvedValue(true),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

describe('GET /api/activities/actors audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs read audit event on successful actors retrieval', async () => {
    await GET(new Request('http://localhost/api/activities/actors?context=user'));

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'activity_actors', 'self'
    );
  });
});
