/**
 * Contract tests for /api/pages/[pageId]
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Service delegation → correct parameters passed
 * - Response mapping → service results mapped to HTTP responses
 * - Side effects → broadcasts with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { GetPageResult, UpdatePageResult, TrashPageResult, PageWithDetails } from '@/services/api';

// Mock service boundary - this is the ONLY mock of internal implementation
vi.mock('@/services/api', () => ({
  pageService: {
    getPage: vi.fn(),
    updatePage: vi.fn(),
    trashPage: vi.fn(),
  },
}));

// Mock external boundaries
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  // MCP scope check - returns null (allowed) by default for session auth tests
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  isMCPAuthResult: vi.fn().mockReturnValue(false),
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
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  auditRequest: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
}));

vi.mock('@pagespace/lib', () => ({
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/utils/api-utils', () => ({
  jsonResponse: vi.fn((data) => NextResponse.json(data)),
}));

import { pageService } from '@/services/api';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, isMCPAuthResult } from '@/lib/auth';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { auditRequest } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { jsonResponse } from '@pagespace/lib/utils/api-utils';

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

const mockPage: PageWithDetails = {
  id: mockPageId,
  title: 'Test Page',
  type: 'DOCUMENT',
  content: '<p>Test content</p>',
  contentMode: 'html',
  parentId: null,
  driveId: mockDriveId,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  revision: 0,
  stateHash: null,
  isTrashed: false,
  trashedAt: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: null,
  children: [],
  messages: [],
};

describe('GET /api/pages/[pageId]', () => {
  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  const successResult: GetPageResult = {
    success: true,
    page: mockPage,
    driveId: mockDriveId,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    vi.mocked(pageService.getPage).mockResolvedValue(successResult);
    vi.mocked(jsonResponse).mockImplementation((data: unknown) => NextResponse.json(data));
    vi.mocked(auditRequest).mockReturnValue(undefined);
    // @ts-expect-error - partial mock data
    vi.mocked(createPageEventPayload).mockImplementation((driveId: string, pageId: string, type: string, data: Record<string, unknown>) => ({
      driveId, pageId, type, ...data,
    }));
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
      expect(pageService.getPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks view permission', async () => {
      vi.mocked(pageService.getPage).mockResolvedValue({
        success: false,
        error: 'You do not have permission to view this page',
        status: 403,
      });

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(403);
    });
  });

  describe('page retrieval', () => {
    it('returns 404 when page does not exist', async () => {
      vi.mocked(pageService.getPage).mockResolvedValue({
        success: false,
        error: 'Page not found',
        status: 404,
      });

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(404);
    });

    it('returns page with children and messages when found', async () => {
      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('Test Page');
      expect(body.children).toEqual([]);
      expect(body.messages).toEqual([]);
    });

    it('passes correct parameters to service', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(pageService.getPage).toHaveBeenCalledWith(mockPageId, mockUserId);
    });

    it('logs read audit event on successful page retrieval', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'page', resourceId: mockPageId })
      );
    });

    it('does NOT log read audit event when page not found', async () => {
      vi.mocked(pageService.getPage).mockResolvedValue({
        success: false,
        error: 'Page not found',
        status: 404,
      });

      await GET(createRequest(), { params: mockParams });

      expect(auditRequest).not.toHaveBeenCalled();
    });
  });

  describe('MCP scope check', () => {
    it('returns scope error when MCP page scope check fails', async () => {
      const scopeErrorResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(403);
      expect(pageService.getPage).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      vi.mocked(pageService.getPage).mockRejectedValueOnce(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});

describe('PATCH /api/pages/[pageId]', () => {
  const createRequest = (body: Record<string, unknown>) => {
    return new Request(`https://example.com/api/pages/${mockPageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  const successResult: UpdatePageResult = {
    success: true,
    page: mockPage,
    driveId: mockDriveId,
    updatedFields: ['title'],
    isAIChatPage: false,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    vi.mocked(pageService.updatePage).mockResolvedValue(successResult);
    vi.mocked(jsonResponse).mockImplementation((data: unknown) => NextResponse.json(data));
    vi.mocked(auditRequest).mockReturnValue(undefined);
    // @ts-expect-error - partial mock data
    vi.mocked(createPageEventPayload).mockImplementation((driveId: string, pageId: string, type: string, data: Record<string, unknown>) => ({
      driveId, pageId, type, ...data,
    }));
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(response.status).toBe(401);
      expect(pageService.updatePage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      vi.mocked(pageService.updatePage).mockResolvedValue({
        success: false,
        error: 'You need edit permission to modify this page',
        status: 403,
      });

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission/i);
    });
  });

  describe('validation', () => {
    it('returns 400 when parent change creates circular reference', async () => {
      vi.mocked(pageService.updatePage).mockResolvedValue({
        success: false,
        error: 'Cannot move page into its own descendant',
        status: 400,
      });

      const response = await PATCH(
        createRequest({ parentId: 'child_page' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/descendant|circular/i);
    });
  });

  describe('MCP scope check', () => {
    it('returns scope error when MCP page scope check fails', async () => {
      const scopeErrorResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(response.status).toBe(403);
      expect(pageService.updatePage).not.toHaveBeenCalled();
    });
  });

  describe('service delegation', () => {
    it('passes correct parameters to service', async () => {
      await PATCH(
        createRequest({ title: 'Updated Title', content: '<p>New content</p>' }),
        { params: mockParams }
      );

      expect(pageService.updatePage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({
          title: 'Updated Title',
          content: '<p>New content</p>',
        }),
        expect.objectContaining({ expectedRevision: undefined })
      );
    });

    it('passes MCP context when authenticated via MCP', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await PATCH(
        createRequest({ title: 'MCP Update' }),
        { params: mockParams }
      );

      expect(pageService.updatePage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ title: 'MCP Update' }),
        expect.objectContaining({
          context: expect.objectContaining({
            metadata: { source: 'mcp' },
          }),
        })
      );
    });

    it('passes changeGroupId in context when provided', async () => {
      await PATCH(
        createRequest({ title: 'Grouped', changeGroupId: 'group_123' }),
        { params: mockParams }
      );

      expect(pageService.updatePage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ title: 'Grouped' }),
        expect.objectContaining({
          context: expect.objectContaining({
            changeGroupId: 'group_123',
          }),
        })
      );
    });

    it('passes expectedRevision for optimistic concurrency', async () => {
      await PATCH(
        createRequest({ title: 'Concurrent', expectedRevision: 5 }),
        { params: mockParams }
      );

      expect(pageService.updatePage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ title: 'Concurrent' }),
        expect.objectContaining({ expectedRevision: 5 })
      );
    });
  });

  describe('page update', () => {
    it('returns 200 with updated page on success', async () => {
      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('Test Page');
    });
  });

  describe('side effects (boundary obligations)', () => {
    it('broadcasts title update event with correct payload', async () => {
      await PATCH(createRequest({ title: 'Updated Title' }), { params: mockParams });

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'updated',
        expect.objectContaining({
          title: 'Updated Title',
        })
      );
      expect(broadcastPageEvent).toHaveBeenCalledTimes(1);
    });

    it('broadcasts content update event with correct payload', async () => {
      vi.mocked(pageService.updatePage).mockResolvedValue({
        ...successResult,
        updatedFields: ['content'],
      });

      await PATCH(createRequest({ content: '<p>New content</p>' }), { params: mockParams });

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'content-updated',
        { title: 'Test Page', parentId: undefined, socketId: undefined }
      );
      expect(broadcastPageEvent).toHaveBeenCalledTimes(1);
    });

    it('does NOT broadcast on service failure', async () => {
      vi.mocked(pageService.updatePage).mockResolvedValue({
        success: false,
        error: 'Not found',
        status: 404,
      });

      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(broadcastPageEvent).not.toHaveBeenCalled();
    });

    it('tracks page update operation', async () => {
      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(trackPageOperation).toHaveBeenCalledWith(
        mockUserId,
        'update',
        mockPageId,
        expect.objectContaining({
          hasTitleUpdate: true,
        })
      );
    });

    it('logs write audit event on successful page update', async () => {
      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'page', resourceId: mockPageId })
      );
    });

    it('passes Socket-ID header to broadcast', async () => {
      const request = new Request(`https://example.com/api/pages/${mockPageId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Socket-ID': 'socket_abc',
        },
        body: JSON.stringify({ title: 'Updated' }),
      });

      await PATCH(request, { params: mockParams });

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'updated',
        expect.objectContaining({
          socketId: 'socket_abc',
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      vi.mocked(pageService.updatePage).mockRejectedValueOnce(new Error('Database error'));

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 400 for Zod validation errors', async () => {
      // Send a body with invalid type for a field that Zod validates
      const request = new Request(`https://example.com/api/pages/${mockPageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPaginated: 'not-a-boolean' }),
      });

      const response = await PATCH(request, { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('returns update failure with currentRevision info', async () => {
      vi.mocked(pageService.updatePage).mockResolvedValue({
        success: false,
        error: 'Conflict',
        status: 409,
        currentRevision: 10,
        expectedRevision: 5,
      });

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.currentRevision).toBe(10);
      expect(body.expectedRevision).toBe(5);
    });
  });
});

describe('DELETE /api/pages/[pageId]', () => {
  const createRequest = (body: Record<string, unknown> = {}) => {
    return new Request(`https://example.com/api/pages/${mockPageId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  const successResult: TrashPageResult = {
    success: true,
    driveId: mockDriveId,
    pageTitle: 'Test Page',
    pageType: 'DOCUMENT',
    parentId: null,
    isAIChatPage: false,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    vi.mocked(pageService.trashPage).mockResolvedValue(successResult);
    vi.mocked(jsonResponse).mockImplementation((data: unknown) => NextResponse.json(data));
    vi.mocked(auditRequest).mockReturnValue(undefined);
    // @ts-expect-error - partial mock data
    vi.mocked(createPageEventPayload).mockImplementation((driveId: string, pageId: string, type: string, data: Record<string, unknown>) => ({
      driveId, pageId, type, ...data,
    }));
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createRequest({}), { params: mockParams });

      expect(response.status).toBe(401);
      expect(pageService.trashPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks delete permission', async () => {
      vi.mocked(pageService.trashPage).mockResolvedValue({
        success: false,
        error: 'You need delete permission to remove this page',
        status: 403,
      });

      const response = await DELETE(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission/i);
    });
  });

  describe('service delegation', () => {
    it('passes correct parameters to service', async () => {
      await DELETE(createRequest({ trash_children: true }), { params: mockParams });

      expect(pageService.trashPage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        { trashChildren: true }
      );
    });

    it('defaults trashChildren to false', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(pageService.trashPage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        { trashChildren: false }
      );
    });
  });

  describe('page deletion', () => {
    it('returns 200 with success message', async () => {
      const response = await DELETE(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toMatch(/trash|success/i);
    });

    it('returns 404 when page not found', async () => {
      vi.mocked(pageService.trashPage).mockResolvedValue({
        success: false,
        error: 'Page not found',
        status: 404,
      });

      const response = await DELETE(createRequest({}), { params: mockParams });

      expect(response.status).toBe(404);
    });
  });

  describe('side effects (boundary obligations)', () => {
    it('broadcasts trashed event with correct payload', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'trashed',
        expect.objectContaining({
          title: 'Test Page',
        })
      );
      expect(broadcastPageEvent).toHaveBeenCalledTimes(1);
    });

    it('does NOT broadcast on service failure', async () => {
      vi.mocked(pageService.trashPage).mockResolvedValue({
        success: false,
        error: 'Page not found',
        status: 404,
      });

      await DELETE(createRequest({}), { params: mockParams });

      expect(broadcastPageEvent).not.toHaveBeenCalled();
    });
  });

  describe('MCP scope check', () => {
    it('returns scope error when MCP page scope check fails', async () => {
      const scopeErrorResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await DELETE(createRequest({}), { params: mockParams });

      expect(response.status).toBe(403);
      expect(pageService.trashPage).not.toHaveBeenCalled();
    });
  });

  describe('service delegation (MCP)', () => {
    it('passes MCP metadata when authenticated via MCP', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await DELETE(createRequest({}), { params: mockParams });

      expect(pageService.trashPage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({
          metadata: { source: 'mcp' },
        })
      );
    });
  });

  describe('empty body handling', () => {
    it('handles request with no JSON body gracefully', async () => {
      const request = new Request(`https://example.com/api/pages/${mockPageId}`, {
        method: 'DELETE',
        // No body at all
      });

      const response = await DELETE(request, { params: mockParams });

      expect(response.status).toBe(200);
      expect(pageService.trashPage).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ trashChildren: false })
      );
    });
  });

  describe('activity tracking', () => {
    it('tracks page trash operation', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(trackPageOperation).toHaveBeenCalledWith(
        mockUserId,
        'trash',
        mockPageId,
        expect.objectContaining({
          trashChildren: false,
          pageTitle: 'Test Page',
          pageType: 'DOCUMENT',
        })
      );
    });

    it('logs delete audit event on successful page trash', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ eventType: 'data.delete', userId: mockUserId, resourceType: 'page', resourceId: mockPageId })
      );
    });

  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      vi.mocked(pageService.trashPage).mockRejectedValueOnce(new Error('Database error'));

      const response = await DELETE(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 400 for invalid body schema', async () => {
      const response = await DELETE(
        createRequest({ trash_children: 'not_a_boolean' }),
        { params: mockParams }
      );

      expect(response.status).toBe(400);
    });
  });
});
