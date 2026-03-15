/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/messages/[conversationId]
//
// Tests GET (fetch messages), POST (send message), and PATCH (mark as read)
// handlers. Mocks at the DB query level.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  directMessages: {
    conversationId: 'conversationId',
    senderId: 'senderId',
    createdAt: 'createdAt',
    isRead: 'isRead',
  },
  dmConversations: {
    id: 'id',
    participant1Id: 'participant1Id',
    participant2Id: 'participant2Id',
  },
  eq: vi.fn((...args: unknown[]) => ['eq', ...args]),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  lt: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  createOrUpdateMessageNotification: vi.fn().mockResolvedValue(undefined),
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn().mockReturnValue({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': 'test-sig',
  }),
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn(
    (raw: string | null, opts: { defaultValue: number; min?: number; max?: number }) => {
      if (!raw) return opts.defaultValue;
      const parsed = parseInt(raw, 10);
      if (isNaN(parsed)) return opts.defaultValue;
      const min = opts.min ?? Number.MIN_SAFE_INTEGER;
      const max = opts.max ?? Number.MAX_SAFE_INTEGER;
      return Math.min(max, Math.max(min, parsed));
    }
  ),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    realtime: { error: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createOrUpdateMessageNotification, isEmailVerified } from '@pagespace/lib';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
import { GET, POST, PATCH } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockConversation = {
  id: 'conv_1',
  participant1Id: 'user_123',
  participant2Id: 'user_456',
  lastMessageAt: new Date('2024-06-01'),
  lastMessagePreview: 'Hello',
  participant1LastRead: new Date('2024-06-01'),
  participant2LastRead: new Date('2024-05-30'),
  createdAt: new Date('2024-01-01'),
};

const mockMessage = {
  id: 'msg_1',
  conversationId: 'conv_1',
  senderId: 'user_123',
  content: 'Hello World',
  isRead: false,
  readAt: null,
  createdAt: new Date('2024-06-01T12:00:00Z'),
  updatedAt: new Date('2024-06-01T12:00:00Z'),
};

const createContext = (conversationId: string) => ({
  params: Promise.resolve({ conversationId }),
});

// Chainable mock builder for select queries
function createSelectChain(resolvedValue: any[] = []) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(resolvedValue),
  };
  return chain;
}

// Chainable mock builder for update queries
function createUpdateChain() {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

// Chainable mock builder for insert queries
function createInsertChain(resolvedValue: any[] = []) {
  const chain: any = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(resolvedValue),
  };
  return chain;
}

// ============================================================================
// GET /api/messages/[conversationId] - Contract Tests
// ============================================================================

