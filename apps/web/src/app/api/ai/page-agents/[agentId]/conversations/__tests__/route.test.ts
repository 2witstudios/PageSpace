import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    execute: vi.fn(),
  },
  chatMessages: {},
  pages: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
  sql: vi.fn(),
}));

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

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated_conv_id'),
}));

import { db } from '@pagespace/db';
import { loggers, canUserViewPage } from '@pagespace/lib/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';

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

// Helper to create mock agent page
const mockAgent = (overrides: Partial<{
  id: string;
  title: string;
  type: string;
  isTrashed: boolean;
}> = {}) => ({
  id: overrides.id || 'agent_123',
  title: overrides.title || 'Test Agent',
  type: overrides.type || 'AI_CHAT',
  isTrashed: overrides.isTrashed ?? false,
});

describe('Page Agent Conversations Routes', () => {
  const mockUserId = 'user_123';
  const mockAgentId = 'agent_123';

  const createContext = (agentId: string) => ({
    params: Promise.resolve({ agentId }),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default agent exists
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockAgent());
  });

  describe('GET /api/ai/page-agents/[agentId]/conversations', () => {
    // Helper to setup mocks for GET
    const setupGetMocks = (
      agent: ReturnType<typeof mockAgent> | undefined,
      conversationsResult: { rows: unknown[] },
      totalCount: number
    ) => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(agent);
      vi.mocked(db.execute).mockResolvedValue(conversationsResult);

      const whereMock = vi.fn().mockResolvedValue([{ count: totalCount }]);
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'GET',
        });
        const context = createContext(mockAgentId);

        const response = await GET(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('agent not found', () => {
      it('should return 404 when agent does not exist', async () => {
        vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'GET',
        });
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

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'GET',
        });
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
            firstMessageTime: new Date(),
            lastMessageTime: new Date(),
            messageCount: 5,
            firstUserMessage: JSON.stringify([{ text: 'Hello' }]),
            lastMessageRole: 'assistant',
            lastMessageContent: 'Hi there!',
          },
        ];
        setupGetMocks(mockAgent(), { rows: mockConversations }, 1);

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'GET',
        });
        const context = createContext(mockAgentId);

        const response = await GET(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.conversations).toBeDefined();
        expect(body.pagination).toBeDefined();
        expect(body.pagination.totalCount).toBe(1);
      });

      it('should return empty array when no conversations exist', async () => {
        setupGetMocks(mockAgent(), { rows: [] }, 0);

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'GET',
        });
        const context = createContext(mockAgentId);

        const response = await GET(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.conversations).toEqual([]);
        expect(body.pagination.totalCount).toBe(0);
      });

      it('should handle pagination parameters', async () => {
        setupGetMocks(mockAgent(), { rows: [] }, 100);

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations?page=2&pageSize=20`, {
          method: 'GET',
        });
        const context = createContext(mockAgentId);

        const response = await GET(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.pagination.page).toBe(2);
        expect(body.pagination.pageSize).toBe(20);
        expect(body.pagination.hasMore).toBe(true);
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        vi.mocked(db.query.pages.findFirst).mockRejectedValue(new Error('Database error'));

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'GET',
        });
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
    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('agent not found', () => {
      it('should return 404 when agent does not exist', async () => {
        vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
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

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toContain('Insufficient permissions');
      });
    });

    describe('successful creation', () => {
      it('should create a new conversation', async () => {
        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.conversationId).toBe('generated_conv_id');
        expect(body.createdAt).toBeDefined();
      });

      it('should use custom title if provided', async () => {
        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({ title: 'My Custom Conversation' }),
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.title).toBe('My Custom Conversation');
      });

      it('should default to "New conversation" title', async () => {
        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        const body = await response.json();

        expect(body.title).toBe('New conversation');
      });

      it('should handle invalid JSON body gracefully', async () => {
        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: 'invalid json',
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        const body = await response.json();

        // Should still succeed with default values
        expect(response.status).toBe(200);
        expect(body.title).toBe('New conversation');
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        vi.mocked(db.query.pages.findFirst).mockRejectedValue(new Error('Database error'));

        const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const context = createContext(mockAgentId);

        const response = await POST(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to create conversation');
        expect(loggers.ai.error).toHaveBeenCalled();
      });
    });
  });
});
