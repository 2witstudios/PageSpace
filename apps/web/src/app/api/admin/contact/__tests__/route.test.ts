/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/admin/contact
//
// Tests admin contact submissions listing with pagination and search.
// Note: Despite the task listing this as POST, the source file exports GET.
// ============================================================================

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
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              offset: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      })),
    })),
  },
  contactSubmissions: {
    id: 'id',
    name: 'name',
    email: 'email',
    subject: 'subject',
    message: 'message',
    createdAt: 'createdAt',
  },
  asc: vi.fn(),
  desc: vi.fn(),
  ilike: vi.fn(),
  or: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn((value: string | null, opts: { defaultValue: number }) => {
    if (!value) return opts.defaultValue;
    return parseInt(value, 10) || opts.defaultValue;
  }),
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

// Helper to configure db.select chain for both count and data queries
function setupDbSelectMock(
  totalCount: number,
  submissions: any[]
): void {
  let callIndex = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callIndex++;
    if (callIndex === 1) {
      // Count query
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: totalCount }]),
        }),
      } as any;
    }
    // Data query
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue(submissions),
            }),
          }),
        }),
      }),
    } as any;
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();
    setupDbSelectMock(0, []);
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const request = new Request('https://example.com/api/admin/contact');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it('should allow admin access', async () => {
      const request = new Request('https://example.com/api/admin/contact');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('success', () => {
    it('should return empty submissions with pagination', async () => {
      const request = new Request('https://example.com/api/admin/contact');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.submissions).toEqual([]);
      expect(body.pagination).toHaveProperty('page');
      expect(body.pagination).toHaveProperty('pageSize');
      expect(body.pagination).toHaveProperty('total');
      expect(body.pagination).toHaveProperty('totalPages');
      expect(body.pagination).toHaveProperty('hasNextPage');
      expect(body.pagination).toHaveProperty('hasPrevPage');
    });

    it('should return submissions with correct shape', async () => {
      const mockSubmissions = [
        {
          id: 'sub_1',
          name: 'John',
          email: 'john@test.com',
          subject: 'Help',
          message: 'Need assistance',
          createdAt: new Date('2024-01-01'),
        },
      ];
      setupDbSelectMock(1, mockSubmissions);

      const request = new Request('https://example.com/api/admin/contact');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toHaveProperty('id');
      expect(body.submissions[0]).toHaveProperty('name');
      expect(body.submissions[0]).toHaveProperty('email');
    });

    it('should include meta information', async () => {
      const request = new Request('https://example.com/api/admin/contact?search=test&sortBy=name&sortOrder=asc');
      const response = await GET(request);
      const body = await response.json();

      expect(body.meta).toEqual({
        searchTerm: 'test',
        sortBy: 'name',
        sortOrder: 'asc',
      });
    });

    it('should default to createdAt desc when no sort specified', async () => {
      const request = new Request('https://example.com/api/admin/contact');
      const response = await GET(request);
      const body = await response.json();

      expect(body.meta.sortBy).toBe('createdAt');
      expect(body.meta.sortOrder).toBe('desc');
    });
  });

  describe('pagination', () => {
    it('should calculate hasNextPage correctly', async () => {
      setupDbSelectMock(100, []);

      const request = new Request('https://example.com/api/admin/contact?page=1&pageSize=50');
      const response = await GET(request);
      const body = await response.json();

      expect(body.pagination.hasNextPage).toBe(true);
      expect(body.pagination.hasPrevPage).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new Request('https://example.com/api/admin/contact');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch contact submissions');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/admin/contact');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching contact submissions:', error);
    });
  });
});
