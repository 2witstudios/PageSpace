import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const orderByMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
    },
    chatMessages: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  canUserViewPage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateHybridRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  convertDbMessageToUIMessage: vi.fn((msg) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
  })),
}));

import { db } from '@pagespace/db';
import { loggers, canUserViewPage } from '@pagespace/lib/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';

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
  createdAt: Date;
}> = {}) => ({
  id: overrides.id || 'msg_123',
  pageId: overrides.pageId || 'page_123',
  conversationId: overrides.conversationId || 'conv_123',
  role: overrides.role || 'user',
  content: overrides.content || 'Hello, AI!',
  isActive: overrides.isActive ?? true,
  createdAt: overrides.createdAt || new Date(),
});

describe('GET /api/ai/chat/messages', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  // Helper to setup select mock for messages
  const setupMessagesSelectMock = (messages: ReturnType<typeof mockChatMessage>[]) => {
    const orderByMock = vi.fn().mockResolvedValue(messages);
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default empty messages
    setupMessagesSelectMock([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/ai/chat/messages?pageId=${mockPageId}`, {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when pageId is missing', async () => {
      const request = new Request('https://example.com/api/ai/chat/messages', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageId is required');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/ai/chat/messages?pageId=${mockPageId}`, {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('view permission');
      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('successful message retrieval', () => {
    it('should return messages for a page', async () => {
      const messages = [
        mockChatMessage({ id: 'msg_1', role: 'user', content: 'Hello' }),
        mockChatMessage({ id: 'msg_2', role: 'assistant', content: 'Hi there!' }),
      ];
      setupMessagesSelectMock(messages);

      const request = new Request(`https://example.com/api/ai/chat/messages?pageId=${mockPageId}`, {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(convertDbMessageToUIMessage).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no messages exist', async () => {
      setupMessagesSelectMock([]);

      const request = new Request(`https://example.com/api/ai/chat/messages?pageId=${mockPageId}`, {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should filter by conversationId when provided', async () => {
      const conversationId = 'conv_456';
      const messages = [
        mockChatMessage({ id: 'msg_1', conversationId }),
      ];
      setupMessagesSelectMock(messages);

      const request = new Request(
        `https://example.com/api/ai/chat/messages?pageId=${mockPageId}&conversationId=${conversationId}`,
        { method: 'GET' }
      );

      const response = await GET(request);
      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const orderByMock = vi.fn().mockRejectedValue(new Error('Database error'));
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const request = new Request(`https://example.com/api/ai/chat/messages?pageId=${mockPageId}`, {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to load messages');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});
