/**
 * Contract tests for PATCH/DELETE /api/ai/chat/messages/[messageId]
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessageById: vi.fn(),
    updateMessageContent: vi.fn(),
    softDeleteMessage: vi.fn(),
  },
  processMessageContentUpdate: vi.fn((existing, newContent) => newContent),
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock permissions (boundary)
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

// Mock logging mask (boundary)
vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

// Mock activity logger (boundary)
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logMessageActivity: vi.fn(),
}));

// Mock database for page lookup (boundary)
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
    },
  },
  pages: {},
  eq: vi.fn(),
}));

import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage, loggers } from '@pagespace/lib/server';

// Type for page lookup mock (matches Drizzle schema)
type PageType = 'DOCUMENT' | 'FOLDER' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'FILE' | 'SHEET' | 'TASK_LIST';
type PageTreeScope = 'children' | 'drive';
type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

type PageLookupResult = {
  id: string;
  title: string;
  type: PageType;
  content: string;
  isPaginated: boolean;
  position: number;
  isTrashed: boolean;
  driveId: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
  stateHash: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  systemPrompt: string | null;
  enabledTools: unknown;
  includeDrivePrompt: boolean;
  agentDefinition: string | null;
  visibleToGlobalAssistant: boolean;
  includePageTree: boolean;
  pageTreeScope: PageTreeScope | null;
  fileSize: number | null;
  mimeType: string | null;
  originalFileName: string | null;
  filePath: string | null;
  fileMetadata: unknown;
  processingStatus: ProcessingStatus | null;
  processingError: string | null;
  processedAt: Date | null;
  extractionMethod: string | null;
  extractionMetadata: unknown;
  contentHash: string | null;
  trashedAt: Date | null;
  originalParentId: string | null;
};

const mockPageLookup = (overrides: Partial<PageLookupResult> = {}): PageLookupResult => ({
  id: 'page_123',
  title: 'Test Page',
  type: 'DOCUMENT',
  content: '',
  isPaginated: false,
  position: 0,
  isTrashed: false,
  driveId: 'drive_123',
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  revision: 0,
  stateHash: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  includeDrivePrompt: false,
  agentDefinition: null,
  visibleToGlobalAssistant: true,
  includePageTree: false,
  pageTreeScope: 'children',
  fileSize: null,
  mimeType: null,
  originalFileName: null,
  filePath: null,
  fileMetadata: null,
  processingStatus: 'pending',
  processingError: null,
  processedAt: null,
  extractionMethod: null,
  extractionMetadata: null,
  contentHash: null,
  trashedAt: null,
  originalParentId: null,
  ...overrides,
});

// Test fixtures
const mockUserId = 'user_123';
const mockMessageId = 'msg_123';
const mockPageId = 'page_123';

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

const mockChatMessage = (overrides: Partial<{
  id: string;
  pageId: string;
  content: string;
  userId: string | null;
  messageType: 'standard' | 'todo_list';
}> = {}) => ({
  id: overrides.id || mockMessageId,
  pageId: overrides.pageId || mockPageId,
  conversationId: 'conv_123',
  userId: overrides.userId ?? mockUserId,
  role: 'user',
  content: overrides.content || 'Hello, AI!',
  messageType: overrides.messageType || 'standard' as const,
  isActive: true,
  createdAt: new Date(),
  editedAt: null,
  toolCalls: null,
  toolResults: null,
});

const createContext = (messageId: string) => ({
  params: Promise.resolve({ messageId }),
});

describe('PATCH /api/ai/chat/messages/[messageId]', () => {
  const createPatchRequest = (messageId: string, body: Record<string, unknown>) =>
    new Request(`https://example.com/api/ai/chat/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: message exists
    vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(mockChatMessage());

    // Default: update succeeds
    vi.mocked(chatMessageRepository.updateMessageContent).mockResolvedValue(undefined);

    // Default: page lookup for driveId
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPageLookup());

    // Default: actor info for activity logging
    vi.mocked(getActorInfo).mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
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

  describe('resource not found', () => {
    it('should return 404 when message does not exist', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(null);

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
    });

    it('should check permission with message pageId', async () => {
      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

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

  describe('successful update', () => {
    it('should update message content and return success', async () => {
      const request = createPatchRequest(mockMessageId, { content: 'Updated content' });
      const context = createContext(mockMessageId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Message updated successfully');
    });

    it('should pass processed content to repository', async () => {
      const request = createPatchRequest(mockMessageId, { content: 'Updated content' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(chatMessageRepository.updateMessageContent).toHaveBeenCalledWith(
        mockMessageId,
        'Updated content'
      );
    });

    it('should call processMessageContentUpdate with existing and new content', async () => {
      const { processMessageContentUpdate } = await import('@/lib/repositories/chat-message-repository');
      const existingMessage = mockChatMessage({ content: 'Existing content' });
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(existingMessage);

      const request = createPatchRequest(mockMessageId, { content: 'New content' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(processMessageContentUpdate).toHaveBeenCalledWith('Existing content', 'New content');
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
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(chatMessageRepository.updateMessageContent).mockRejectedValue(
        new Error('Database error')
      );

      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to edit message');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });

  describe('activity logging boundary', () => {
    it('should log message_update with content diff on successful PATCH', async () => {
      const existingMessage = mockChatMessage({ content: 'Original content' });
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(existingMessage);

      const request = createPatchRequest(mockMessageId, { content: 'Updated content' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(logMessageActivity).toHaveBeenCalledWith(
        mockUserId,
        'message_update',
        expect.objectContaining({
          id: mockMessageId,
          pageId: mockPageId,
          driveId: 'drive_123',
          conversationType: 'ai_chat',
        }),
        expect.objectContaining({
          actorEmail: 'test@example.com',
        }),
        expect.objectContaining({
          previousContent: 'Original content',
          newContent: 'Updated content',
        })
      );
    });

    it('should call getActorInfo with userId', async () => {
      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
    });

    it('should NOT log activity when authentication fails', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(logMessageActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when message not found', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(null);

      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(logMessageActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when permission denied', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(logMessageActivity).not.toHaveBeenCalled();
    });

    it('should handle null driveId when page not found', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

      const request = createPatchRequest(mockMessageId, { content: 'Updated' });
      const context = createContext(mockMessageId);

      await PATCH(request, context);

      expect(logMessageActivity).toHaveBeenCalledWith(
        mockUserId,
        'message_update',
        expect.objectContaining({
          driveId: null,
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });
});

describe('DELETE /api/ai/chat/messages/[messageId]', () => {
  const createDeleteRequest = (messageId: string) =>
    new Request(`https://example.com/api/ai/chat/messages/${messageId}`, {
      method: 'DELETE',
    });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: message exists
    vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(mockChatMessage());

    // Default: delete succeeds
    vi.mocked(chatMessageRepository.softDeleteMessage).mockResolvedValue(undefined);

    // Default: page lookup for driveId
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPageLookup());

    // Default: actor info for activity logging
    vi.mocked(getActorInfo).mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
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

  describe('resource not found', () => {
    it('should return 404 when message does not exist', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(null);

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

  describe('successful deletion', () => {
    it('should soft delete message and return success', async () => {
      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Message deleted successfully');
    });

    it('should call softDeleteMessage with messageId', async () => {
      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(chatMessageRepository.softDeleteMessage).toHaveBeenCalledWith(mockMessageId);
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
    it('should return 500 when repository throws', async () => {
      vi.mocked(chatMessageRepository.softDeleteMessage).mockRejectedValue(
        new Error('Database error')
      );

      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete message');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });

  describe('activity logging boundary', () => {
    it('should log message_delete with previous content on successful DELETE', async () => {
      const existingMessage = mockChatMessage({ content: 'Content to be deleted' });
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(existingMessage);

      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(logMessageActivity).toHaveBeenCalledWith(
        mockUserId,
        'message_delete',
        expect.objectContaining({
          id: mockMessageId,
          pageId: mockPageId,
          driveId: 'drive_123',
          conversationType: 'ai_chat',
        }),
        expect.objectContaining({
          actorEmail: 'test@example.com',
        }),
        expect.objectContaining({
          previousContent: 'Content to be deleted',
        })
      );
    });

    it('should call getActorInfo with userId', async () => {
      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
    });

    it('should NOT log activity when authentication fails', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(logMessageActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when message not found', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(null);

      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(logMessageActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when permission denied', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(logMessageActivity).not.toHaveBeenCalled();
    });

    it('should handle null driveId when page not found', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

      const request = createDeleteRequest(mockMessageId);
      const context = createContext(mockMessageId);

      await DELETE(request, context);

      expect(logMessageActivity).toHaveBeenCalledWith(
        mockUserId,
        'message_delete',
        expect.objectContaining({
          driveId: null,
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });
});

describe('processMessageContentUpdate (pure function)', () => {
  it('should return new content for plain text messages', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/chat-message-repository')
    >('@/lib/repositories/chat-message-repository');
    const { processMessageContentUpdate } = actualModule;

    const result = processMessageContentUpdate('Old text', 'New text');

    expect(result).toBe('New text');
  });

  it('should return new content for invalid JSON', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/chat-message-repository')
    >('@/lib/repositories/chat-message-repository');
    const { processMessageContentUpdate } = actualModule;

    const result = processMessageContentUpdate('not json', 'New text');

    expect(result).toBe('New text');
  });

  it('should preserve structure for messages with textParts', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/chat-message-repository')
    >('@/lib/repositories/chat-message-repository');
    const { processMessageContentUpdate } = actualModule;

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

  it('should return new content when JSON lacks textParts', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/chat-message-repository')
    >('@/lib/repositories/chat-message-repository');
    const { processMessageContentUpdate } = actualModule;

    const jsonWithoutTextParts = JSON.stringify({ other: 'data' });

    const result = processMessageContentUpdate(jsonWithoutTextParts, 'New text');

    expect(result).toBe('New text');
  });
});
