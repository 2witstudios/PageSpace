/**
 * Contract tests for POST /api/pages
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Service delegation → correct parameters passed
 * - Response mapping → service results mapped to HTTP responses
 * - Side effects → broadcasts/cache with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { CreatePageResult, PageData } from '@/services/api';

// Mock service boundary - this is the ONLY mock of internal implementation
vi.mock('@/services/api', () => ({
  pageService: {
    createPage: vi.fn(),
  },
}));

// Mock external boundaries
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPCreateScope: vi.fn(() => null), // Allow all creates by default
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
    invalidateDriveAgents: vi.fn().mockResolvedValue(undefined),
  },
  pageTreeCache: {
    invalidateDriveTree: vi.fn().mockResolvedValue(undefined),
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

import { pageService } from '@/services/api';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';

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

const mockPage: PageData = {
  id: mockPageId,
  title: 'New Page',
  type: 'DOCUMENT',
  content: '<p></p>',
  parentId: null,
  driveId: mockDriveId,
  position: 1,
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
};

describe('POST /api/pages', () => {
  const createRequest = (body: Record<string, unknown>) => {
    return new Request('https://example.com/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const successResult: CreatePageResult = {
    success: true,
    page: mockPage,
    driveId: mockDriveId,
    isAIChatPage: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (pageService.createPage as Mock).mockResolvedValue(successResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(response.status).toBe(401);
      expect(pageService.createPage).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 when title is missing', async () => {
      // Route-level Zod validation - service not called
      const response = await POST(createRequest({
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
      expect(pageService.createPage).not.toHaveBeenCalled();
    });

    it('returns 400 when type is missing', async () => {
      // Route-level Zod validation - service not called
      const response = await POST(createRequest({
        title: 'Test Page',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
      expect(pageService.createPage).not.toHaveBeenCalled();
    });

    it('returns 400 when driveId is missing', async () => {
      // Route-level Zod validation - service not called
      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
      expect(pageService.createPage).not.toHaveBeenCalled();
    });

    it('returns 400 when page validation fails', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        success: false,
        error: 'Title too long. Invalid characters in title',
        status: 400,
      });

      const response = await POST(createRequest({
        title: 'x'.repeat(1000),
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when AI chat tool validation fails', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        success: false,
        error: 'Unknown tool: invalid_tool',
        status: 400,
      });

      const response = await POST(createRequest({
        title: 'AI Chat',
        type: 'AI_CHAT',
        driveId: mockDriveId,
        enabledTools: ['invalid_tool'],
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/tool/i);
    });
  });

  describe('authorization', () => {
    it('returns 404 when drive does not exist', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        success: false,
        error: 'Drive not found',
        status: 404,
      });

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: 'nonexistent_drive',
      }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });

    it('returns 403 when user is not owner or admin', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        success: false,
        error: 'Only drive owners and admins can create pages',
        status: 403,
      });

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/owner|admin/i);
    });
  });

  describe('service delegation', () => {
    it('passes correct parameters to service', async () => {
      await POST(createRequest({
        title: 'New Document',
        type: 'DOCUMENT',
        driveId: mockDriveId,
        parentId: 'parent_123',
        content: '<p>Custom content</p>',
      }));

      expect(pageService.createPage).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          title: 'New Document',
          type: 'DOCUMENT',
          driveId: mockDriveId,
          parentId: 'parent_123',
          content: '<p>Custom content</p>',
        })
      );
    });

    it('passes AI settings for AI_CHAT pages', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        ...successResult,
        isAIChatPage: true,
        page: { ...mockPage, type: 'AI_CHAT' },
      });

      await POST(createRequest({
        title: 'AI Assistant',
        type: 'AI_CHAT',
        driveId: mockDriveId,
        systemPrompt: 'You are a helpful assistant',
        enabledTools: ['read_page'],
        aiProvider: 'anthropic',
        aiModel: 'claude-3',
      }));

      expect(pageService.createPage).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          systemPrompt: 'You are a helpful assistant',
          enabledTools: ['read_page'],
          aiProvider: 'anthropic',
          aiModel: 'claude-3',
        })
      );
    });
  });

  describe('page creation', () => {
    it('returns 201 with created page on success', async () => {
      const response = await POST(createRequest({
        title: 'New Document',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.id).toBe(mockPageId);
      expect(body.title).toBe('New Page');
    });

    it('creates FOLDER page successfully', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        ...successResult,
        page: { ...mockPage, type: 'FOLDER' },
      });

      const response = await POST(createRequest({
        title: 'New Folder',
        type: 'FOLDER',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.type).toBe('FOLDER');
    });

    it('creates AI_CHAT page successfully', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        ...successResult,
        isAIChatPage: true,
        page: { ...mockPage, type: 'AI_CHAT' },
      });

      const response = await POST(createRequest({
        title: 'AI Chat',
        type: 'AI_CHAT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.type).toBe('AI_CHAT');
    });
  });

  describe('side effects (boundary obligations)', () => {
    it('broadcasts page created event with correct payload from result values', async () => {
      // Mock service to return specific values that should be used in broadcast
      (pageService.createPage as Mock).mockResolvedValue({
        success: true,
        page: { ...mockPage, title: 'Created Document', parentId: 'parent_123' },
        driveId: mockDriveId,
        isAIChatPage: false,
      });

      await POST(createRequest({
        title: 'Input Title',  // Route should use result values, not input
        type: 'DOCUMENT',
        driveId: mockDriveId,
        parentId: 'input_parent',  // Route should use result values, not input
      }));

      // Verify route uses result.page values, not request body values
      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'created',
        expect.objectContaining({
          title: 'Created Document',  // From result.page.title
          type: 'DOCUMENT',
          parentId: 'parent_123',  // From result.page.parentId
        })
      );
      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('invalidates page tree cache', async () => {
      await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('invalidates agent awareness cache for AI_CHAT pages', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        ...successResult,
        isAIChatPage: true,
      });

      await POST(createRequest({
        title: 'AI Chat',
        type: 'AI_CHAT',
        driveId: mockDriveId,
      }));

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('does not invalidate agent cache for non-AI pages', async () => {
      await POST(createRequest({
        title: 'Document',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));

      expect(agentAwarenessCache.invalidateDriveAgents).not.toHaveBeenCalled();
    });

    it('does NOT broadcast or invalidate cache on service failure', async () => {
      (pageService.createPage as Mock).mockResolvedValue({
        success: false,
        error: 'Drive not found',
        status: 404,
      });

      await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: 'nonexistent',
      }));

      expect(broadcastPageEvent).not.toHaveBeenCalled();
      expect(pageTreeCache.invalidateDriveTree).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (pageService.createPage as Mock).mockRejectedValue(new Error('Database error'));

      const response = await POST(createRequest({
        title: 'Test Page',
        type: 'DOCUMENT',
        driveId: mockDriveId,
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