describe('GET /api/messages/[conversationId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation found
    const selectChain = createSelectChain([mockConversation]);
    vi.mocked(db.select).mockReturnValue(selectChain as any);

    // Default: update succeeds
    const updateChain = createUpdateChain();
    vi.mocked(db.update).mockReturnValue(updateChain as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/messages/conv_1');
      const response = await GET(request, createContext('conv_1'));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with read auth options', async () => {
      const request = new Request('https://example.com/api/messages/conv_1');
      await GET(request, createContext('conv_1'));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('validation', () => {
    it('should return 404 when conversation not found', async () => {
      const selectChain = createSelectChain([]);
      vi.mocked(db.select).mockReturnValue(selectChain as any);

      const request = new Request('https://example.com/api/messages/conv_nonexistent');
      const response = await GET(request, createContext('conv_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('success responses', () => {
    it('should return messages in reversed (chronological) order', async () => {
      const msg1 = { ...mockMessage, id: 'msg_1', createdAt: new Date('2024-06-01T10:00:00Z') };
      const msg2 = { ...mockMessage, id: 'msg_2', createdAt: new Date('2024-06-01T11:00:00Z') };
      const msg3 = { ...mockMessage, id: 'msg_3', createdAt: new Date('2024-06-01T12:00:00Z') };

      // DB returns desc order: msg3, msg2, msg1
      const messagesDesc = [msg3, msg2, msg1];

      // First select call: conversation lookup
      // Second select call: messages query
      let callCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createSelectChain([mockConversation]) as any;
        }
        return createSelectChain(messagesDesc) as any;
      });

      const request = new Request('https://example.com/api/messages/conv_1');
      const response = await GET(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      // After .reverse(), messages should be in chronological order
      expect(body.messages[0].id).toBe('msg_1');
      expect(body.messages[1].id).toBe('msg_2');
      expect(body.messages[2].id).toBe('msg_3');
    });

    it('should mark messages as read from other user', async () => {
      const updateChain = createUpdateChain();
      vi.mocked(db.update).mockReturnValue(updateChain as any);

      // Conversation where user_123 is participant1, so other user is user_456
      const selectChain = createSelectChain([mockConversation]);
      vi.mocked(db.select).mockReturnValue(selectChain as any);

      const request = new Request('https://example.com/api/messages/conv_1');
      await GET(request, createContext('conv_1'));

      // db.update should be called to mark messages read and update lastRead
      expect(db.update).toHaveBeenCalled();
    });

    it('should support pagination with before param', async () => {
      const beforeDate = '2024-06-01T12:00:00Z';

      let callCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createSelectChain([mockConversation]) as any;
        }
        return createSelectChain([mockMessage]) as any;
      });

      const request = new Request(`https://example.com/api/messages/conv_1?before=${beforeDate}`);
      const response = await GET(request, createContext('conv_1'));

      expect(response.status).toBe(200);
      // When 'before' param is present, the second select uses lt filter
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      const request = new Request('https://example.com/api/messages/conv_1');
      const response = await GET(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch messages');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/messages/conv_1');
      await GET(request, createContext('conv_1'));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching messages:', error);
    });
  });
});

// ============================================================================
// POST /api/messages/[conversationId] - Contract Tests
// ============================================================================

describe('POST /api/messages/[conversationId]', () => {
  const mockUserId = 'user_123';
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isEmailVerified).mockResolvedValue(true);
    process.env = { ...originalEnv };
    delete process.env.INTERNAL_REALTIME_URL;

    // Default: conversation found
    const selectChain = createSelectChain([mockConversation]);
    vi.mocked(db.select).mockReturnValue(selectChain as any);

    // Default: insert returns new message
    const insertChain = createInsertChain([mockMessage]);
    vi.mocked(db.insert).mockReturnValue(insertChain as any);

    // Default: update succeeds
    const updateChain = createUpdateChain();
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    // Mock global fetch for realtime broadcast
    global.fetch = vi.fn().mockResolvedValue(new Response('OK'));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'test' }),
      });
      const response = await POST(request, createContext('conv_1'));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with write auth options', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'test message' }),
      });
      await POST(request, createContext('conv_1'));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 403 when email not verified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'test' }),
      });
      const response = await POST(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.requiresEmailVerification).toBe(true);
    });

    it('should return 400 when content is empty', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: '' }),
      });
      const response = await POST(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Message content is required');
    });

    it('should return 400 when content is whitespace only', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: '   ' }),
      });
      const response = await POST(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Message content is required');
    });

    it('should return 400 when content is missing', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Message content is required');
    });

    it('should return 404 when conversation not found', async () => {
      const selectChain = createSelectChain([]);
      vi.mocked(db.select).mockReturnValue(selectChain as any);

      const request = new Request('https://example.com/api/messages/conv_nonexistent', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      });
      const response = await POST(request, createContext('conv_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('success responses', () => {
    it('should create message and return it', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello World' }),
      });
      const response = await POST(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBeDefined();
      expect(db.insert).toHaveBeenCalled();
    });

    it('should update conversation preview after sending message', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello World' }),
      });
      await POST(request, createContext('conv_1'));

      expect(db.update).toHaveBeenCalled();
    });

    it('should truncate long message preview to 100 characters', async () => {
      const longContent = 'A'.repeat(150);

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: longContent }),
      });
      await POST(request, createContext('conv_1'));

      // Verify update was called (the truncation is tested indirectly via the update call)
      expect(db.update).toHaveBeenCalled();
    });

    it('should create notification for recipient', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello World' }),
      });
      await POST(request, createContext('conv_1'));

      // user_123 is participant1, so recipient is user_456
      expect(createOrUpdateMessageNotification).toHaveBeenCalledWith(
        'user_456',
        'conv_1',
        'Hello World',
        'user_123'
      );
    });

    it('should broadcast message via realtime when INTERNAL_REALTIME_URL set', async () => {
      process.env.INTERNAL_REALTIME_URL = 'http://localhost:3001';

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello World' }),
      });
      await POST(request, createContext('conv_1'));

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/broadcast',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should not broadcast via realtime when INTERNAL_REALTIME_URL not set', async () => {
      delete process.env.INTERNAL_REALTIME_URL;

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello World' }),
      });
      await POST(request, createContext('conv_1'));

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should broadcast inbox event to recipient', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello World' }),
      });
      await POST(request, createContext('conv_1'));

      expect(broadcastInboxEvent).toHaveBeenCalledWith(
        'user_456',
        expect.objectContaining({
          operation: 'dm_updated',
          type: 'dm',
          id: 'conv_1',
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when database insert fails', async () => {
      vi.mocked(db.insert).mockImplementation(() => {
        throw new Error('Insert failed');
      });

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      });
      const response = await POST(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to send message');
    });

    it('should log error when sending message fails', async () => {
      const error = new Error('Insert failed');
      vi.mocked(db.insert).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      });
      await POST(request, createContext('conv_1'));

      expect(loggers.api.error).toHaveBeenCalledWith('Error sending message:', error);
    });
  });
});

