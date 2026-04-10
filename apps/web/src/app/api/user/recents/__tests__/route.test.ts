/**
 * Security audit tests for /api/user/recents
 * Verifies securityAudit.logDataAccess is called for GET.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      userPageViews: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
  userPageViews: { userId: 'userId', viewedAt: 'viewedAt' },
  eq: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/lib/client-safe', () => ({
  PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    CHANNEL: 'CHANNEL',
    AI_CHAT: 'AI_CHAT',
    CANVAS: 'CANVAS',
    FILE: 'FILE',
    SHEET: 'SHEET',
    TASK_LIST: 'TASK_LIST',
    CODE: 'CODE',
  },
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

describe('GET /api/user/recents audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs read audit event on successful recents retrieval', async () => {
    await GET(new Request('http://localhost/api/user/recents'));

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'recents', mockUserId
    );
  });
});
