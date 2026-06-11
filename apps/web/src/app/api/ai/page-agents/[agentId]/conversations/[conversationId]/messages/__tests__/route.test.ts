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
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      chatMessages: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
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
  and: vi.fn((...c) => ({ kind: 'and', c })),
  desc: vi.fn((f) => ({ kind: 'desc', f })),
  sql: Object.assign(vi.fn(), { as: vi.fn() }),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'chatMessages.id',
    pageId: 'chatMessages.pageId',
    conversationId: 'chatMessages.conversationId',
    isActive: 'chatMessages.isActive',
    createdAt: 'chatMessages.createdAt',
  },
  pages: { id: 'pages.id', type: 'pages.type', isTrashed: 'pages.isTrashed' },
}));

// Mock conversation repository (for access gate)
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn(),
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
import { db } from '@pagespace/db/db';

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
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(
      mockAgent() as unknown as Awaited<ReturnType<typeof db.query.pages.findFirst>>
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
