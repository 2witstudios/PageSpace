/**
 * Contract tests for PATCH/DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getAiAgent: vi.fn(),
    conversationExists: vi.fn(),
    getConversationMetadata: vi.fn(),
    softDeleteConversation: vi.fn(),
    logConversationDeletion: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateHybridRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { canUserEditPage, loggers } from '@pagespace/lib/server';

// Test fixtures
const mockUserId = 'user_123';
const mockAgentId = 'agent_123';
const mockConversationId = 'conv_123';
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

const mockAgent = () => ({
  id: mockAgentId,
  title: 'Test Agent',
  type: 'AI_CHAT',
  driveId: mockDriveId,
});

const createRequest = (
  agentId: string,
  conversationId: string,
  method: string,
  body?: Record<string, unknown>
) =>
  new Request(
    `https://example.com/api/ai/page-agents/${agentId}/conversations/${conversationId}`,
    {
      method,
      body: body ? JSON.stringify(body) : undefined,
    }
  );

const createContext = (agentId: string, conversationId: string) => ({
  params: Promise.resolve({ agentId, conversationId }),
});

describe('PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: agent exists
    vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(mockAgent());

    // Default: conversation exists
    vi.mocked(conversationRepository.conversationExists).mockResolvedValue(true);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', { title: 'Updated' });
      const context = createContext(mockAgentId, mockConversationId);

      const response = await PATCH(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('resource not found', () => {
    it('should return 404 when agent does not exist', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(null);

      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', { title: 'Updated' });
      const context = createContext(mockAgentId, mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('AI agent not found');
    });

    it('should return 404 when conversation does not exist', async () => {
      vi.mocked(conversationRepository.conversationExists).mockResolvedValue(false);

      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', { title: 'Updated' });
      const context = createContext(mockAgentId, mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', { title: 'Updated' });
      const context = createContext(mockAgentId, mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('successful update', () => {
    it('should return success with title and placeholder message', async () => {
      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', {
        title: 'My Custom Title',
      });
      const context = createContext(mockAgentId, mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.conversationId).toBe(mockConversationId);
      expect(body.title).toBe('My Custom Title');
      expect(body.message).toContain('Custom titles will be supported');
    });

    it('should verify conversation exists before returning success', async () => {
      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', { title: 'Test' });
      const context = createContext(mockAgentId, mockConversationId);

      await PATCH(request, context);

      expect(conversationRepository.conversationExists).toHaveBeenCalledWith(
        mockAgentId,
        mockConversationId
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockRejectedValue(new Error('Database error'));

      const request = createRequest(mockAgentId, mockConversationId, 'PATCH', { title: 'Updated' });
      const context = createContext(mockAgentId, mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update conversation');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});

describe('DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: agent exists
    vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(mockAgent());

    // Default: conversation exists
    vi.mocked(conversationRepository.conversationExists).mockResolvedValue(true);

    // Default: conversation metadata
    vi.mocked(conversationRepository.getConversationMetadata).mockResolvedValue({
      messageCount: 5,
      firstMessageTime: new Date('2025-01-01'),
      lastMessageTime: new Date('2025-01-02'),
    });

    // Default: soft delete succeeds
    vi.mocked(conversationRepository.softDeleteConversation).mockResolvedValue(undefined);

    // Default: audit log succeeds
    vi.mocked(conversationRepository.logConversationDeletion).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      const response = await DELETE(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('resource not found', () => {
    it('should return 404 when agent does not exist', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(null);

      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('AI agent not found');
    });

    it('should return 404 when conversation does not exist', async () => {
      vi.mocked(conversationRepository.conversationExists).mockResolvedValue(false);

      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('successful deletion', () => {
    it('should soft delete conversation and return success', async () => {
      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.conversationId).toBe(mockConversationId);
      expect(body.message).toBe('Conversation deleted successfully');
    });

    it('should call softDeleteConversation with correct params', async () => {
      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      await DELETE(request, context);

      expect(conversationRepository.softDeleteConversation).toHaveBeenCalledWith(
        mockAgentId,
        mockConversationId
      );
    });
  });

  describe('boundary obligations', () => {
    it('should create audit log with correct metadata', async () => {
      const metadata = {
        messageCount: 5,
        firstMessageTime: new Date('2025-01-01'),
        lastMessageTime: new Date('2025-01-02'),
      };
      vi.mocked(conversationRepository.getConversationMetadata).mockResolvedValue(metadata);

      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      await DELETE(request, context);

      expect(conversationRepository.logConversationDeletion).toHaveBeenCalledWith({
        userId: mockUserId,
        conversationId: mockConversationId,
        agentId: mockAgentId,
        metadata,
      });
    });

    it('should log successful deletion', async () => {
      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      await DELETE(request, context);

      expect(loggers.ai.info).toHaveBeenCalledWith(
        'Conversation deleted',
        expect.objectContaining({
          conversationId: mockConversationId,
          agentId: mockAgentId,
          userId: mockUserId,
          messageCount: 5,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockRejectedValue(new Error('Database error'));

      const request = createRequest(mockAgentId, mockConversationId, 'DELETE');
      const context = createContext(mockAgentId, mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete conversation');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});
