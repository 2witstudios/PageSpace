import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const whereMock = vi.fn().mockResolvedValue([]);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });

  return {
    db: {
      select: selectMock,
      update: updateMock,
    },
    chatMessages: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  canUserEditPage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

import { db } from '@pagespace/db';
import { loggers, canUserEditPage } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock chat message
const mockChatMessage = (overrides: Partial<{
  id: string;
  pageId: string;
  conversationId: string;
  role: string;
  content: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id || 'msg_123',
  pageId: overrides.pageId || 'page_123',
  conversationId: overrides.conversationId || 'conv_123',
  role: overrides.role || 'user',
  content: overrides.content || 'Hello, AI!',
  isActive: overrides.isActive ?? true,
});

describe('Chat Message Individual Routes', () => {
  const mockUserId = 'user_123';
  const mockMessageId = 'msg_123';
  const mockPageId = 'page_123';

  // Helper to setup select mock for messages
  const setupMessageSelectMock = (message: ReturnType<typeof mockChatMessage> | undefined) => {
    const whereMock = vi.fn().mockResolvedValue(message ? [message] : []);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup update mock
  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default message exists
    setupMessageSelectMock(mockChatMessage());
    setupUpdateMock();
  });

  describe('PATCH /api/ai/chat/messages/[messageId]', () => {
    const createPatchRequest = (messageId: string, body: object) => {
      return new Request(`https://example.com/api/ai/chat/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    };

    const createContext = (messageId: string) => ({
      params: Promise.resolve({ messageId }),
    });

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = createPatchRequest(mockMessageId, { content: 'Updated content' });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('validation', () => {
      it('should return 400 when content is missing', async () => {
        const request = createPatchRequest(mockMessageId, {});
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toContain('Content is required');
      });

      it('should return 400 when content is not a string', async () => {
        const request = createPatchRequest(mockMessageId, { content: 123 });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toContain('must be a string');
      });

      it('should return 400 when content is empty string', async () => {
        const request = createPatchRequest(mockMessageId, { content: '' });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toContain('Content is required');
      });
    });

    describe('message not found', () => {
      it('should return 404 when message does not exist', async () => {
        setupMessageSelectMock(undefined);

        const request = createPatchRequest(mockMessageId, { content: 'Updated' });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Message not found');
      });
    });

    describe('authorization', () => {
      it('should return 403 when user lacks edit permission', async () => {
        vi.mocked(canUserEditPage).mockResolvedValue(false);

        const request = createPatchRequest(mockMessageId, { content: 'Updated' });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toContain('permission to edit');
        expect(canUserEditPage).toHaveBeenCalledWith(mockUserId, mockPageId);
      });

      it('should log warning when permission denied', async () => {
        vi.mocked(canUserEditPage).mockResolvedValue(false);

        const request = createPatchRequest(mockMessageId, { content: 'Updated' });
        const context = createContext(mockMessageId);

        await PATCH(request, context);

        expect(loggers.api.warn).toHaveBeenCalledWith(
          'Edit message permission denied',
          expect.any(Object)
        );
      });
    });

    describe('successful message update', () => {
      it('should update message content successfully', async () => {
        const { setMock } = setupUpdateMock();

        const request = createPatchRequest(mockMessageId, { content: 'Updated content' });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.message).toBe('Message updated successfully');
        expect(setMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content: 'Updated content',
            editedAt: expect.any(Date),
          })
        );
      });

      it('should log successful edit', async () => {
        const request = createPatchRequest(mockMessageId, { content: 'Updated' });
        const context = createContext(mockMessageId);

        await PATCH(request, context);

        expect(loggers.api.info).toHaveBeenCalledWith(
          'Message edited successfully',
          expect.any(Object)
        );
      });

      it('should handle structured content with textParts', async () => {
        const structuredContent = JSON.stringify({
          textParts: ['Original text'],
          partsOrder: ['text'],
          originalContent: 'Original text',
        });
        setupMessageSelectMock(mockChatMessage({ content: structuredContent }));
        const { setMock } = setupUpdateMock();

        const request = createPatchRequest(mockMessageId, { content: 'New text' });
        const context = createContext(mockMessageId);

        await PATCH(request, context);

        // Should preserve structure but update textParts
        expect(setMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content: expect.stringContaining('New text'),
          })
        );
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const whereMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const setMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

        const request = createPatchRequest(mockMessageId, { content: 'Updated' });
        const context = createContext(mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to edit message');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });

  describe('DELETE /api/ai/chat/messages/[messageId]', () => {
    const createDeleteRequest = (messageId: string) => {
      return new Request(`https://example.com/api/ai/chat/messages/${messageId}`, {
        method: 'DELETE',
      });
    };

    const createContext = (messageId: string) => ({
      params: Promise.resolve({ messageId }),
    });

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        const response = await DELETE(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('message not found', () => {
      it('should return 404 when message does not exist', async () => {
        setupMessageSelectMock(undefined);

        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Message not found');
      });
    });

    describe('authorization', () => {
      it('should return 403 when user lacks edit permission', async () => {
        vi.mocked(canUserEditPage).mockResolvedValue(false);

        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toContain('permission to delete');
      });

      it('should log warning when permission denied', async () => {
        vi.mocked(canUserEditPage).mockResolvedValue(false);

        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        await DELETE(request, context);

        expect(loggers.api.warn).toHaveBeenCalledWith(
          'Delete message permission denied',
          expect.any(Object)
        );
      });
    });

    describe('successful message deletion', () => {
      it('should soft delete message successfully', async () => {
        const { setMock } = setupUpdateMock();

        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.message).toBe('Message deleted successfully');
        expect(setMock).toHaveBeenCalledWith({ isActive: false });
      });

      it('should log successful deletion', async () => {
        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        await DELETE(request, context);

        expect(loggers.api.info).toHaveBeenCalledWith(
          'Message deleted successfully',
          expect.any(Object)
        );
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const whereMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const setMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

        const request = createDeleteRequest(mockMessageId);
        const context = createContext(mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to delete message');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });
});
