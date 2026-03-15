/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/channels/[pageId]/messages/[messageId]/reactions
//
// Tests POST (add reaction) and DELETE (remove reaction) handlers.
// Mocks at the DB query level.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      channelMessages: { findFirst: vi.fn() },
      channelMessageReactions: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
    delete: vi.fn(),
  },
  channelMessages: { id: 'id', pageId: 'pageId' },
  channelMessageReactions: { id: 'id', messageId: 'messageId', userId: 'userId', emoji: 'emoji' },
  eq: vi.fn(),
  and: vi.fn((...args: any[]) => args),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    realtime: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    'x-broadcast-signature': 'test-sig',
  })),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { POST, DELETE } from '../route';

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

const makeParams = (pageId: string, messageId: string) => ({
  params: Promise.resolve({ pageId, messageId }),
});

const makeRequest = (method: string, body: object) =>
  new Request('https://example.com/api/channels/page_1/messages/msg_1/reactions', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ============================================================================
// POST /api/channels/[pageId]/messages/[messageId]/reactions
// ============================================================================

describe('POST /api/channels/[pageId]/messages/[messageId]/reactions', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_1';
  const messageId = 'msg_1';

  const mockInsertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: message exists
    vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue({
      id: messageId,
      pageId,
    } as any);

    // Default: insert chain
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);
    mockInsertChain.values.mockReturnValue(mockInsertChain);
    mockInsertChain.returning.mockResolvedValue([{
      id: 'reaction_1',
      messageId,
      userId: mockUserId,
      emoji: '👍',
    }]);

    // Default: findFirst for reaction with user
    vi.mocked(db.query.channelMessageReactions.findFirst).mockResolvedValue({
      id: 'reaction_1',
      messageId,
      userId: mockUserId,
      emoji: '👍',
      user: { id: mockUserId, name: 'Test User' },
    } as any);

    delete process.env.INTERNAL_REALTIME_URL;
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = makeRequest('POST', { emoji: '👍' });
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = makeRequest('POST', { emoji: '👍' });
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You need view permission to react to messages');
    });
  });

  describe('validation', () => {
    it('should return 400 when emoji is missing', async () => {
      const request = makeRequest('POST', {});
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Emoji is required');
    });

    it('should return 400 when emoji is not a string', async () => {
      const request = makeRequest('POST', { emoji: 123 });
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Emoji is required');
    });

    it('should return 404 when message not found in channel', async () => {
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(undefined as any);

      const request = makeRequest('POST', { emoji: '👍' });
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found');
    });
  });

  describe('success responses', () => {
    it('should create reaction successfully and return 201', async () => {
      const request = makeRequest('POST', { emoji: '👍' });
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.emoji).toBe('👍');
      expect(body.user).toBeDefined();
    });

    it('should return 409 when duplicate reaction (unique constraint violation)', async () => {
      const constraintError = new Error('unique_violation') as any;
      constraintError.code = '23505';
      mockInsertChain.returning.mockRejectedValue(constraintError);

      const request = makeRequest('POST', { emoji: '👍' });
      const response = await POST(request, makeParams(pageId, messageId));

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('Already reacted with this emoji');
    });
  });

  describe('broadcasting', () => {
    it('should broadcast reaction_added event when INTERNAL_REALTIME_URL is set', async () => {
      process.env.INTERNAL_REALTIME_URL = 'http://realtime:3001';
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = mockFetch;

      const request = makeRequest('POST', { emoji: '🎉' });
      await POST(request, makeParams(pageId, messageId));

      expect(mockFetch).toHaveBeenCalledWith(
        'http://realtime:3001/api/broadcast',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('reaction_added'),
        })
      );
    });
  });
});

// ============================================================================
// DELETE /api/channels/[pageId]/messages/[messageId]/reactions
// ============================================================================

describe('DELETE /api/channels/[pageId]/messages/[messageId]/reactions', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_1';
  const messageId = 'msg_1';

  const mockDeleteChain = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: message exists
    vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue({
      id: messageId,
      pageId,
    } as any);

    // Default: delete chain
    vi.mocked(db.delete).mockReturnValue(mockDeleteChain as any);
    mockDeleteChain.where.mockReturnValue(mockDeleteChain);
    mockDeleteChain.returning.mockResolvedValue([{
      id: 'reaction_1',
      messageId,
      userId: mockUserId,
      emoji: '👍',
    }]);

    delete process.env.INTERNAL_REALTIME_URL;
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = makeRequest('DELETE', { emoji: '👍' });
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = makeRequest('DELETE', { emoji: '👍' });
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You need view permission to manage reactions');
    });
  });

  describe('validation', () => {
    it('should return 400 when emoji is missing', async () => {
      const request = makeRequest('DELETE', {});
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Emoji is required');
    });

    it('should return 400 when emoji is not a string', async () => {
      const request = makeRequest('DELETE', { emoji: 42 });
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Emoji is required');
    });

    it('should return 404 when message not found', async () => {
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(undefined as any);

      const request = makeRequest('DELETE', { emoji: '👍' });
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Message not found');
    });

    it('should return 404 when reaction not found (empty result)', async () => {
      mockDeleteChain.returning.mockResolvedValue([]);

      const request = makeRequest('DELETE', { emoji: '👍' });
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Reaction not found');
    });
  });

  describe('success responses', () => {
    it('should delete reaction successfully and return success', async () => {
      const request = makeRequest('DELETE', { emoji: '👍' });
      const response = await DELETE(request, makeParams(pageId, messageId));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });
  });

  describe('broadcasting', () => {
    it('should broadcast reaction_removed event when INTERNAL_REALTIME_URL is set', async () => {
      process.env.INTERNAL_REALTIME_URL = 'http://realtime:3001';
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = mockFetch;

      const request = makeRequest('DELETE', { emoji: '🎉' });
      await DELETE(request, makeParams(pageId, messageId));

      expect(mockFetch).toHaveBeenCalledWith(
        'http://realtime:3001/api/broadcast',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('reaction_removed'),
        })
      );
    });
  });
});
