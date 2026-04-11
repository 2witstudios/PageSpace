/**
 * Security audit tests for /api/activities/[activityId]/rollback-to-point
 * Verifies auditRequest is called for POST (write, rollback_to_point).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExecuteRollbackToPoint = vi.hoisted(() => vi.fn());
const mockPreviewRollbackToPoint = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@/services/api', () => ({
  previewRollbackToPoint: mockPreviewRollbackToPoint,
  executeRollbackToPoint: mockExecuteRollbackToPoint,
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => id),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/server';

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

describe('POST /api/activities/[activityId]/rollback-to-point audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockExecuteRollbackToPoint.mockResolvedValue({
      success: true,
      rolledBackActivities: [],
      affectedPages: [],
      affectedDrives: [],
    });
  });

  it('logs write audit event with rollback_to_point action', async () => {
    const request = new Request('http://localhost/api/activities/activity-1/rollback-to-point', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'page' }),
    });

    await POST(request, { params: Promise.resolve({ activityId: mockActivityId }) });

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'activity', resourceId: mockActivityId, details: { action: 'rollback_to_point' } })
    );
  });
});
