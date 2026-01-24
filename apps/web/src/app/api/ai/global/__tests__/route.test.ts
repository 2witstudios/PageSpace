/**
 * Contract tests for GET/POST /api/ai/global
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    listConversations: vi.fn(),
    createConversation: vi.fn(),
  },
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

import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

// Test fixtures
const mockUserId = 'user_123';

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

const mockConversation = (overrides: Partial<{
  id: string;
  userId: string;
  title: string | null;
  type: string;
  contextId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id ?? 'conv_123',
  userId: overrides.userId ?? mockUserId,
  title: overrides.title ?? 'Test Conversation',
  type: overrides.type ?? 'global',
  contextId: overrides.contextId ?? null,
  lastMessageAt: overrides.lastMessageAt ?? new Date(),
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
  isActive: overrides.isActive ?? true,
});

const createGetRequest = () =>
  new Request('https://example.com/api/ai/global', { method: 'GET' });

const createPostRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/global', {
    method: 'POST',
    body: JSON.stringify(body),
  });

describe('GET /api/ai/global', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: empty conversations
    vi.mocked(globalConversationRepository.listConversations).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createGetRequest();

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('successful retrieval', () => {
    it('should return conversations for authenticated user', async () => {
      const conversations = [
        mockConversation({ id: 'conv_1', title: 'First' }),
        mockConversation({ id: 'conv_2', title: 'Second' }),
      ];
      vi.mocked(globalConversationRepository.listConversations).mockResolvedValue(conversations);

      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
    });

    it('should return empty array when no conversations exist', async () => {
      vi.mocked(globalConversationRepository.listConversations).mockResolvedValue([]);

      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should call repository with userId', async () => {
      const request = createGetRequest();

      await GET(request);

      expect(globalConversationRepository.listConversations).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.listConversations).mockRejectedValue(
        new Error('Database error')
      );

      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch conversations');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});

describe('POST /api/ai/global', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: successful creation
    vi.mocked(globalConversationRepository.createConversation).mockResolvedValue(
      mockConversation()
    );
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPostRequest({ title: 'New conversation' });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('successful creation', () => {
    it('should create a new conversation and return it', async () => {
      const newConversation = mockConversation({
        id: 'conv_new',
        title: 'My new conversation',
      });
      vi.mocked(globalConversationRepository.createConversation).mockResolvedValue(newConversation);

      const request = createPostRequest({ title: 'My new conversation' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe('conv_new');
      expect(body.title).toBe('My new conversation');
    });

    it('should create conversation without title', async () => {
      const newConversation = {
        ...mockConversation(),
        title: null,
      };
      vi.mocked(globalConversationRepository.createConversation).mockResolvedValue(newConversation);

      const request = createPostRequest({});

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBeNull();
    });

    it('should pass correct data to repository', async () => {
      const request = createPostRequest({
        title: 'Test',
        type: 'page',
        contextId: 'page_123',
      });

      await POST(request);

      expect(globalConversationRepository.createConversation).toHaveBeenCalledWith(
        mockUserId,
        {
          title: 'Test',
          type: 'page',
          contextId: 'page_123',
        }
      );
    });

    it('should default type to global', async () => {
      const request = createPostRequest({});

      await POST(request);

      expect(globalConversationRepository.createConversation).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          type: 'global',
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.createConversation).mockRejectedValue(
        new Error('Database error')
      );

      const request = createPostRequest({ title: 'New conversation' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create conversation');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
