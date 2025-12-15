/**
 * Contract tests for GET/POST /api/ai/page-agents/[agentId]/conversations
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getAiAgent: vi.fn(),
    listConversations: vi.fn(),
    countConversations: vi.fn(),
  },
  extractPreviewText: vi.fn((content: string | null) => {
    if (!content) return 'New conversation';
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed[0]?.text) return parsed[0].text.substring(0, 100);
      if (parsed.parts?.[0]?.text) return parsed.parts[0].text.substring(0, 100);
    } catch {
      return content.substring(0, 100);
    }
    return 'New conversation';
  }),
  generateTitle: vi.fn((preview: string) => preview.length > 50 ? preview.substring(0, 50) + '...' : preview),
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

// Mock ID generation
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated_conv_id'),
}));

import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { canUserViewPage, loggers } from '@pagespace/lib/server';

// Test fixtures
const mockUserId = 'user_123';
const mockAgentId = 'agent_123';
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

const createRequest = (agentId: string, method: string, body?: Record<string, unknown>) =>
  new Request(`https://example.com/api/ai/page-agents/${agentId}/conversations`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });

const createContext = (agentId: string) => ({
  params: Promise.resolve({ agentId }),
});

describe('GET /api/ai/page-agents/[agentId]/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: agent exists
    vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(mockAgent());

    // Default: empty conversations
    vi.mocked(conversationRepository.listConversations).mockResolvedValue([]);
    vi.mocked(conversationRepository.countConversations).mockResolvedValue(0);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockAgentId, 'GET');
      const context = createContext(mockAgentId);

      const response = await GET(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('resource not found', () => {
    it('should return 404 when agent does not exist', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(null);

      const request = createRequest(mockAgentId, 'GET');
      const context = createContext(mockAgentId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('AI agent not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = createRequest(mockAgentId, 'GET');
      const context = createContext(mockAgentId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('successful retrieval', () => {
    it('should return conversations with pagination', async () => {
      const mockConversations = [
        {
          conversationId: 'conv_1',
          firstMessageTime: new Date('2025-01-01'),
          lastMessageTime: new Date('2025-01-02'),
          messageCount: 5,
          firstUserMessage: JSON.stringify([{ text: 'Hello' }]),
          lastMessageRole: 'assistant',
          lastMessageContent: 'Hi there!',
        },
      ];
      vi.mocked(conversationRepository.listConversations).mockResolvedValue(mockConversations);
      vi.mocked(conversationRepository.countConversations).mockResolvedValue(1);

      const request = createRequest(mockAgentId, 'GET');
      const context = createContext(mockAgentId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0]).toMatchObject({
        id: 'conv_1',
        preview: 'Hello',
        messageCount: 5,
      });
      expect(body.pagination).toMatchObject({
        page: 0,
        pageSize: 50,
        totalCount: 1,
        totalPages: 1,
        hasMore: false,
      });
    });

    it('should return empty array when no conversations exist', async () => {
      const request = createRequest(mockAgentId, 'GET');
      const context = createContext(mockAgentId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversations).toEqual([]);
      expect(body.pagination.totalCount).toBe(0);
    });

    it('should pass pagination params to repository', async () => {
      vi.mocked(conversationRepository.countConversations).mockResolvedValue(100);

      const request = new Request(
        `https://example.com/api/ai/page-agents/${mockAgentId}/conversations?page=2&pageSize=20`,
        { method: 'GET' }
      );
      const context = createContext(mockAgentId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(conversationRepository.listConversations).toHaveBeenCalledWith(
        mockAgentId,
        20,  // pageSize
        40   // offset (page 2 * 20)
      );
      expect(body.pagination).toMatchObject({
        page: 2,
        pageSize: 20,
        hasMore: true,
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockRejectedValue(new Error('Database error'));

      const request = createRequest(mockAgentId, 'GET');
      const context = createContext(mockAgentId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to list conversations');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});

describe('POST /api/ai/page-agents/[agentId]/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: agent exists
    vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(mockAgent());
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockAgentId, 'POST', {});
      const context = createContext(mockAgentId);

      const response = await POST(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('resource not found', () => {
    it('should return 404 when agent does not exist', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(null);

      const request = createRequest(mockAgentId, 'POST', {});
      const context = createContext(mockAgentId);

      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('AI agent not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = createRequest(mockAgentId, 'POST', {});
      const context = createContext(mockAgentId);

      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('successful creation', () => {
    it('should create a new conversation with generated ID', async () => {
      const request = createRequest(mockAgentId, 'POST', {});
      const context = createContext(mockAgentId);

      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversationId).toBe('generated_conv_id');
      expect(body.title).toBe('New conversation');
      expect(body.createdAt).toBeDefined();
    });

    it('should use custom title if provided', async () => {
      const request = createRequest(mockAgentId, 'POST', { title: 'My Custom Conversation' });
      const context = createContext(mockAgentId);

      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('My Custom Conversation');
    });

    it('should handle invalid JSON body gracefully', async () => {
      const request = new Request(
        `https://example.com/api/ai/page-agents/${mockAgentId}/conversations`,
        { method: 'POST', body: 'invalid json' }
      );
      const context = createContext(mockAgentId);

      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('New conversation');
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(conversationRepository.getAiAgent).mockRejectedValue(new Error('Database error'));

      const request = createRequest(mockAgentId, 'POST', {});
      const context = createContext(mockAgentId);

      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create conversation');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});

describe('extractPreviewText (pure function)', () => {
  it('should return "New conversation" for null content', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { extractPreviewText } = actualModule;

    expect(extractPreviewText(null)).toBe('New conversation');
  });

  it('should extract text from array format', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { extractPreviewText } = actualModule;

    const content = JSON.stringify([{ text: 'Hello world' }]);
    expect(extractPreviewText(content)).toBe('Hello world');
  });

  it('should extract text from parts format', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { extractPreviewText } = actualModule;

    const content = JSON.stringify({ parts: [{ text: 'Hello from parts' }] });
    expect(extractPreviewText(content)).toBe('Hello from parts');
  });

  it('should truncate to 100 characters', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { extractPreviewText } = actualModule;

    const longText = 'a'.repeat(150);
    const content = JSON.stringify([{ text: longText }]);
    expect(extractPreviewText(content)).toBe('a'.repeat(100));
  });

  it('should return raw content if JSON parsing fails', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { extractPreviewText } = actualModule;

    expect(extractPreviewText('plain text message')).toBe('plain text message');
  });
});

describe('generateTitle (pure function)', () => {
  it('should return preview as-is if <= 50 chars', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { generateTitle } = actualModule;

    expect(generateTitle('Short title')).toBe('Short title');
  });

  it('should truncate and add ellipsis if > 50 chars', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/lib/repositories/conversation-repository')
    >('@/lib/repositories/conversation-repository');
    const { generateTitle } = actualModule;

    const longPreview = 'a'.repeat(60);
    expect(generateTitle(longPreview)).toBe('a'.repeat(50) + '...');
  });
});
