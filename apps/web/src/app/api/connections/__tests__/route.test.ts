/**
 * Security audit tests for /api/connections
 * Verifies securityAudit.logDataAccess is called for GET (read) and POST (write).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  connections: {},
  users: {},
  userProfiles: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  createNotification: vi.fn(),
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/server';

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

describe('GET /api/connections audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs read audit event on successful connections retrieval', async () => {
    await GET(new Request('http://localhost/api/connections'));

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'connections', resourceId: 'self' })
    );
  });
});

describe('POST /api/connections audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs write audit event on connection request', async () => {
    const request = new Request('http://localhost/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user_456' }),
    });

    await POST(request);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'connection', resourceId: 'self' })
    );
  });
});
