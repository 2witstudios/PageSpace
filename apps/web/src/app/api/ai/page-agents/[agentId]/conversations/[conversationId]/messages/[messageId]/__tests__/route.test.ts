/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for PATCH/DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]
//
// Tests edit (PATCH) and soft-delete (DELETE) operations on individual
// AI page agent conversation messages.
// ============================================================================

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPPageScope: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessageById: vi.fn(),
    updateMessageContent: vi.fn(),
    softDeleteMessage: vi.fn(),
  },
  processMessageContentUpdate: vi.fn((existing: string, newContent: string) => newContent),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logMessageActivity: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage, loggers } from '@pagespace/lib/server';
import {
  chatMessageRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/chat-message-repository';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';

// ============================================================================
// Test Helpers
// ============================================================================

const AGENT_ID = 'agent_123';
const CONVERSATION_ID = 'conv_456';
const MESSAGE_ID = 'msg_789';
const USER_ID = 'user_abc';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createParams = (): Promise<{ agentId: string; conversationId: string; messageId: string }> =>
  Promise.resolve({ agentId: AGENT_ID, conversationId: CONVERSATION_ID, messageId: MESSAGE_ID });

const createPatchRequest = (body: Record<string, unknown> = { content: 'Updated content' }): Request =>
  new Request(
    `https://example.com/api/ai/page-agents/${AGENT_ID}/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

const createDeleteRequest = (): Request =>
  new Request(
    `https://example.com/api/ai/page-agents/${AGENT_ID}/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}`,
    { method: 'DELETE' }
  );

const createMessageFixture = (overrides: Partial<{
  id: string;
  pageId: string;
  conversationId: string;
  isActive: boolean;
  content: string;
  role: string;
}> = {}) => ({
  id: overrides.id ?? MESSAGE_ID,
  pageId: overrides.pageId ?? AGENT_ID,
  conversationId: overrides.conversationId ?? CONVERSATION_ID,
  isActive: overrides.isActive ?? true,
  content: overrides.content ?? 'Original content',
  role: overrides.role ?? 'user',
  userId: USER_ID,
  messageType: 'standard',
  createdAt: new Date('2024-01-01'),
  editedAt: null,
  toolCalls: null,
  toolResults: null,
});

const mockActorInfo = { email: 'test@example.com', name: 'Test User' };

// ============================================================================
// PATCH Tests
// ============================================================================

describe('PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(createMessageFixture());
    vi.mocked(chatMessageRepository.updateMessageContent).mockResolvedValue(undefined);
    vi.mocked(getActorInfo).mockResolvedValue(mockActorInfo);
    vi.mocked(logMessageActivity).mockReturnValue(undefined);
    vi.mocked(processMessageContentUpdate).mockReturnValue('Updated content');
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('validation', () => {
    it('should return 400 when content is missing', async () => {
      const response = await PATCH(createPatchRequest({}), { params: createParams() });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Content is required');
    });

    it('should return 400 when content is not a string', async () => {
      const response = await PATCH(createPatchRequest({ content: 123 }), { params: createParams() });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('must be a string');
    });

    it('should return 400 when content is empty string', async () => {
      const response = await PATCH(createPatchRequest({ content: '' }), { params: createParams() });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Content is required');
    });
  });

  describe('MCP scope', () => {
    it('should return scope error when MCP check fails', async () => {
      const scopeErrorResponse = NextResponse.json(
        { error: 'Token not scoped to this page' },
        { status: 403 }
      );
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Token not scoped to this page');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('do not have permission');
    });
  });

  describe('message lookup', () => {
    it('should return 404 when message not found', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(null);

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found');
    });

    it('should return 404 when message is inactive', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(
        createMessageFixture({ isActive: false })
      );

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found');
    });

    it('should return 404 when message belongs to different agent', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(
        createMessageFixture({ pageId: 'other_agent' })
      );

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found in this conversation');
    });

    it('should return 404 when message belongs to different conversation', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(
        createMessageFixture({ conversationId: 'other_conv' })
      );

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found in this conversation');
    });
  });

  describe('success', () => {
    it('should update message content and return success', async () => {
      const response = await PATCH(createPatchRequest({ content: 'New text' }), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Message updated successfully');
      expect(processMessageContentUpdate).toHaveBeenCalledWith('Original content', 'New text');
      expect(chatMessageRepository.updateMessageContent).toHaveBeenCalledWith(
        MESSAGE_ID,
        expect.any(String)
      );
    });
  });

  describe('activity logging', () => {
    it('should log activity for audit trail', async () => {
      await PATCH(createPatchRequest(), { params: createParams() });

      expect(getActorInfo).toHaveBeenCalledWith(USER_ID);
      expect(logMessageActivity).toHaveBeenCalledWith(
        USER_ID,
        'message_update',
        expect.objectContaining({
          id: MESSAGE_ID,
          pageId: AGENT_ID,
          driveId: null,
          conversationType: 'ai_chat',
        }),
        mockActorInfo,
        expect.objectContaining({
          previousContent: 'Original content',
          newContent: expect.any(String),
          aiConversationId: CONVERSATION_ID,
        })
      );
    });

    it('should not break the operation when activity logging fails', async () => {
      vi.mocked(getActorInfo).mockRejectedValue(new Error('Logging service down'));

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Failed to log agent message update activity',
        expect.any(Error),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when an unexpected error occurs', async () => {
      vi.mocked(canUserEditPage).mockRejectedValue(new Error('Database error'));

      const response = await PATCH(createPatchRequest(), { params: createParams() });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to edit message');
    });
  });
});

