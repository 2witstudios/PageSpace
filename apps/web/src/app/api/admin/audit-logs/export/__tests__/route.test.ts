/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/admin/audit-logs/export
//
// Tests admin audit log CSV export with streaming.
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
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn().mockResolvedValue([]),
              })),
            })),
          })),
        })),
      })),
    })),
  },
  activityLogs: {
    id: 'id',
    timestamp: 'timestamp',
    userId: 'userId',
    actorEmail: 'actorEmail',
    actorDisplayName: 'actorDisplayName',
    isAiGenerated: 'isAiGenerated',
    aiProvider: 'aiProvider',
    aiModel: 'aiModel',
    aiConversationId: 'aiConversationId',
    operation: 'operation',
    resourceType: 'resourceType',
    resourceId: 'resourceId',
    resourceTitle: 'resourceTitle',
    driveId: 'driveId',
    pageId: 'pageId',
    updatedFields: 'updatedFields',
    previousValues: 'previousValues',
    newValues: 'newValues',
    metadata: 'metadata',
    isArchived: 'isArchived',
    previousLogHash: 'previousLogHash',
    logHash: 'logHash',
    chainSeed: 'chainSeed',
  },
  users: {
    id: 'id',
    name: 'name',
    email: 'email',
  },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('date-fns', () => ({
  format: vi.fn((_date: Date, _fmt: string) => '2024-01-01_00-00-00'),
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

function setupDbForStreaming(batches: any[][]): void {
  let callIndex = 0;
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockImplementation(() => {
                const result = batches[callIndex] || [];
                callIndex++;
                return Promise.resolve(result);
              }),
            }),
          }),
        }),
      }),
    }),
  } as any);
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/audit-logs/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();
    setupDbForStreaming([[]]);
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it('should allow admin access', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('validation', () => {
    it('should return 400 for unsupported format', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export?format=json');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Unsupported format. Only CSV is supported.');
    });

    it('should accept csv format (default)', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should accept explicit csv format', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export?format=csv');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('success - CSV streaming', () => {
    it('should return response with correct content type headers', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);

      expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('Content-Disposition')).toContain('attachment; filename=');
      expect(response.headers.get('Content-Disposition')).toContain('audit-logs_');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    });

    it('should include CSV header row in stream', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);
      const text = await response.text();

      // CSV header should contain expected columns
      expect(text).toContain('id,');
      expect(text).toContain('timestamp,');
      expect(text).toContain('operation,');
    });

    it('should stream log entries as CSV rows', async () => {
      setupDbForStreaming([
        [
          {
            id: 'log_1',
            timestamp: new Date('2024-01-01'),
            userId: 'user_1',
            actorEmail: 'test@test.com',
            actorDisplayName: 'Test User',
            isAiGenerated: false,
            aiProvider: null,
            aiModel: null,
            aiConversationId: null,
            operation: 'update',
            resourceType: 'page',
            resourceId: 'page_1',
            resourceTitle: 'Test Page',
            driveId: 'drive_1',
            pageId: 'page_1',
            updatedFields: null,
            previousValues: null,
            newValues: null,
            metadata: null,
            isArchived: false,
            previousLogHash: null,
            logHash: 'abc123',
            chainSeed: null,
            userName: 'Test User',
            userEmail: 'test@test.com',
          },
        ],
      ]);

      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);
      const text = await response.text();

      // Should have header row + at least one data row
      const lines = text.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('filter parameters', () => {
    it('should accept userId filter', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export?userId=user_1');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should accept operation filter', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export?operation=update');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should accept resourceType filter', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export?resourceType=page');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should accept date range filters', async () => {
      const request = new Request(
        'https://example.com/api/admin/audit-logs/export?dateFrom=2024-01-01&dateTo=2024-12-31'
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should accept search filter', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/export?search=test');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should handle stream error when db.select fails during streaming', async () => {
      // db.select throws inside the ReadableStream start callback,
      // so the response is still 200 (stream created) but the stream errors.
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('DB connection failed');
      });

      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);

      // The response is created before the stream starts, so status is 200
      expect(response.status).toBe(200);

      // Reading the body triggers the stream which encounters the error
      try {
        await response.text();
      } catch {
        // Stream error is expected
      }

      // The inner catch logs with 'Error streaming audit logs export:'
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error streaming audit logs export:',
        expect.any(Error)
      );
    });

    it('should log streaming error when db query fails', async () => {
      const error = new Error('Export failed');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/admin/audit-logs/export');
      const response = await GET(request);

      try {
        await response.text();
      } catch {
        // Stream error is expected
      }

      expect(loggers.api.error).toHaveBeenCalledWith('Error streaming audit logs export:', error);
    });
  });
});
