/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/messages/threads
//
// Tests GET handler for fetching unified message threads (DMs + channels).
// Mocks at the DB query level.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    execute: vi.fn(),
  },
  sql: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { GET } from '../route';

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

const mockDmRow = {
  id: 'conv_1',
  participant1Id: 'user_123',
  participant2Id: 'user_456',
  lastMessageAt: '2024-06-01 12:00:00',
  lastMessagePreview: 'Hello there',
  participant1LastRead: '2024-06-01 12:00:00',
  participant2LastRead: '2024-05-30 10:00:00',
  createdAt: '2024-01-01 00:00:00',
  last_read: '2024-06-01 12:00:00',
  other_user_id: 'user_456',
  other_user_name: 'Other User',
  other_user_email: 'other@example.com',
  other_user_image: null,
  other_user_username: 'otheruser',
  other_user_display_name: 'Other Display',
  other_user_avatar_url: null,
  unread_count: '3',
};

const mockChannelRow = {
  id: 'channel_1',
  title: 'General Discussion',
  driveId: 'drive_1',
  drive_name: 'My Drive',
  updatedAt: '2024-06-01 15:00:00',
  last_message: 'Latest channel message',
  last_message_at: '2024-06-01 14:00:00',
};

// ============================================================================
// GET /api/messages/threads - Contract Tests
// ============================================================================

describe('GET /api/messages/threads', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: first execute returns DMs, second returns channels
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [mockDmRow] } as any)
      .mockResolvedValueOnce({ rows: [mockChannelRow] } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only auth options', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('success responses', () => {
    it('should return both dms and channels data', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dms).toHaveLength(1);
      expect(body.channels).toHaveLength(1);
    });

    it('should return DMs with correct structure', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      const dm = body.dms[0];
      expect(dm.id).toBe('conv_1');
      expect(dm.otherUser).toMatchObject({
        id: 'user_456',
        name: 'Other User',
        email: 'other@example.com',
      });
      expect(dm.unreadCount).toBe(3);
    });

    it('should return channels with correct structure', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      const channel = body.channels[0];
      expect(channel.id).toBe('channel_1');
      expect(channel.title).toBe('General Discussion');
      expect(channel.driveId).toBe('drive_1');
      expect(channel.driveName).toBe('My Drive');
      expect(channel.lastMessage).toBe('Latest channel message');
    });

    it('should handle empty results', async () => {
      vi.mocked(db.execute)
        .mockReset()
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dms).toEqual([]);
      expect(body.channels).toEqual([]);
    });

    it('should handle DMs with null timestamps', async () => {
      const dmWithNulls = {
        ...mockDmRow,
        lastMessageAt: null,
        participant1LastRead: null,
        participant2LastRead: null,
        last_read: null,
      };
      vi.mocked(db.execute)
        .mockReset()
        .mockResolvedValueOnce({ rows: [dmWithNulls] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dms[0].lastMessageAt).toBeNull();
      expect(body.dms[0].lastRead).toBeNull();
    });

    it('should handle channels with null last message', async () => {
      const channelNoMessage = {
        ...mockChannelRow,
        last_message: null,
        last_message_at: null,
      };
      vi.mocked(db.execute)
        .mockReset()
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [channelNoMessage] } as any);

      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.channels[0].lastMessage).toBeNull();
      expect(body.channels[0].lastMessageAt).toBeNull();
    });

    it('should convert DM timestamps to ISO format', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      const dm = body.dms[0];
      // Timestamps from raw SQL should be converted via new Date().toISOString()
      expect(dm.lastMessageAt).toContain('T');
      expect(dm.createdAt).toContain('T');
    });

    it('should convert channel timestamps to ISO format', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      const channel = body.channels[0];
      expect(channel.updatedAt).toContain('T');
      expect(channel.lastMessageAt).toContain('T');
    });

    it('should call db.execute twice for parallel DM and channel queries', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      await GET(request);

      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('should parse unreadCount as integer from string', async () => {
      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(typeof body.dms[0].unreadCount).toBe('number');
      expect(body.dms[0].unreadCount).toBe(3);
    });

    it('should default unreadCount to 0 when not a valid number', async () => {
      const dmWithBadCount = { ...mockDmRow, unread_count: 'invalid' };
      vi.mocked(db.execute)
        .mockReset()
        .mockResolvedValueOnce({ rows: [dmWithBadCount] } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(body.dms[0].unreadCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.execute)
        .mockReset()
        .mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/messages/threads');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch message threads');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB failure');
      vi.mocked(db.execute)
        .mockReset()
        .mockRejectedValue(error);

      const request = new Request('https://example.com/api/messages/threads');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching message threads:',
        error
      );
    });
  });
});
