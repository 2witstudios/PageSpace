/**
 * Contract tests for GET /api/ai/chat/messages
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { ChatMessage } from '@/lib/repositories/chat-message-repository';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessagesForPage: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  }),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    ai: { info: vi.fn(), error: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

// Mock message converter (boundary)
vi.mock('@/lib/ai/core/message-utils', () => ({
  convertDbMessageToUIMessage: vi.fn((msg: ChatMessage) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
  })),
}));

import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';

// Test fixtures
const mockUserId = 'user_123';
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
  conversationId: string;
  userId: string | null;
  role: string;
  content: string;
  messageType: 'standard' | 'todo_list';
  status: 'streaming' | 'complete' | 'interrupted';
}> = {}) => ({
  id: overrides.id || 'msg_123',
  pageId: overrides.pageId || mockPageId,
  conversationId: overrides.conversationId || 'conv_123',
  userId: overrides.userId ?? mockUserId,
  role: overrides.role || 'user',
  content: overrides.content || 'Hello, AI!',
  messageType: overrides.messageType || 'standard' as const,
  isActive: true,
  createdAt: new Date(),
  editedAt: null,
  toolCalls: null,
  toolResults: null,
  status: overrides.status || 'complete' as const,
});

const createRequest = (pageId?: string, conversationId?: string, includeStreaming?: string) => {
  let url = 'https://example.com/api/ai/chat/messages';
  const params = [];
  if (pageId) params.push(`pageId=${pageId}`);
  if (conversationId) params.push(`conversationId=${conversationId}`);
  if (includeStreaming !== undefined) params.push(`includeStreaming=${includeStreaming}`);
  if (params.length) url += '?' + params.join('&');

  return new Request(url, { method: 'GET' });
};

describe('GET /api/ai/chat/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: empty messages
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockPageId);

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when pageId is missing', async () => {
      const request = createRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageId is required');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = createRequest(mockPageId);

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('view permission');
    });

    it('should check permission with correct pageId', async () => {
      const request = createRequest(mockPageId);

      await GET(request);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('successful message retrieval', () => {
    it('should return messages for a page', async () => {
      const messages = [
        mockChatMessage({ id: 'msg_1', role: 'user', content: 'Hello' }),
        mockChatMessage({ id: 'msg_2', role: 'assistant', content: 'Hi there!' }),
      ];
      vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue(messages);

      const request = createRequest(mockPageId);

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(convertDbMessageToUIMessage).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no messages exist', async () => {
      const request = createRequest(mockPageId);

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should pass conversationId to repository when provided', async () => {
      const conversationId = 'conv_456';
      const request = createRequest(mockPageId, conversationId);

      await GET(request);

      expect(chatMessageRepository.getMessagesForPage).toHaveBeenCalledWith(
        mockPageId,
        conversationId,
        false
      );
    });

    it('should pass undefined conversationId when not provided', async () => {
      const request = createRequest(mockPageId);

      await GET(request);

      expect(chatMessageRepository.getMessagesForPage).toHaveBeenCalledWith(
        mockPageId,
        undefined,
        false
      );
    });

    // Server Stream Durability epic PR 2: stale-tab rollout protection — a client must
    // explicitly opt in with includeStreaming=1 before it is shown 'streaming' placeholder
    // rows; anything else (absent, '0', 'true') stays excluded.
    it('should pass includeStreaming=true to repository when ?includeStreaming=1 is set', async () => {
      const request = createRequest(mockPageId, undefined, '1');

      await GET(request);

      expect(chatMessageRepository.getMessagesForPage).toHaveBeenCalledWith(
        mockPageId,
        undefined,
        true
      );
    });

    it('should pass includeStreaming=false when the query param is anything other than "1"', async () => {
      const request = createRequest(mockPageId, undefined, 'true');

      await GET(request);

      expect(chatMessageRepository.getMessagesForPage).toHaveBeenCalledWith(
        mockPageId,
        undefined,
        false
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(chatMessageRepository.getMessagesForPage).mockRejectedValue(
        new Error('Database error')
      );

      const request = createRequest(mockPageId);

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to load messages');
      const errorArg = vi.mocked(loggers.ai.error).mock.calls[0];
      expect(errorArg[0]).toBe('Error loading chat messages:');
      expect(errorArg[1]).toBeInstanceOf(Error);
      expect((errorArg[1] as Error).message).toBe('Database error');
    });
  });
});
