/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/channels/[pageId]/messages
//
// Tests GET (fetch messages with cursor pagination) and POST (create message)
// route handlers. Mocks at the DB query level.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      channelMessages: { findMany: vi.fn(), findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
      driveMembers: { findMany: vi.fn() },
    },
    insert: vi.fn(),
    select: vi.fn(),
  },
  channelMessages: { pageId: 'pageId', isActive: 'isActive', createdAt: 'createdAt', id: 'id' },
  channelReadStatus: { userId: 'userId', channelId: 'channelId' },
  files: { id: 'id' },
  pages: { id: 'id' },
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role' },
  pagePermissions: { pageId: 'pageId', userId: 'userId', canView: 'canView', expiresAt: 'expiresAt' },
  eq: vi.fn(),
  and: vi.fn((...args: any[]) => args),
  desc: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPPageScope: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(),
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

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
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

const createMessageFixture = (overrides: Partial<{
  id: string;
  pageId: string;
  userId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: object | null;
  isActive: boolean;
  createdAt: Date;
  user: object;
  file: object | null;
  reactions: any[];
}> = {}) => ({
  id: overrides.id ?? 'msg_1',
  pageId: overrides.pageId ?? 'page_1',
  userId: overrides.userId ?? 'user_1',
  content: overrides.content ?? 'Hello world',
  fileId: overrides.fileId ?? null,
  attachmentMeta: overrides.attachmentMeta ?? null,
  isActive: overrides.isActive ?? true,
  aiMeta: null,
  createdAt: overrides.createdAt ?? new Date('2024-06-01T12:00:00Z'),
  user: overrides.user ?? { id: 'user_1', name: 'Test User', image: null },
  file: overrides.file ?? null,
  reactions: overrides.reactions ?? [],
});

const makeParams = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

// ============================================================================
// GET /api/channels/[pageId]/messages
// ============================================================================

describe('GET /api/channels/[pageId]/messages', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_channel_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.channelMessages.findMany).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/channels/${pageId}/messages`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(401);
    });

    it('should return MCP scope error when scope check fails', async () => {
      const scopeResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeResponse);

      const request = new Request(`https://example.com/api/channels/${pageId}/messages`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(403);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/channels/${pageId}/messages`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You need view permission to access this channel');
    });
  });

  describe('success responses', () => {
    it('should return messages in chronological order', async () => {
      const messages = [
        createMessageFixture({ id: 'msg_3', createdAt: new Date('2024-06-03') }),
        createMessageFixture({ id: 'msg_2', createdAt: new Date('2024-06-02') }),
        createMessageFixture({ id: 'msg_1', createdAt: new Date('2024-06-01') }),
      ];
      vi.mocked(db.query.channelMessages.findMany).mockResolvedValue(messages);

      const request = new Request(`https://example.com/api/channels/${pageId}/messages`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(200);
      const body = await response.json();
      // Messages are reversed from DESC order to chronological (oldest first)
      expect(body.messages[0].id).toBe('msg_1');
      expect(body.messages[2].id).toBe('msg_3');
    });

    it('should return hasMore=false when no more messages exist', async () => {
      const messages = [
        createMessageFixture({ id: 'msg_1' }),
      ];
      vi.mocked(db.query.channelMessages.findMany).mockResolvedValue(messages);

      const request = new Request(`https://example.com/api/channels/${pageId}/messages`);
      const response = await GET(request, makeParams(pageId));
      const body = await response.json();

      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
    });

    it('should return hasMore=true and nextCursor when more messages exist', async () => {
      // When limit+1 messages are returned, there are more
      // Default limit is 50, so we need 51 messages to trigger hasMore
      const messages = Array.from({ length: 4 }, (_, i) =>
        createMessageFixture({
          id: `msg_${i}`,
          createdAt: new Date(`2024-06-${String(10 - i).padStart(2, '0')}`),
        })
      );
      vi.mocked(db.query.channelMessages.findMany).mockResolvedValue(messages);

      const request = new Request(`https://example.com/api/channels/${pageId}/messages?limit=3`);
      const response = await GET(request, makeParams(pageId));
      const body = await response.json();

      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBeTruthy();
      expect(body.messages).toHaveLength(3);
    });

    it('should respect limit param and clamp between 1 and 200', async () => {
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?limit=5`);
      await GET(request, makeParams(pageId));

      expect(db.query.channelMessages.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 6 }) // limit + 1 for hasMore check
      );
    });

    it('should default limit to 50 when limit=0 (falsy)', async () => {
      // parseInt('0') is 0, and `0 || 50` evaluates to 50
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?limit=0`);
      await GET(request, makeParams(pageId));

      expect(db.query.channelMessages.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 51 }) // 50 + 1
      );
    });

    it('should clamp limit to maximum of 200', async () => {
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?limit=500`);
      await GET(request, makeParams(pageId));

      expect(db.query.channelMessages.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 201 }) // 200 + 1
      );
    });
  });

  describe('cursor pagination', () => {
    it('should handle valid composite cursor', async () => {
      vi.mocked(db.query.channelMessages.findMany).mockResolvedValue([]);

      const cursor = '2024-06-01T12:00:00.000Z|msg_5';
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?cursor=${encodeURIComponent(cursor)}`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(200);
    });

    it('should return 400 for invalid cursor format with no separator', async () => {
      const cursor = 'invalid-cursor-no-pipe';
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?cursor=${encodeURIComponent(cursor)}`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid cursor format');
    });

    it('should return 400 for invalid cursor with bad date', async () => {
      const cursor = 'not-a-date|msg_1';
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?cursor=${encodeURIComponent(cursor)}`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid cursor');
    });

    it('should return 400 for invalid cursor with missing id', async () => {
      const cursor = '2024-06-01T12:00:00.000Z|';
      const request = new Request(`https://example.com/api/channels/${pageId}/messages?cursor=${encodeURIComponent(cursor)}`);
      const response = await GET(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid cursor');
    });
  });
});

