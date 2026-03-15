/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages
//
// Tests the route handler's contract for fetching conversation messages
// with cursor-based pagination for an AI page agent.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      chatMessages: { findFirst: vi.fn() },
    },
    select: vi.fn(),
  },
  chatMessages: {
    pageId: 'pageId',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    id: 'id',
  },
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed' },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPPageScope: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/ai/core', () => ({
  convertDbMessageToUIMessage: vi.fn((msg: any) => ({
    id: msg.id,
    role: msg.role,
    parts: [{ type: 'text', text: msg.content }],
    createdAt: msg.createdAt,
  })),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn((raw: string | null, opts: any) => {
    if (!raw) return opts.defaultValue;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) return opts.defaultValue;
    return Math.min(opts.max ?? parsed, Math.max(opts.min ?? parsed, parsed));
  }),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const AGENT_ID = 'agent_123';
const CONVERSATION_ID = 'conv_456';
const USER_ID = 'user_789';

const createParams = (): Promise<{ agentId: string; conversationId: string }> =>
  Promise.resolve({ agentId: AGENT_ID, conversationId: CONVERSATION_ID });

const createRequest = (queryString = ''): Request =>
  new Request(
    `https://example.com/api/ai/page-agents/${AGENT_ID}/conversations/${CONVERSATION_ID}/messages${queryString ? `?${queryString}` : ''}`
  );

const createDbMessage = (overrides: Partial<{
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  pageId: string;
  conversationId: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id ?? 'msg_1',
  role: overrides.role ?? 'user',
  content: overrides.content ?? 'Hello',
  createdAt: overrides.createdAt ?? new Date('2024-01-01T10:00:00Z'),
  pageId: overrides.pageId ?? AGENT_ID,
  conversationId: overrides.conversationId ?? CONVERSATION_ID,
  isActive: overrides.isActive ?? true,
  userId: USER_ID,
  messageType: 'standard',
  editedAt: null,
  toolCalls: null,
  toolResults: null,
});

const mockAgent = {
  id: AGENT_ID,
  type: 'AI_CHAT',
  isTrashed: false,
  title: 'Test Agent',
};

// Helper to set up the chainable db.select() mock
const setupDbSelectChain = (messages: any[] = []) => {
  const mockChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(messages),
  };
  vi.mocked(db.select).mockReturnValue(mockChain as any);
  return mockChain;
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockAgent as any);
    vi.mocked(db.query.chatMessages.findFirst).mockResolvedValue(null);
    setupDbSelectChain([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('agent validation', () => {
    it('should return 404 when agent not found (not AI_CHAT type or trashed)', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('AI agent not found');
    });
  });

  describe('MCP scope', () => {
    it('should return scope error when MCP check fails', async () => {
      const scopeErrorResponse = NextResponse.json(
        { error: 'Token not scoped to this page' },
        { status: 403 }
      );
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeErrorResponse);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Token not scoped to this page');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('message retrieval', () => {
    it('should return messages in chronological order (reversed from DESC)', async () => {
      const msg1 = createDbMessage({ id: 'msg_1', content: 'First', createdAt: new Date('2024-01-01T10:00:00Z') });
      const msg2 = createDbMessage({ id: 'msg_2', content: 'Second', createdAt: new Date('2024-01-01T11:00:00Z'), role: 'assistant' });
      // DB returns DESC order (newest first), route reverses to chronological
      setupDbSelectChain([msg2, msg1]);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      // After reverse: msg1 (oldest) should be first
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].id).toBe('msg_1');
      expect(body.messages[1].id).toBe('msg_2');
      expect(convertDbMessageToUIMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('cursor-based pagination', () => {
    it('should handle cursor-based pagination (before direction)', async () => {
      const cursorMsg = createDbMessage({ id: 'cursor_msg', createdAt: new Date('2024-01-01T12:00:00Z') });
      vi.mocked(db.query.chatMessages.findFirst).mockResolvedValue(cursorMsg as any);

      const msg1 = createDbMessage({ id: 'msg_older', createdAt: new Date('2024-01-01T10:00:00Z') });
      setupDbSelectChain([msg1]);

      const response = await GET(
        createRequest('cursor=cursor_msg&direction=before'),
        { params: createParams() }
      );

      expect(response.status).toBe(200);
      expect(db.query.chatMessages.findFirst).toHaveBeenCalled();
      const body = await response.json();
      expect(body.messages).toHaveLength(1);
      expect(body.pagination.direction).toBe('before');
    });

    it('should handle cursor-based pagination (after direction)', async () => {
      const cursorMsg = createDbMessage({ id: 'cursor_msg', createdAt: new Date('2024-01-01T10:00:00Z') });
      vi.mocked(db.query.chatMessages.findFirst).mockResolvedValue(cursorMsg as any);

      const msg1 = createDbMessage({ id: 'msg_newer', createdAt: new Date('2024-01-01T12:00:00Z') });
      setupDbSelectChain([msg1]);

      const response = await GET(
        createRequest('cursor=cursor_msg&direction=after'),
        { params: createParams() }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.messages).toHaveLength(1);
      expect(body.pagination.direction).toBe('after');
    });

    it('should proceed without cursor filter when cursor message not found', async () => {
      vi.mocked(db.query.chatMessages.findFirst).mockResolvedValue(null);

      const msg1 = createDbMessage({ id: 'msg_1' });
      setupDbSelectChain([msg1]);

      const response = await GET(
        createRequest('cursor=nonexistent_msg'),
        { params: createParams() }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.messages).toHaveLength(1);
    });

    it('should return hasMore=true and cursors when more messages exist', async () => {
      // Create limit+1 messages to trigger hasMore
      // Default limit is 50, so create 51 messages
      const messages = Array.from({ length: 51 }, (_, i) =>
        createDbMessage({
          id: `msg_${i}`,
          createdAt: new Date(`2024-01-01T${String(10 + i).padStart(2, '0')}:00:00Z`),
        })
      );
      setupDbSelectChain(messages);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      // Only 50 messages returned (not the extra one)
      expect(body.messages).toHaveLength(50);
      expect(body.pagination.hasMore).toBe(true);
      expect(body.pagination.nextCursor).toBeTruthy();
      expect(body.pagination.prevCursor).toBeTruthy();
    });

    it('should return hasMore=false when no more messages exist', async () => {
      const messages = [
        createDbMessage({ id: 'msg_1' }),
        createDbMessage({ id: 'msg_2' }),
      ];
      setupDbSelectChain(messages);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.messages).toHaveLength(2);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  describe('limit parameter', () => {
    it('should respect limit parameter', async () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        createDbMessage({ id: `msg_${i}` })
      );
      const mockChain = setupDbSelectChain(messages);

      const response = await GET(createRequest('limit=5'), { params: createParams() });

      expect(response.status).toBe(200);
      // Route requests limit+1 to detect hasMore
      expect(mockChain.limit).toHaveBeenCalledWith(6);
      const body = await response.json();
      // 6 messages returned from db means hasMore=true, so only 5 returned
      expect(body.messages).toHaveLength(5);
      expect(body.pagination.hasMore).toBe(true);
      expect(body.pagination.limit).toBe(5);
    });
  });

  describe('response format', () => {
    it('should include conversationId and messageCount in response', async () => {
      const messages = [createDbMessage({ id: 'msg_1' })];
      setupDbSelectChain(messages);

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.conversationId).toBe(CONVERSATION_ID);
      expect(body.messageCount).toBe(1);
      expect(body.pagination).toMatchObject({
        hasMore: false,
        limit: 50,
        direction: 'before',
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 when an unexpected error occurs', async () => {
      vi.mocked(db.query.pages.findFirst).mockRejectedValue(new Error('Database connection lost'));

      const response = await GET(createRequest(), { params: createParams() });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to load conversation messages');
    });
  });
});
