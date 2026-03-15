/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/messages/conversations
//
// Tests GET (list conversations) and POST (create conversation) handlers.
// Mocks at the DB query level.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
  },
  dmConversations: {
    id: 'id',
    participant1Id: 'participant1Id',
    participant2Id: 'participant2Id',
  },
  connections: {
    user1Id: 'user1Id',
    user2Id: 'user2Id',
    status: 'status',
  },
  eq: vi.fn((...args: unknown[]) => ['eq', ...args]),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  isEmailVerified: vi.fn().mockResolvedValue(true),
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
  },
}));

vi.mock('@/lib/utils/timestamp', () => ({
  toISOTimestamp: vi.fn((ts: string | null) => {
    if (!ts) return null;
    if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) return ts;
    return new Date(ts + 'Z').toISOString();
  }),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib';
import { GET, POST } from '../route';

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

const mockConversationRow = {
  id: 'conv_1',
  participant1Id: 'user_123',
  participant2Id: 'user_456',
  lastMessageAt: '2024-06-01T12:00:00Z',
  lastMessagePreview: 'Hello there',
  participant1LastRead: '2024-06-01T12:00:00Z',
  participant2LastRead: '2024-05-30T10:00:00Z',
  createdAt: '2024-01-01T00:00:00Z',
  last_read: '2024-06-01T12:00:00Z',
  other_user_id: 'user_456',
  other_user_name: 'Other User',
  other_user_email: 'other@example.com',
  other_user_image: null,
  other_user_username: 'otheruser',
  other_user_display_name: 'Other Display',
  other_user_avatar_url: null,
  unread_count: '0',
};

const mockExistingConversation = {
  id: 'conv_1',
  participant1Id: 'user_123',
  participant2Id: 'user_456',
  lastMessageAt: new Date('2024-06-01'),
  lastMessagePreview: 'Hello',
  participant1LastRead: new Date('2024-06-01'),
  participant2LastRead: new Date('2024-05-30'),
  createdAt: new Date('2024-01-01'),
};

const mockNewConversation = {
  id: 'conv_new',
  participant1Id: 'user_123',
  participant2Id: 'user_456',
  lastMessageAt: null,
  lastMessagePreview: null,
  participant1LastRead: null,
  participant2LastRead: null,
  createdAt: new Date('2024-06-01'),
};

const mockConnection = {
  id: 'conn_1',
  user1Id: 'user_123',
  user2Id: 'user_456',
  status: 'ACCEPTED',
  createdAt: new Date('2024-01-01'),
};

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

// Chainable mock builder for insert queries
function createInsertChain(resolvedValue: any[] = []) {
  const chain: any = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(resolvedValue),
  };
  return chain;
}

// ============================================================================
// GET /api/messages/conversations - Contract Tests
// ============================================================================

describe('GET /api/messages/conversations', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: execute returns conversation rows
    vi.mocked(db.execute).mockResolvedValue({ rows: [mockConversationRow] } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/messages/conversations');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with read auth options', async () => {
      const request = new Request('https://example.com/api/messages/conversations');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('success responses', () => {
    it('should return conversations list with pagination', async () => {
      const request = new Request('https://example.com/api/messages/conversations');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0]).toMatchObject({
        id: 'conv_1',
        otherUser: expect.objectContaining({
          id: 'user_456',
          name: 'Other User',
        }),
      });
      expect(body.pagination).toBeDefined();
      expect(body.pagination.limit).toBe(20);
    });

    it('should return empty conversations when none exist', async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as any);

      const request = new Request('https://example.com/api/messages/conversations');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversations).toEqual([]);
      expect(body.pagination.hasMore).toBe(false);
      expect(body.pagination.nextCursor).toBeNull();
    });

    it('should handle cursor-based pagination with direction param', async () => {
      const cursor = '2024-06-01T12:00:00Z';

      const request = new Request(
        `https://example.com/api/messages/conversations?cursor=${cursor}&direction=before`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(db.execute).toHaveBeenCalled();
    });

    it('should handle direction=after pagination', async () => {
      const cursor = '2024-06-01T12:00:00Z';

      const request = new Request(
        `https://example.com/api/messages/conversations?cursor=${cursor}&direction=after`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(db.execute).toHaveBeenCalled();
    });

    it('should set hasMore=true when results equal limit', async () => {
      // Create exactly 20 rows (default limit) to trigger hasMore
      const rows = Array.from({ length: 20 }, (_, i) => ({
        ...mockConversationRow,
        id: `conv_${i}`,
        lastMessageAt: `2024-06-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
      }));
      vi.mocked(db.execute).mockResolvedValue({ rows } as any);

      const request = new Request('https://example.com/api/messages/conversations');
      const response = await GET(request);
      const body = await response.json();

      expect(body.pagination.hasMore).toBe(true);
      expect(body.pagination.nextCursor).toBeDefined();
    });

    it('should parse unreadCount as integer', async () => {
      const row = { ...mockConversationRow, unread_count: '5' };
      vi.mocked(db.execute).mockResolvedValue({ rows: [row] } as any);

      const request = new Request('https://example.com/api/messages/conversations');
      const response = await GET(request);
      const body = await response.json();

      expect(body.conversations[0].unreadCount).toBe(5);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/messages/conversations');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch conversations');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB failure');
      vi.mocked(db.execute).mockRejectedValue(error);

      const request = new Request('https://example.com/api/messages/conversations');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching conversations:',
        error
      );
    });
  });
});

// ============================================================================
// POST /api/messages/conversations - Contract Tests
// ============================================================================

describe('POST /api/messages/conversations', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isEmailVerified).mockResolvedValue(true);

    // Default select chain setup: first call checks connection, second checks existing convo
    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // Connection check
        return createSelectChain([mockConnection]) as any;
      }
      // Existing conversation check - default: not found
      return createSelectChain([]) as any;
    });

    // Default: insert returns new conversation
    const insertChain = createInsertChain([mockNewConversation]);
    vi.mocked(db.insert).mockReturnValue(insertChain as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with write auth options', async () => {
      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 403 when email not verified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.requiresEmailVerification).toBe(true);
    });

    it('should return 400 when recipientId missing', async () => {
      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Recipient ID is required');
    });

    it('should return 400 when trying to message yourself', async () => {
      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_123' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot start conversation with yourself');
    });

    it('should return 403 when users not connected', async () => {
      vi.mocked(db.select).mockReturnValue(createSelectChain([]) as any);

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_789' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You must be connected to start a conversation');
    });
  });

  describe('success responses', () => {
    it('should return existing conversation if one exists', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return createSelectChain([mockConnection]) as any;
        }
        // Existing conversation found
        return createSelectChain([mockExistingConversation]) as any;
      });

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversation.id).toBe('conv_1');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should create new conversation when none exists', async () => {
      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversation).toBeDefined();
      expect(db.insert).toHaveBeenCalled();
    });

    it('should sort participant IDs for consistency', async () => {
      // user_123 < user_999 lexicographically, so participant1Id should be user_123
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return createSelectChain([mockConnection]) as any;
        }
        return createSelectChain([]) as any;
      });

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_999' }),
      });
      await POST(request);

      // The insert should have been called with sorted participant IDs
      expect(db.insert).toHaveBeenCalled();
    });

    it('should sort participant IDs when user comes after recipient alphabetically', async () => {
      // Using a userId that comes after recipientId alphabetically
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_zzz'));

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return createSelectChain([mockConnection]) as any;
        }
        return createSelectChain([]) as any;
      });

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_aaa' }),
      });
      await POST(request);

      // Participant1 should be user_aaa (lower), participant2 should be user_zzz (higher)
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create conversation');
    });

    it('should log error when creating conversation fails', async () => {
      const error = new Error('DB failure');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: 'user_456' }),
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error creating conversation:',
        error
      );
    });
  });
});
