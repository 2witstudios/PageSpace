/**
 * Contract tests for PATCH/DELETE /api/ai/global/[id]/messages/[messageId]
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getConversationById: vi.fn(),
    getMessageById: vi.fn(),
    updateMessageContent: vi.fn(),
    softDeleteMessage: vi.fn(),
  },
}));

// Mock chat-message-repository for processMessageContentUpdate
vi.mock('@/lib/repositories/chat-message-repository', () => ({
  processMessageContentUpdate: vi.fn((existing, newContent) => newContent),
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock logging (boundary)
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

// Mock logging mask (boundary)
vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

// Test fixtures
const mockUserId = 'user_123';
const mockConversationId = 'conv_123';
const mockMessageId = 'msg_123';

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

const mockConversation = (overrides: Partial<{
  id: string;
  userId: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id ?? mockConversationId,
  userId: overrides.userId ?? mockUserId,
  isActive: overrides.isActive ?? true,
  title: 'Test Conversation',
  type: 'global',
  contextId: null,
  lastMessageAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const mockMessage = (overrides: Partial<{
  id: string;
  conversationId: string;
  content: string;
  role: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id ?? mockMessageId,
  conversationId: overrides.conversationId ?? mockConversationId,
  content: overrides.content ?? 'Hello, AI!',
  role: overrides.role ?? 'user',
  isActive: overrides.isActive ?? true,
});

const createContext = (id: string, messageId: string) => ({
  params: Promise.resolve({ id, messageId }),
});

const createPatchRequest = (id: string, messageId: string, body: Record<string, unknown>) =>
  new Request(`https://example.com/api/ai/global/${id}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

const createDeleteRequest = (id: string, messageId: string) =>
  new Request(`https://example.com/api/ai/global/${id}/messages/${messageId}`, {
    method: 'DELETE',
  });

describe('PATCH /api/ai/global/[id]/messages/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation and message exist
    vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(
      mockConversation()
    );
    vi.mocked(globalConversationRepository.getMessageById).mockResolvedValue(
      mockMessage()
    );

    // Default: update succeeds
    vi.mocked(globalConversationRepository.updateMessageContent).mockResolvedValue(undefined);
  });

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

  describe('resource not found', () => {
    it('should return 404 when conversation does not exist', async () => {
      vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(null);

      const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
      const context = createContext(mockConversationId, mockMessageId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });

    it('should return 404 when message does not exist', async () => {
      vi.mocked(globalConversationRepository.getMessageById).mockResolvedValue(null);

      const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
      const context = createContext(mockConversationId, mockMessageId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Message not found');
    });
  });

  describe('successful update', () => {
    it('should update message content and return success', async () => {
      const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated content' });
      const context = createContext(mockConversationId, mockMessageId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Message updated successfully');
    });

    it('should call repository methods with correct arguments', async () => {
      const request = createPatchRequest(mockConversationId, mockMessageId, { content: 'Updated' });
      const context = createContext(mockConversationId, mockMessageId);

      await PATCH(request, context);

      expect(globalConversationRepository.getConversationById).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId
      );
      expect(globalConversationRepository.getMessageById).toHaveBeenCalledWith(
        mockConversationId,
        mockMessageId
      );
      expect(globalConversationRepository.updateMessageContent).toHaveBeenCalledWith(
        mockMessageId,
        expect.any(String)
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
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.updateMessageContent).mockRejectedValue(
        new Error('Database error')
      );

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
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation and message exist
    vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(
      mockConversation()
    );
    vi.mocked(globalConversationRepository.getMessageById).mockResolvedValue(
      mockMessage()
    );

    // Default: delete succeeds
    vi.mocked(globalConversationRepository.softDeleteMessage).mockResolvedValue(undefined);
  });

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

  describe('resource not found', () => {
    it('should return 404 when conversation does not exist', async () => {
      vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(null);

      const request = createDeleteRequest(mockConversationId, mockMessageId);
      const context = createContext(mockConversationId, mockMessageId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });

    it('should return 404 when message does not exist', async () => {
      vi.mocked(globalConversationRepository.getMessageById).mockResolvedValue(null);

      const request = createDeleteRequest(mockConversationId, mockMessageId);
      const context = createContext(mockConversationId, mockMessageId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Message not found');
    });
  });

  describe('successful deletion', () => {
    it('should soft delete message and return success', async () => {
      const request = createDeleteRequest(mockConversationId, mockMessageId);
      const context = createContext(mockConversationId, mockMessageId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Message deleted successfully');
    });

    it('should call softDeleteMessage with messageId', async () => {
      const request = createDeleteRequest(mockConversationId, mockMessageId);
      const context = createContext(mockConversationId, mockMessageId);

      await DELETE(request, context);

      expect(globalConversationRepository.softDeleteMessage).toHaveBeenCalledWith(mockMessageId);
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
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.softDeleteMessage).mockRejectedValue(
        new Error('Database error')
      );

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

describe('processMessageContentUpdate (pure function)', () => {
  // Use beforeAll to import the actual module once, avoiding repetition
  let processMessageContentUpdate: (existingContent: string, newContent: string) => string;

  beforeAll(async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/chat-message-repository')
    >('@/lib/repositories/chat-message-repository');
    processMessageContentUpdate = actualModule.processMessageContentUpdate;
  });

  it('should return new content for plain text messages', () => {
    const result = processMessageContentUpdate('Old text', 'New text');

    expect(result).toBe('New text');
  });

  it('should return new content for invalid JSON', () => {
    const result = processMessageContentUpdate('not json', 'New text');

    expect(result).toBe('New text');
  });

  it('should preserve structure for messages with textParts', () => {
    const structured = JSON.stringify({
      textParts: ['Original'],
      partsOrder: ['text'],
      originalContent: 'Original',
    });

    const result = processMessageContentUpdate(structured, 'New text');
    const parsed = JSON.parse(result);

    expect(parsed.textParts).toEqual(['New text']);
    expect(parsed.originalContent).toBe('New text');
    expect(parsed.partsOrder).toEqual(['text']);
  });

  it('should return new content when JSON lacks textParts', () => {
    const jsonWithoutTextParts = JSON.stringify({ other: 'data' });

    const result = processMessageContentUpdate(jsonWithoutTextParts, 'New text');

    expect(result).toBe('New text');
  });

  it('should return new content for empty string', () => {
    const result = processMessageContentUpdate('', 'New text');

    expect(result).toBe('New text');
  });
});
