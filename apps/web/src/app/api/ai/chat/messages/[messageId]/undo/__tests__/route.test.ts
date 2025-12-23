/**
 * Contract tests for /api/ai/chat/messages/[messageId]/undo
 *
 * Tests both GET (preview) and POST (execute) handlers:
 * - Authentication: 401 for unauthenticated
 * - Authorization: 403 when user can't edit page
 * - Not found: 404 when message doesn't exist
 * - Validation: 400 for invalid mode
 * - Success: 200 with preview/result data
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock service boundary
vi.mock('@/services/api', () => ({
  previewAiUndo: vi.fn(),
  executeAiUndo: vi.fn(),
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

// Mock repository
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getConversationById: vi.fn(),
  },
}));

// Mock permissions
vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

// Mock logging mask
vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id.slice(-4)}`),
}));

import { previewAiUndo, executeAiUndo } from '@/services/api';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { canUserEditPage } from '@pagespace/lib/server';

// Test helpers
const mockUserId = 'user_123';
const mockMessageId = 'msg_123';
const mockPageId = 'page_123';

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

const createGetRequest = () => {
  return new Request(`https://example.com/api/ai/chat/messages/${mockMessageId}/undo`, {
    method: 'GET',
  });
};

const createPostRequest = (body: object) => {
  return new Request(`https://example.com/api/ai/chat/messages/${mockMessageId}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const mockParams = Promise.resolve({ messageId: mockMessageId });

describe('GET /api/ai/chat/messages/[messageId]/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (previewAiUndo as Mock).mockResolvedValue({
      source: 'page_chat',
      pageId: mockPageId,
      conversationId: 'conv_123',
    });
    (canUserEditPage as Mock).mockResolvedValue(true);
    (globalConversationRepository.getConversationById as Mock).mockResolvedValue({ id: 'conv_123' });
  });

  // ============================================
  // Authentication
  // ============================================

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createGetRequest(), { params: mockParams });

      expect(response.status).toBe(401);
      expect(previewAiUndo).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Not Found
  // ============================================

  describe('not found', () => {
    it('returns 404 when message does not exist or preview fails', async () => {
      (previewAiUndo as Mock).mockResolvedValue(null);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Message not found or preview failed');
    });
  });

  // ============================================
  // Authorization
  // ============================================

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission on page', async () => {
      (canUserEditPage as Mock).mockResolvedValue(false);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
    });

    it('returns 403 when user lacks ownership of global conversation', async () => {
      (previewAiUndo as Mock).mockResolvedValue({
        source: 'global_chat',
        conversationId: 'global_conv_123',
      });
      (globalConversationRepository.getConversationById as Mock).mockResolvedValue(null);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
    });
  });

  // ============================================
  // Success
  // ============================================

  describe('success', () => {
    it('returns preview data', async () => {
      const mockPreview = {
        messageId: mockMessageId,
        conversationId: 'conv_123',
        pageId: mockPageId,
        driveId: 'drive_123',
        createdAt: new Date('2024-01-15'),
        messagesAffected: 5,
        activitiesAffected: [
          { id: 'act_1', operation: 'update', canRollback: true },
        ],
        warnings: [],
      };

      (previewAiUndo as Mock).mockResolvedValue(mockPreview);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messagesAffected).toBe(5);
      expect(body.activitiesAffected).toHaveLength(1);
    });
  });
});

describe('POST /api/ai/chat/messages/[messageId]/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (previewAiUndo as Mock).mockResolvedValue({
      source: 'page_chat',
      pageId: mockPageId,
      conversationId: 'conv_123',
    });
    (canUserEditPage as Mock).mockResolvedValue(true);
    (globalConversationRepository.getConversationById as Mock).mockResolvedValue({ id: 'conv_123' });
  });

  // ============================================
  // Authentication
  // ============================================

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });

      expect(response.status).toBe(401);
      expect(executeAiUndo).not.toHaveBeenCalled();
    });

    it('requires CSRF token', async () => {
      await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ requireCSRF: true })
      );
    });
  });

  // ============================================
  // Validation
  // ============================================

  describe('validation', () => {
    it('returns 400 for invalid mode', async () => {
      const response = await POST(createPostRequest({ mode: 'invalid' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('messages_only');
      expect(body.error).toContain('messages_and_changes');
    });

    it('returns 400 when mode is missing', async () => {
      const response = await POST(createPostRequest({}), { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('accepts messages_only mode', async () => {
      (executeAiUndo as Mock).mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 0,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });

      expect(response.status).toBe(200);
      expect(executeAiUndo).toHaveBeenCalledWith(mockMessageId, mockUserId, 'messages_only');
    });

    it('accepts messages_and_changes mode', async () => {
      (executeAiUndo as Mock).mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 2,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_and_changes' }), { params: mockParams });

      expect(response.status).toBe(200);
      expect(executeAiUndo).toHaveBeenCalledWith(mockMessageId, mockUserId, 'messages_and_changes');
    });
  });

  // ============================================
  // Authorization
  // ============================================

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      (canUserEditPage as Mock).mockResolvedValue(false);

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
    });
  });

  // ============================================
  // Success
  // ============================================

  describe('success', () => {
    it('returns success for messages_only mode', async () => {
      (executeAiUndo as Mock).mockResolvedValue({
        success: true,
        messagesDeleted: 5,
        activitiesRolledBack: 0,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.messagesDeleted).toBe(5);
      expect(body.message).toContain('Deleted 5 messages');
    });

    it('returns success for messages_and_changes mode', async () => {
      (executeAiUndo as Mock).mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 2,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_and_changes' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain('Deleted 3 messages');
      expect(body.message).toContain('undid 2 changes');
    });
  });

  // ============================================
  // Partial failure
  // ============================================

  describe('partial failure', () => {
    it('returns 207 when some operations completed', async () => {
      (executeAiUndo as Mock).mockResolvedValue({
        success: false,
        messagesDeleted: 3,
        activitiesRolledBack: 1,
        errors: ['Failed to rollback activity_2'],
      });

      const response = await POST(createPostRequest({ mode: 'messages_and_changes' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(207);
      expect(body.success).toBe(false);
      expect(body.messagesDeleted).toBe(3);
      expect(body.errors).toContain('Failed to rollback activity_2');
    });

    it('returns 500 when no operations completed', async () => {
      (executeAiUndo as Mock).mockResolvedValue({
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: ['Complete failure'],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
    });
  });
});