// ============================================================================
// DELETE Tests
// ============================================================================

describe('DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(createMessageFixture());
    vi.mocked(chatMessageRepository.softDeleteMessage).mockResolvedValue(undefined);
    vi.mocked(getActorInfo).mockResolvedValue(mockActorInfo);
    vi.mocked(logMessageActivity).mockReturnValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('MCP scope', () => {
    it('should return scope error when MCP check fails', async () => {
      const scopeErrorResponse = NextResponse.json(
        { error: 'Token not scoped to this page' },
        { status: 403 }
      );
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Token not scoped to this page');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('do not have permission');
    });
  });

  describe('message lookup', () => {
    it('should return 404 when message not found', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(null);

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found');
    });

    it('should return 404 when message is inactive', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(
        createMessageFixture({ isActive: false })
      );

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found');
    });

    it('should return 404 when message belongs to different agent', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(
        createMessageFixture({ pageId: 'other_agent' })
      );

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found in this conversation');
    });

    it('should return 404 when message belongs to different conversation', async () => {
      vi.mocked(chatMessageRepository.getMessageById).mockResolvedValue(
        createMessageFixture({ conversationId: 'other_conv' })
      );

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found in this conversation');
    });
  });

  describe('success', () => {
    it('should soft delete message and return success', async () => {
      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Message deleted successfully');
      expect(chatMessageRepository.softDeleteMessage).toHaveBeenCalledWith(MESSAGE_ID);
    });
  });

  describe('activity logging', () => {
    it('should log activity for audit trail', async () => {
      await DELETE(createDeleteRequest(), { params: createParams() });

      expect(getActorInfo).toHaveBeenCalledWith(USER_ID);
      expect(logMessageActivity).toHaveBeenCalledWith(
        USER_ID,
        'message_delete',
        expect.objectContaining({
          id: MESSAGE_ID,
          pageId: AGENT_ID,
          driveId: null,
          conversationType: 'ai_chat',
        }),
        mockActorInfo,
        expect.objectContaining({
          previousContent: 'Original content',
          aiConversationId: CONVERSATION_ID,
        })
      );
    });

    it('should not break the operation when activity logging fails', async () => {
      vi.mocked(getActorInfo).mockRejectedValue(new Error('Logging service down'));

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Failed to log agent message deletion activity',
        expect.any(Error),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when an unexpected error occurs', async () => {
      vi.mocked(canUserEditPage).mockRejectedValue(new Error('Database error'));

      const response = await DELETE(createDeleteRequest(), { params: createParams() });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to delete message');
    });
  });
});
