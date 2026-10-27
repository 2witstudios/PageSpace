import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock at the service seam level
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { emailVerified: 'emailVerified', id: 'id' },
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';

// Test helpers
const createRequest = () =>
  new Request('http://localhost/api/account/verification-status');

const mockSelectChain = (result: unknown[]) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(result);
  vi.mocked(db.select).mockImplementation(chain.select);
  return chain;
};

describe('GET /api/account/verification-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authentication', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('user lookup', () => {
    it('returns 404 when user not found in database', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user-1',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        authTransport: 'cookie',
      });
      mockSelectChain([]);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('successful response', () => {
    it('returns emailVerified status when user is found', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user-1',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        authTransport: 'cookie',
      });
      const verifiedDate = new Date('2024-06-15T00:00:00Z');
      mockSelectChain([{ emailVerified: verifiedDate }]);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.emailVerified).toBe(verifiedDate.toISOString());
    });

    it('returns null emailVerified for unverified user', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user-1',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        authTransport: 'cookie',
      });
      mockSelectChain([{ emailVerified: null }]);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.emailVerified).toBeNull();
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error('DB connection lost'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch verification status');
      consoleSpy.mockRestore();
    });

    it('returns 500 when db query throws', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user-1',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        authTransport: 'cookie',
      });
      const chain: Record<string, ReturnType<typeof vi.fn>> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockRejectedValueOnce(new Error('Query failed'));
      vi.mocked(db.select).mockImplementation(chain.select as never);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch verification status');
      consoleSpy.mockRestore();
    });
  });
});
