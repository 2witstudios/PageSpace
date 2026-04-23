/**
 * Contract tests for PATCH /api/pages/reorder
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Service delegation → correct parameters passed
 * - Response mapping → service results mapped to HTTP responses
 * - Side effects → broadcast events with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { ReorderResult } from '@/services/api';

// Mock service boundary - this is the ONLY mock of internal implementation
vi.mock('@/services/api', () => ({
  pageReorderService: {
    validateMove: vi.fn(),
    reorderPage: vi.fn(),
  },
}));

// Mock external boundaries (auth, websocket)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  isMCPAuthResult: vi.fn().mockReturnValue(false),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn((driveId, pageId, type, data) => ({
    driveId,
    pageId,
    type,
    ...data,
  })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

// Mock database for capturing current page state
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ parentId: null, position: 0 }]),
        }),
      }),
    }),
  },
  pages: { id: 'id', parentId: 'parentId', position: 'position' },
  eq: vi.fn(),
}));

import { pageReorderService } from '@/services/api';
import { authenticateRequestWithOptions, isAuthError, isMCPAuthResult, checkMCPPageScope } from '@/lib/auth';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (body: Record<string, unknown>) => {
  return new Request('https://example.com/api/pages/reorder', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const successResult: ReorderResult = {
  success: true,
  driveId: mockDriveId,
  pageTitle: 'Test Page',
};

describe('PATCH /api/pages/reorder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    // Default: validation passes
    vi.mocked(pageReorderService.validateMove).mockResolvedValue({ valid: true });
    // Default: reorder succeeds
    vi.mocked(pageReorderService.reorderPage).mockResolvedValue(successResult);
    vi.mocked(auditRequest).mockReturnValue(undefined);
    // @ts-expect-error - partial mock data
    vi.mocked(createPageEventPayload).mockImplementation((driveId: string, pageId: string, type: string, data: Record<string, unknown>) => ({
      driveId, pageId, type, ...data,
    }));
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ parentId: null, position: 0 }]),
        }),
      }),
    } as never);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(401);
      // Service should NOT be called when auth fails
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });
  });

  describe('input validation (Zod schema)', () => {
    it('returns 400 when pageId is missing', async () => {
      const response = await PATCH(createRequest({
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(400);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });

    it('returns 400 when newPosition is missing', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
      }));

      expect(response.status).toBe(400);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });

    it('returns 400 when newPosition is not a number', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 'first',
      }));

      expect(response.status).toBe(400);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });

    it('accepts negative position values (for fractional positioning)', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: -1,
      }));

      expect(response.status).toBe(200);
      expect(pageReorderService.reorderPage).toHaveBeenCalledWith(
        expect.objectContaining({ newPosition: -1 })
      );
    });

    it('accepts fractional position values (for between-item positioning)', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 2.5,
      }));

      expect(response.status).toBe(200);
      expect(pageReorderService.reorderPage).toHaveBeenCalledWith(
        expect.objectContaining({ newPosition: 2.5 })
      );
    });

    it('returns 400 for non-finite position values', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: Infinity,
      }));

      expect(response.status).toBe(400);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });

    it('returns 400 when circular reference is detected', async () => {
      vi.mocked(pageReorderService.validateMove).mockResolvedValue({
        valid: false,
        error: 'Cannot move page into its own descendant',
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'child_page',
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/circular|descendant/i);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });
  });

  describe('service delegation', () => {
    it('passes correct parameters to reorderPage service', async () => {
      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'parent_456',
        newPosition: 5,
      }));

      expect(pageReorderService.reorderPage).toHaveBeenCalledWith({
        pageId: mockPageId,
        newParentId: 'parent_456',
        newPosition: 5,
        userId: mockUserId,
      });
    });
  });

  describe('error responses from service', () => {
    it('returns 403 when user lacks authorization', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: false,
        error: 'Only drive owners and admins can reorder pages.',
        status: 403,
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/owner|admin|permission/i);
      // Side effects should NOT fire on failure
      expect(broadcastPageEvent).not.toHaveBeenCalled();
    });

    it('returns 404 when page is not found', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: false,
        error: 'Page not found.',
        status: 404,
      });

      const response = await PATCH(createRequest({
        pageId: 'nonexistent',
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(404);
      expect(broadcastPageEvent).not.toHaveBeenCalled();
    });

    it('returns 404 when parent page is not found', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: false,
        error: 'Parent page not found.',
        status: 404,
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'nonexistent_parent',
        newPosition: 0,
      }));

      expect(response.status).toBe(404);
    });

    it('returns 400 when moving between different drives', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: false,
        error: 'Cannot move pages between different drives.',
        status: 400,
      });

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'page_in_other_drive',
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/drive/i);
    });

    it('returns 500 when service throws unexpected error', async () => {
      vi.mocked(pageReorderService.reorderPage).mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Database connection failed');
      expect(broadcastPageEvent).not.toHaveBeenCalled();
    });
  });

  describe('success response', () => {
    it('returns 200 with success message', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toMatch(/reorder|success/i);
    });

    it('accepts position 0', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(200);
    });

    it('accepts large position values', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 100,
      }));

      expect(response.status).toBe(200);
    });
  });

  describe('side effects (boundary obligations)', () => {
    it('broadcasts page moved event with correct payload essentials', async () => {
      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: 'parent_456',
        newPosition: 3,
      }));

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'moved',
        expect.objectContaining({
          parentId: 'parent_456',
        })
      );
      // Verify broadcast receives the payload from createPageEventPayload
      expect(broadcastPageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: mockDriveId,
          pageId: mockPageId,
          type: 'moved',
          parentId: 'parent_456',
        })
      );
    });

    it('does NOT broadcast on service failure', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: false,
        error: 'Page not found.',
        status: 404,
      });

      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(broadcastPageEvent).not.toHaveBeenCalled();
    });
  });

  describe('MCP support', () => {
    it('passes MCP metadata when authenticated via MCP', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(pageReorderService.reorderPage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { source: 'mcp' },
        })
      );
    });

    it('returns scope error when MCP page scope check fails', async () => {
      const scopeErrorResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(response.status).toBe(403);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });
  });

  describe('error handling edge cases', () => {
    it('includes page title in broadcast when available', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: true,
        driveId: mockDriveId,
        pageTitle: 'My Page',
      });

      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'moved',
        expect.objectContaining({
          title: 'My Page',
        })
      );
    });

    it('handles null pageTitle in broadcast', async () => {
      vi.mocked(pageReorderService.reorderPage).mockResolvedValue({
        success: true,
        driveId: mockDriveId,
        pageTitle: null,
      });

      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'moved',
        expect.objectContaining({
          title: undefined,
        })
      );
    });

    it('logs error details on non-Error exceptions', async () => {
      vi.mocked(pageReorderService.reorderPage).mockRejectedValueOnce('string error');

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to reorder page');
    });

  });
});
