/**
 * Contract tests for PATCH /api/pages/reorder
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Service delegation → correct parameters passed
 * - Response mapping → service results mapped to HTTP responses
 * - Side effects → broadcast events with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type { ReorderResult } from '@/services/api';

// Mock service boundary - this is the ONLY mock of internal implementation
vi.mock('@/services/api', () => ({
  pageReorderService: {
    validateMove: vi.fn(),
    reorderPage: vi.fn(),
  },
}));

// Mock external boundaries (auth, websocket, cache)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
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

vi.mock('@pagespace/lib/server', () => ({
  pageTreeCache: {
    invalidateDriveTree: vi.fn(),
  },
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
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

// Mock activity logger

import { pageReorderService } from '@/services/api';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { pageTreeCache } from '@pagespace/lib/server';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
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
    vi.clearAllMocks();
    // Default: authenticated user
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    // Default: validation passes
    (pageReorderService.validateMove as Mock).mockResolvedValue({ valid: true });
    // Default: reorder succeeds
    (pageReorderService.reorderPage as Mock).mockResolvedValue(successResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

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

    it('returns 400 for negative position values', async () => {
      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: -1,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/position|non-negative/i);
      expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
    });

    it('returns 400 when circular reference is detected', async () => {
      (pageReorderService.validateMove as Mock).mockResolvedValue({
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
      (pageReorderService.reorderPage as Mock).mockResolvedValue({
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
      expect(pageTreeCache.invalidateDriveTree).not.toHaveBeenCalled();
    });

    it('returns 404 when page is not found', async () => {
      (pageReorderService.reorderPage as Mock).mockResolvedValue({
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
      (pageReorderService.reorderPage as Mock).mockResolvedValue({
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
      (pageReorderService.reorderPage as Mock).mockResolvedValue({
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
      (pageReorderService.reorderPage as Mock).mockRejectedValue(new Error('Database connection failed'));

      const response = await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBeDefined();
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

    it('invalidates page tree cache for the drive', async () => {
      await PATCH(createRequest({
        pageId: mockPageId,
        newParentId: null,
        newPosition: 0,
      }));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('does NOT broadcast or invalidate cache on service failure', async () => {
      (pageReorderService.reorderPage as Mock).mockResolvedValue({
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
      expect(pageTreeCache.invalidateDriveTree).not.toHaveBeenCalled();
    });
  });
});
