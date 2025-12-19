/**
 * Contract tests for /api/pages/[pageId]
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Service delegation → correct parameters passed
 * - Response mapping → service results mapped to HTTP responses
 * - Side effects → broadcasts/cache with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
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
  agentAwarenessCache: {
    invalidateDriveAgents: vi.fn(),
  },
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
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
}));

vi.mock('@pagespace/lib', () => ({
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/api-utils', () => ({
  jsonResponse: vi.fn((data) => NextResponse.json(data)),
}));

import { pageService } from '@/services/api';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';

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

const mockPage: PageWithDetails = {
  id: mockPageId,
  title: 'Test Page',
  type: 'DOCUMENT',
  content: '<p>Test content</p>',
  parentId: null,
  driveId: mockDriveId,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
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
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (pageService.getPage as Mock).mockResolvedValue(successResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
      expect(pageService.getPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks view permission', async () => {
      (pageService.getPage as Mock).mockResolvedValue({
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
      (pageService.getPage as Mock).mockResolvedValue({
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
      expect(body.children).toBeDefined();
      expect(body.messages).toBeDefined();
    });

    it('passes correct parameters to service', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(pageService.getPage).toHaveBeenCalledWith(mockPageId, mockUserId);
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (pageService.getPage as Mock).mockRejectedValue(new Error('Database error'));

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
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (pageService.updatePage as Mock).mockResolvedValue(successResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(response.status).toBe(401);
      expect(pageService.updatePage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      (pageService.updatePage as Mock).mockResolvedValue({
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
      (pageService.updatePage as Mock).mockResolvedValue({
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
        })
      );
    });
  });

  describe('page update', () => {
    it('returns 200 with updated page on success', async () => {
      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBeDefined();
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
      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('broadcasts content update event with correct payload', async () => {
      (pageService.updatePage as Mock).mockResolvedValue({
        ...successResult,
        updatedFields: ['content'],
      });

      await PATCH(createRequest({ content: '<p>New content</p>' }), { params: mockParams });

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'content-updated',
        expect.any(Object)
      );
      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache on title change', async () => {
      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('invalidates agent cache when AI_CHAT title changes', async () => {
      (pageService.updatePage as Mock).mockResolvedValue({
        ...successResult,
        isAIChatPage: true,
      });

      await PATCH(createRequest({ title: 'AI Agent' }), { params: mockParams });

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('does NOT broadcast or invalidate cache on service failure', async () => {
      (pageService.updatePage as Mock).mockResolvedValue({
        success: false,
        error: 'Not found',
        status: 404,
      });

      await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });

      expect(broadcastPageEvent).not.toHaveBeenCalled();
      expect(pageTreeCache.invalidateDriveTree).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (pageService.updatePage as Mock).mockRejectedValue(new Error('Database error'));

      const response = await PATCH(createRequest({ title: 'Updated' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
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
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (pageService.trashPage as Mock).mockResolvedValue(successResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createRequest({}), { params: mockParams });

      expect(response.status).toBe(401);
      expect(pageService.trashPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks delete permission', async () => {
      (pageService.trashPage as Mock).mockResolvedValue({
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
      (pageService.trashPage as Mock).mockResolvedValue({
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
      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache', async () => {
      await DELETE(createRequest({}), { params: mockParams });

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('invalidates agent cache when AI_CHAT page is trashed', async () => {
      (pageService.trashPage as Mock).mockResolvedValue({
        ...successResult,
        isAIChatPage: true,
      });

      await DELETE(createRequest({}), { params: mockParams });

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('does NOT broadcast or invalidate cache on service failure', async () => {
      (pageService.trashPage as Mock).mockResolvedValue({
        success: false,
        error: 'Page not found',
        status: 404,
      });

      await DELETE(createRequest({}), { params: mockParams });

      expect(broadcastPageEvent).not.toHaveBeenCalled();
      expect(pageTreeCache.invalidateDriveTree).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (pageService.trashPage as Mock).mockRejectedValue(new Error('Database error'));

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
