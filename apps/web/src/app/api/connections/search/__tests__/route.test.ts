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
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';

const mockUserId = 'user_123';

describe('GET /api/connections/search audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: mockUserId, email: 'current@test.com' } as ReturnType<typeof verifyAuth> extends Promise<infer T> ? T : never);
  });

  it('logs read audit event on connection search', async () => {
    await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'connection_search', 'self'
    );
  });
});
