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
    conversations: {},
    messages: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
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
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
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

// Helper to create mock conversation
const mockConversation = (overrides: Partial<{
  id: string;
  userId: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id || 'conv_123',
  userId: overrides.userId || 'user_123',
  isActive: overrides.isActive ?? true,
});

// Helper to create mock message
const mockMessage = (overrides: Partial<{
  id: string;
  conversationId: string;
  role: string;
  content: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id || 'msg_123',
  conversationId: overrides.conversationId || 'conv_123',
  role: overrides.role || 'user',
  content: overrides.content || 'Hello, AI!',
  isActive: overrides.isActive ?? true,
});

describe('Global Conversation Message Routes', () => {
  const mockUserId = 'user_123';
  const mockConversationId = 'conv_123';
  const mockMessageId = 'msg_123';

  // Track which mock call is for conversation vs message
  let selectCallCount = 0;

  // Helper to setup select mock for conversation and message
  const setupSelectMocks = (
    conversation: ReturnType<typeof mockConversation> | undefined,
    message: ReturnType<typeof mockMessage> | undefined
  ) => {
    selectCallCount = 0;
    const whereMock = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // First call is for conversation
        return Promise.resolve(conversation ? [conversation] : []);
      } else {
        // Second call is for message
        return Promise.resolve(message ? [message] : []);
      }
    });
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

  const createContext = (id: string, messageId: string) => ({
    params: Promise.resolve({ id, messageId }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: both conversation and message exist
    setupSelectMocks(mockConversation(), mockMessage());
    setupUpdateMock();
  });

  describe('PATCH /api/ai/global/[id]/messages/[messageId]', () => {
    const createPatchRequest = (id: string, messageId: string, body: object) => {
      return new Request(`https://example.com/api/ai/global/${id}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
        const context = createContext(mockConversationId, mockMessageId);

        const response = await PATCH(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('validation', () => {
      it('should return 400 when content is missing', async () => {
        const request = createPatchRequest(mockConversationId, mockMessageId, {});
        const context = createContext(mockConversationId, mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toContain('Content is required');
      });

      it('should return 400 when content is not a string', async () => {
        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 123 });
        const context = createContext(mockConversationId, mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toContain('must be a string');
      });
    });

    describe('conversation not found', () => {
      it('should return 404 when conversation does not exist', async () => {
        setupSelectMocks(undefined, mockMessage());

        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
        const context = createContext(mockConversationId, mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Conversation not found');
      });
    });

    describe('message not found', () => {
      it('should return 404 when message does not exist', async () => {
        setupSelectMocks(mockConversation(), undefined);

        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
        const context = createContext(mockConversationId, mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Message not found');
      });
    });

    describe('successful update', () => {
      it('should update message content', async () => {
        const { setMock } = setupUpdateMock();

        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated content' });
        const context = createContext(mockConversationId, mockMessageId);

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
        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
        const context = createContext(mockConversationId, mockMessageId);

        await PATCH(request, context);

        expect(loggers.api.info).toHaveBeenCalledWith(
          'Global Assistant message edited successfully',
          expect.any(Object)
        );
      });

      it('should handle structured content with textParts', async () => {
        const structuredContent = JSON.stringify({
          textParts: ['Original text'],
          partsOrder: ['text'],
          originalContent: 'Original text',
        });
        setupSelectMocks(mockConversation(), mockMessage({ content: structuredContent }));
        const { setMock } = setupUpdateMock();

        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'New text' });
        const context = createContext(mockConversationId, mockMessageId);

        await PATCH(request, context);

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

        const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
        const context = createContext(mockConversationId, mockMessageId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to edit message');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });

  describe('DELETE /api/ai/global/[id]/messages/[messageId]', () => {
    const createDeleteRequest = (id: string, messageId: string) => {
      return new Request(`https://example.com/api/ai/global/${id}/messages/${messageId}`, {
        method: 'DELETE',
      });
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = createDeleteRequest(mockConversationId, mockMessageId);
        const context = createContext(mockConversationId, mockMessageId);

        const response = await DELETE(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('conversation not found', () => {
      it('should return 404 when conversation does not exist', async () => {
        setupSelectMocks(undefined, mockMessage());

        const request = createDeleteRequest(mockConversationId, mockMessageId);
        const context = createContext(mockConversationId, mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Conversation not found');
      });
    });

    describe('message not found', () => {
      it('should return 404 when message does not exist', async () => {
        setupSelectMocks(mockConversation(), undefined);

        const request = createDeleteRequest(mockConversationId, mockMessageId);
        const context = createContext(mockConversationId, mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Message not found');
      });
    });

    describe('successful deletion', () => {
      it('should soft delete message', async () => {
        const { setMock } = setupUpdateMock();

        const request = createDeleteRequest(mockConversationId, mockMessageId);
        const context = createContext(mockConversationId, mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.message).toBe('Message deleted successfully');
        expect(setMock).toHaveBeenCalledWith({ isActive: false });
      });

      it('should log successful deletion', async () => {
        const request = createDeleteRequest(mockConversationId, mockMessageId);
        const context = createContext(mockConversationId, mockMessageId);

        await DELETE(request, context);

        expect(loggers.api.info).toHaveBeenCalledWith(
          'Global Assistant message deleted successfully',
          expect.any(Object)
        );
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const whereMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const setMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

        const request = createDeleteRequest(mockConversationId, mockMessageId);
        const context = createContext(mockConversationId, mockMessageId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to delete message');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });
});
