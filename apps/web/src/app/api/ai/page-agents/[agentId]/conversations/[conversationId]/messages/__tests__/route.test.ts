/**
 * Contract tests for GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages
 *
 * Focused on the conversation privacy access gate added as part of the
 * user-scoped conversation history feature. Database operations are mocked
 * at the repository/db seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';
import type { SessionAuthResult } from '@/lib/auth';

// Mock db (boundary — direct usage in this route)
// The reader cutover (epic "Agent-Session Single Source of Truth", Phase 4 /
// D6, PR 12) moved this route onto the unified `messages` table, so its
// listing query now goes `select → from → innerJoin → where → orderBy →
// limit`, and the cursor lookup is a `select → from → where → limit` instead
// of a relational `db.query.chatMessages.findFirst`.
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ kind: 'eq', a, b })),
  ne: vi.fn((a, b) => ({ kind: 'ne', a, b })),
  and: vi.fn((...c) => ({ kind: 'and', c })),
  or: vi.fn((...c) => ({ kind: 'or', c })),
  inArray: vi.fn((f, values) => ({ kind: 'inArray', f, values })),
  desc: vi.fn((f) => ({ kind: 'desc', f })),
  sql: Object.assign(vi.fn(), { as: vi.fn() }),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', type: 'pages.type', isTrashed: 'pages.isTrashed' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: {
    id: 'messages.id',
    pageId: 'messages.pageId',
    conversationId: 'messages.conversationId',
    isActive: 'messages.isActive',
    createdAt: 'messages.createdAt',
    role: 'messages.role',
    content: 'messages.content',
    toolCalls: 'messages.toolCalls',
    toolResults: 'messages.toolResults',
    editedAt: 'messages.editedAt',
    messageType: 'messages.messageType',
    status: 'messages.status',
    userId: 'messages.userId',
  },
  conversations: {
    id: 'conversations.id',
    type: 'conversations.type',
    contextId: 'conversations.contextId',
  },
}));

// Mock conversation repository (for access gate)
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn(),
    getAiAgent: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPPageScope: vi.fn(),
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
  loggers: { ai: { info: vi.fn(), error: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@/lib/ai/core/message-utils', () => ({ convertDbMessageToUIMessage: vi.fn((m) => m) }));

import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const mockUserId = 'user_123';
const mockAgentId = 'agent_123';
const mockConversationId = 'conv_123';

const mockWebAuth = (userId = mockUserId): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAgent = () => ({
  id: mockAgentId,
  title: 'Test Agent',
  type: 'AI_CHAT',
  driveId: 'drive_123',
});

const mockConversationRow = (overrides: Partial<{ userId: string; isShared: boolean }> = {}) => ({
  id: mockConversationId,
  userId: mockUserId,
  type: 'page',
  contextId: mockAgentId,
  title: null,
  isActive: true,
  isShared: false,
  agentPageId: null, rev: 0,
  planPageId: null,
  lastMessageAt: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-02'),
  ...overrides,
});

const createRequest = (agentId: string, conversationId: string) =>
  new Request(
    `https://example.com/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages`
  );

const createContext = (agentId: string, conversationId: string) => ({
  params: Promise.resolve({ agentId, conversationId }),
});

describe('GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    // The route resolves the agent through the repository (same as its two
    // sibling routes), not an inline pages query.
    vi.mocked(conversationRepository.getAiAgent).mockResolvedValue(
      mockAgent() as unknown as Awaited<ReturnType<typeof conversationRepository.getAiAgent>>
    );

    // Default: user owns conversation
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(mockConversationRow());
  });

  describe('conversation access gate', () => {
    it('should allow owner to access their private conversation', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        mockConversationRow({ userId: mockUserId, isShared: false })
      );

      const response = await GET(createRequest(mockAgentId, mockConversationId), createContext(mockAgentId, mockConversationId));

      expect(response.status).toBe(200);
    });

    it('should allow any drive member to access a shared conversation', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        mockConversationRow({ userId: 'other_user', isShared: true })
      );

      const response = await GET(createRequest(mockAgentId, mockConversationId), createContext(mockAgentId, mockConversationId));

      expect(response.status).toBe(200);
    });

    it('should return 403 when user tries to access another user\'s private conversation', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(
        mockConversationRow({ userId: 'other_user', isShared: false })
      );

      const response = await GET(createRequest(mockAgentId, mockConversationId), createContext(mockAgentId, mockConversationId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('access');
    });

    it('should allow access when conversation has no conversations row (legacy)', async () => {
      vi.mocked(conversationRepository.getConversation).mockResolvedValue(null);

      const response = await GET(createRequest(mockAgentId, mockConversationId), createContext(mockAgentId, mockConversationId));

      expect(response.status).toBe(200);
    });
  });
});
