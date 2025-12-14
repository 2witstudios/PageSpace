/**
 * Contract tests for GET /api/ai/chat/messages
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessagesForPage: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateHybridRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// Mock message converter (boundary)
vi.mock('@/lib/ai/core', () => ({
  convertDbMessageToUIMessage: vi.fn((msg) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
  })),
}));

import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { canUserViewPage, loggers } from '@pagespace/lib/server';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';

// Test fixtures
const mockUserId = 'user_123';
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

const mockChatMessage = (overrides: Partial<{
  id: string;
  pageId: string;
  conversationId: string;
  role: string;
  content: string;
}> = {}) => ({
  id: overrides.id || 'msg_123',
  pageId: overrides.pageId || mockPageId,
  conversationId: overrides.conversationId || 'conv_123',
  role: overrides.role || 'user',
  content: overrides.content || 'Hello, AI!',
  isActive: true,
  createdAt: new Date(),
  editedAt: null,
  toolCalls: null,
  toolResults: null,
});

const createRequest = (pageId?: string, conversationId?: string) => {
  let url = 'https://example.com/api/ai/chat/messages';
  const params = [];
  if (pageId) params.push(`pageId=${pageId}`);
  if (conversationId) params.push(`conversationId=${conversationId}`);
  if (params.length) url += '?' + params.join('&');

  return new Request(url, { method: 'GET' });
};

describe('GET /api/ai/chat/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: empty messages
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

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
        conversationId
      );
    });

    it('should pass undefined conversationId when not provided', async () => {
      const request = createRequest(mockPageId);

      await GET(request);

      expect(chatMessageRepository.getMessagesForPage).toHaveBeenCalledWith(
        mockPageId,
        undefined
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
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});
