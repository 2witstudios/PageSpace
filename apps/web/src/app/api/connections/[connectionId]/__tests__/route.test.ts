/**
 * Security audit tests for /api/connections/[connectionId]
 * Verifies auditRequest is called for PATCH (write) and DELETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'conn-1',
            user1Id: 'user_123',
            user2Id: 'user_456',
            status: 'PENDING',
            initiatorId: 'user_456',
          }]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: {},
}));
vi.mock('@pagespace/db/schema/social', () => ({
  connections: { id: 'id', user1Id: 'user1Id', user2Id: 'user2Id', status: 'status' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createNotification: vi.fn(),
  markConnectionRequestActioned: vi.fn(),
}));

import { PATCH, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';
const mockConnectionId = 'conn-1';

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

describe('PATCH /api/connections/[connectionId] audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs write audit event with action on connection update', async () => {
    const request = new Request('http://localhost/api/connections/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });

    await PATCH(request, { params: Promise.resolve({ connectionId: mockConnectionId }) });

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'connection', resourceId: mockConnectionId, details: { action: 'accept' } })
    );
  });
});

describe('DELETE /api/connections/[connectionId] audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs delete audit event on connection deletion', async () => {
    const request = new Request('http://localhost/api/connections/conn-1', { method: 'DELETE' });

    await DELETE(request, { params: Promise.resolve({ connectionId: mockConnectionId }) });

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.delete', userId: mockUserId, resourceType: 'connection', resourceId: mockConnectionId })
    );
  });
});