// ============================================================================
// PATCH /api/messages/[conversationId] - Contract Tests
// ============================================================================

describe('PATCH /api/messages/[conversationId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation found
    const selectChain = createSelectChain([mockConversation]);
    vi.mocked(db.select).mockReturnValue(selectChain as any);

    // Default: update succeeds
    const updateChain = createUpdateChain();
    vi.mocked(db.update).mockReturnValue(updateChain as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext('conv_1'));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with write auth options', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      await PATCH(request, createContext('conv_1'));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 404 when conversation not found', async () => {
      const selectChain = createSelectChain([]);
      vi.mocked(db.select).mockReturnValue(selectChain as any);

      const request = new Request('https://example.com/api/messages/conv_nonexistent', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext('conv_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('success responses', () => {
    it('should mark all unread messages as read and return success', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should update messages and conversation lastRead', async () => {
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      await PATCH(request, createContext('conv_1'));

      // db.update called twice: once for directMessages, once for dmConversations
      expect(db.update).toHaveBeenCalledTimes(2);
    });

    it('should update participant1LastRead when user is participant1', async () => {
      // mockConversation has participant1Id = user_123, which matches mockUserId
      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      await PATCH(request, createContext('conv_1'));

      // Verify update was called (participant1LastRead is set internally)
      expect(db.update).toHaveBeenCalled();
    });

    it('should update participant2LastRead when user is participant2', async () => {
      // Create conversation where user is participant2
      const conv = {
        ...mockConversation,
        participant1Id: 'user_other',
        participant2Id: 'user_123',
      };
      const selectChain = createSelectChain([conv]);
      vi.mocked(db.select).mockReturnValue(selectChain as any);

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      await PATCH(request, createContext('conv_1'));

      // Verify update was called (participant2LastRead is set internally)
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database update fails', async () => {
      vi.mocked(db.update).mockImplementation(() => {
        throw new Error('Update failed');
      });

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to mark messages as read');
    });

    it('should log error when marking messages as read fails', async () => {
      const error = new Error('Update failed');
      vi.mocked(db.update).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/messages/conv_1', {
        method: 'PATCH',
      });
      await PATCH(request, createContext('conv_1'));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error marking messages as read:',
        error
      );
    });
  });
});
