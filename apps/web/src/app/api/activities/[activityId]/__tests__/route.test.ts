/**
 * Security audit tests for /api/activities/[activityId]
 * Verifies auditRequest is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetActivityById = vi.hoisted(() => vi.fn());
const mockPreviewRollback = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
}));

vi.mock('@/services/api', () => ({
  getActivityById: mockGetActivityById,
  previewRollback: mockPreviewRollback,
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  isUserDriveMember: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';
const mockActivityId = 'activity-1';

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

describe('GET /api/activities/[activityId] audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetActivityById.mockResolvedValue({ id: mockActivityId, userId: mockUserId, pageId: 'page-1' });
    mockPreviewRollback.mockResolvedValue({ eligible: true });
  });

  it('logs read audit event on successful activity retrieval', async () => {
    await GET(
      new Request('http://localhost/api/activities/activity-1?context=page'),
      { params: Promise.resolve({ activityId: mockActivityId }) }
    );

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'activity', resourceId: mockActivityId })
    );
  });
});
