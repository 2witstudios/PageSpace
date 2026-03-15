/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/admin/users
//
// Tests the admin users listing endpoint. Uses withAdminAuth wrapper.
// ============================================================================

// We need to mock withAdminAuth to either pass through or reject.
// The pattern: withAdminAuth wraps a handler (adminUser, request) => Response.
// We mock it so it either invokes the handler with a mock admin user, or returns 403.

let mockAdminUser: { id: string; role: string; tokenVersion: number; adminRoleVersion: number; authTransport: string } | null = null;

vi.mock('@/lib/auth', () => ({
  withAdminAuth: vi.fn((handler: any) => {
    return async (request: Request) => {
      if (!mockAdminUser) {
        return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return handler(mockAdminUser, request);
    };
  }),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn().mockResolvedValue([]),
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue([]),
          groupBy: vi.fn().mockResolvedValue([]),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    })),
    query: {
      users: { findMany: vi.fn() },
    },
  },
  users: { id: 'id', name: 'name', email: 'email', subscriptionTier: 'subscriptionTier', stripeCustomerId: 'stripeCustomerId' },
  drives: { id: 'id', ownerId: 'ownerId' },
  pages: { driveId: 'driveId' },
  chatMessages: { userId: 'userId' },
  messages: { userId: 'userId' },
  userAiSettings: { userId: 'userId', provider: 'provider', baseUrl: 'baseUrl', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  subscriptions: { status: 'status', userId: 'userId', updatedAt: 'updatedAt' },
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib', () => ({
  isOnPrem: vi.fn(() => true),
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

// ============================================================================
// Test Helpers
// ============================================================================

const setAdminAuth = (id = 'admin_1') => {
  mockAdminUser = { id, role: 'admin', tokenVersion: 1, adminRoleVersion: 0, authTransport: 'cookie' };
};

const setNoAuth = () => {
  mockAdminUser = null;
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();

    // Default: empty users
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([]),
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
          groupBy: vi.fn().mockResolvedValue([]),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as any);
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const request = new Request('https://example.com/api/admin/users');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it('should allow admin access', async () => {
      setAdminAuth();

      const request = new Request('https://example.com/api/admin/users');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('success', () => {
    it('should return empty users array when no users exist', async () => {
      const request = new Request('https://example.com/api/admin/users');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toEqual([]);
    });

    it('should return users with stats when users exist', async () => {
      // The route makes 8 db.select calls:
      // 1: Users query (select...from(users).orderBy)
      // 2: Subscriptions query (select...from(subscriptions).where.orderBy)
      // 3-7: Five aggregate count queries in Promise.all (drives, pages, chatMessages, globalMessages, aiSettings)
      //   - Pages query uses innerJoin before where
      // 8: AI settings details query (select...from(userAiSettings).where)
      let selectCallIndex = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallIndex++;
        if (selectCallIndex === 1) {
          // Users query: select().from(users).orderBy()
          return {
            from: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'user_1',
                  name: 'Test User',
                  email: 'test@test.com',
                  emailVerified: new Date(),
                  image: null,
                  currentAiProvider: null,
                  currentAiModel: null,
                  tokenVersion: 0,
                  subscriptionTier: 'free',
                  stripeCustomerId: null,
                },
              ]),
            }),
          } as any;
        }
        if (selectCallIndex === 2) {
          // Subscriptions query: select().from(subscriptions).where().orderBy()
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as any;
        }
        if (selectCallIndex === 8) {
          // AI settings details query: select().from(userAiSettings).where()
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          } as any;
        }
        // Count queries (drives, pages, chatMessages, globalMessages, aiSettings)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        } as any;
      });

      const request = new Request('https://example.com/api/admin/users');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toHaveProperty('stats');
      expect(body.users[0].stats).toHaveProperty('drives');
      expect(body.users[0].stats).toHaveProperty('pages');
      expect(body.users[0].stats).toHaveProperty('totalMessages');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new Request('https://example.com/api/admin/users');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch users data');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/admin/users');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching users:', error);
    });
  });
});
