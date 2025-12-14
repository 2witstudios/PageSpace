import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  return {
    db: {
      query: {
        pages: {
          findFirst: vi.fn(),
        },
      },
      select: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
    },
    chatMessages: {},
    userActivities: {},
    pages: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
    sql: vi.fn((strings: TemplateStringsArray) => ({
      sql: strings.join(''),
      as: vi.fn(() => ({})),
    })),
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
  canUserEditPage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateHybridRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers, canUserEditPage } from '@pagespace/lib/server';
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

describe('Page Agent Conversation Routes', () => {
  const mockUserId = 'user_123';
  const mockAgentId = 'agent_123';
  const mockConversationId = 'conv_123';

  const createContext = (agentId: string, conversationId: string) => ({
    params: Promise.resolve({ agentId, conversationId }),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateHybridRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default agent exists
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockAgent());
  });

  describe('PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]', () => {
    // Helper to setup select mock for conversation messages (uses .limit())
    const setupConversationMessagesMock = (hasMessages: boolean) => {
      const result = hasMessages ? [{ count: 'msg_1' }] : [];
      // Chain: db.select().from().where().limit() -> result
      const limitMock = vi.fn().mockResolvedValue(result);
      const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Updated' }),
          }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await PATCH(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('agent not found', () => {
      it('should return 404 when agent does not exist', async () => {
        vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Updated' }),
          }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('AI agent not found');
      });
    });

    describe('authorization', () => {
      it('should return 403 when user lacks edit permission', async () => {
        vi.mocked(canUserEditPage).mockResolvedValue(false);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Updated' }),
          }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toContain('Insufficient permissions');
      });
    });

    describe('conversation not found', () => {
      it('should return 404 when conversation does not exist', async () => {
        setupConversationMessagesMock(false);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Updated' }),
          }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Conversation not found');
      });
    });

    describe('successful update', () => {
      it('should return success with title update message', async () => {
        setupConversationMessagesMock(true);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'My Custom Title' }),
          }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.conversationId).toBe(mockConversationId);
        expect(body.title).toBe('My Custom Title');
        expect(body.message).toContain('Custom titles will be supported');
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        vi.mocked(db.query.pages.findFirst).mockRejectedValue(new Error('Database error'));

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Updated' }),
          }
        );
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
    // Helper to setup mocks for DELETE
    // Chain: db.select().from().where() -> result (no .limit() for DELETE metadata query)
    const setupDeleteMocks = (metadata: { messageCount: number; firstMessageTime: Date; lastMessageTime: Date } | null) => {
      const selectWhereMock = vi.fn().mockResolvedValue(metadata ? [metadata] : []);
      const fromMock = vi.fn().mockReturnValue({ where: selectWhereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      // Chain: db.update().set().where() -> resolved
      const updateWhereMock = vi.fn().mockResolvedValue(undefined);
      const setMock = vi.fn().mockReturnValue({ where: updateWhereMock });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      // Chain: db.insert().values() -> resolved
      const insertValuesMock = vi.fn().mockResolvedValue([]);
      vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as unknown as ReturnType<typeof db.insert>);

      return { updateWhereMock, insertValuesMock };
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateHybridRequest).mockResolvedValue(mockAuthError(401));

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await DELETE(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('agent not found', () => {
      it('should return 404 when agent does not exist', async () => {
        vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('AI agent not found');
      });
    });

    describe('authorization', () => {
      it('should return 403 when user lacks edit permission', async () => {
        vi.mocked(canUserEditPage).mockResolvedValue(false);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toContain('Insufficient permissions');
      });
    });

    describe('successful deletion', () => {
      it('should soft delete all conversation messages', async () => {
        const metadata = {
          messageCount: 5,
          firstMessageTime: new Date(),
          lastMessageTime: new Date(),
        };
        setupDeleteMocks(metadata);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.conversationId).toBe(mockConversationId);
        expect(body.message).toBe('Conversation deleted successfully');
      });

      it('should create audit log entry', async () => {
        const metadata = {
          messageCount: 5,
          firstMessageTime: new Date(),
          lastMessageTime: new Date(),
        };
        const { insertValuesMock } = setupDeleteMocks(metadata);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        await DELETE(request, context);

        expect(insertValuesMock).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: mockUserId,
            action: 'delete',
            resource: 'conversation',
            resourceId: mockConversationId,
          })
        );
      });

      it('should log successful deletion', async () => {
        const metadata = {
          messageCount: 5,
          firstMessageTime: new Date(),
          lastMessageTime: new Date(),
        };
        setupDeleteMocks(metadata);

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        await DELETE(request, context);

        expect(loggers.ai.info).toHaveBeenCalledWith(
          'Conversation deleted',
          expect.objectContaining({
            conversationId: mockConversationId,
            agentId: mockAgentId,
          })
        );
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        vi.mocked(db.query.pages.findFirst).mockRejectedValue(new Error('Database error'));

        const request = new Request(
          `https://example.com/api/ai/page-agents/${mockAgentId}/conversations/${mockConversationId}`,
          { method: 'DELETE' }
        );
        const context = createContext(mockAgentId, mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to delete conversation');
        expect(loggers.ai.error).toHaveBeenCalled();
      });
    });
  });
});
