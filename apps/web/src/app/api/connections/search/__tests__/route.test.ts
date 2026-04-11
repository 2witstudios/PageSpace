/**
 * Security audit tests for /api/connections/search
 * Verifies securityAudit.logDataAccess is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ email: 'current@test.com' }]),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  },
  users: { id: 'id', email: 'email' },
  userProfiles: {},
  connections: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/server';

const mockUserId = 'user_123';

describe('GET /api/connections/search audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: mockUserId, email: 'current@test.com' } as unknown as Awaited<ReturnType<typeof verifyAuth>>);
  });

  it('logs read audit event on connection search', async () => {
    await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'connection_search', resourceId: 'self' })
    );
  });
});