// ============================================================================
// POST /api/channels/[pageId]/messages
// ============================================================================

describe('POST /api/channels/[pageId]/messages', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_channel_1';

  const mockInsertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: db.insert returns a chain
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);
    mockInsertChain.values.mockReturnValue(mockInsertChain);
    mockInsertChain.returning.mockResolvedValue([createMessageFixture({ userId: mockUserId })]);
    mockInsertChain.onConflictDoUpdate.mockReturnValue({
      set: vi.fn().mockResolvedValue(undefined),
    });

    // Default: findFirst for newly created message
    vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(
      createMessageFixture({ userId: mockUserId })
    );

    // Default: no channel page (to avoid inbox broadcast errors)
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);

    // Reset environment
    delete process.env.INTERNAL_REALTIME_URL;
  });

  const makePostRequest = (body: object) =>
    new Request(`https://example.com/api/channels/${pageId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = makePostRequest({ content: 'hello' });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(401);
    });

    it('should return MCP scope error when scope check fails', async () => {
      const scopeResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPPageScope).mockResolvedValue(scopeResponse);

      const request = makePostRequest({ content: 'hello' });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(403);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = makePostRequest({ content: 'hello' });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You need edit permission to send messages in this channel');
    });
  });

  describe('validation', () => {
    it('should return 400 when fileId provided but file not found', async () => {
      vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined as any);

      const request = makePostRequest({ content: 'hello', fileId: 'nonexistent_file' });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('File not found');
    });
  });

  describe('success responses', () => {
    it('should create message successfully with content only', async () => {
      const newMsg = createMessageFixture({ userId: mockUserId, content: 'Hello channel!' });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({ content: 'Hello channel!' });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.content).toBe('Hello channel!');
    });

    it('should create message with fileId and attachment', async () => {
      vi.mocked(db.query.files.findFirst).mockResolvedValue({
        id: 'file_1',
        mimeType: 'image/png',
        sizeBytes: 1024,
      } as any);

      const attachmentMeta = {
        originalName: 'screenshot.png',
        size: 1024,
        mimeType: 'image/png',
        contentHash: 'abc123',
      };
      const newMsg = createMessageFixture({
        userId: mockUserId,
        content: 'Check this out',
        fileId: 'file_1',
        attachmentMeta,
      });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({
        content: 'Check this out',
        fileId: 'file_1',
        attachmentMeta,
      });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(201);
      expect(db.insert).toHaveBeenCalled();
    });

    it('should handle non-string content by defaulting to empty string', async () => {
      const newMsg = createMessageFixture({ userId: mockUserId, content: '' });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({ content: 123 });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(201);
      // The values call should have content as empty string
      expect(mockInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ content: '' })
      );
    });

    it('should update channel read status for sender', async () => {
      const newMsg = createMessageFixture({ userId: mockUserId });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({ content: 'hello' });
      await POST(request, makeParams(pageId));

      // db.insert is called twice: once for the message, once for read status
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('should return 201 with the created message', async () => {
      const newMsg = createMessageFixture({ id: 'msg_new', userId: mockUserId });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({ content: 'new message' });
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe('msg_new');
    });
  });

  describe('broadcasting', () => {
    it('should broadcast message when INTERNAL_REALTIME_URL is set', async () => {
      process.env.INTERNAL_REALTIME_URL = 'http://realtime:3001';
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = mockFetch;

      const newMsg = createMessageFixture({ userId: mockUserId });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({ content: 'broadcast me' });
      await POST(request, makeParams(pageId));

      expect(mockFetch).toHaveBeenCalledWith(
        'http://realtime:3001/api/broadcast',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should not broadcast when INTERNAL_REALTIME_URL is not set', async () => {
      delete process.env.INTERNAL_REALTIME_URL;
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const newMsg = createMessageFixture({ userId: mockUserId });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      const request = makePostRequest({ content: 'no broadcast' });
      await POST(request, makeParams(pageId));

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should broadcast inbox events to channel members with view permissions', async () => {
      const newMsg = createMessageFixture({ userId: mockUserId, content: 'hey everyone' });
      mockInsertChain.returning.mockResolvedValue([newMsg]);
      vi.mocked(db.query.channelMessages.findFirst).mockResolvedValue(newMsg);

      // Channel page with driveId
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        driveId: 'drive_1',
        title: 'General',
        drive: { ownerId: 'owner_1', name: 'Test Drive', slug: 'test' },
      } as any);

      // Drive members
      vi.mocked(db.query.driveMembers.findMany).mockResolvedValue([
        { userId: 'member_1' },
        { userId: 'member_2' },
      ] as any);

      // Admin members query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'member_1' }]),
        }),
      } as any);

      const request = makePostRequest({ content: 'hey everyone' });
      await POST(request, makeParams(pageId));

      // broadcastInboxEvent should be called for members with view access
      expect(broadcastInboxEvent).toHaveBeenCalled();
    });
  });
});
