/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/inbox
//
// Tests unified inbox endpoint (DMs + channels) with cursor-based pagination.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  getBatchPagePermissions: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    execute: vi.fn(),
  },
  sql: vi.fn(),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn(),
}));

vi.mock('@/lib/utils/timestamp', () => ({
  toISOTimestamp: vi.fn((ts: string | null) => ts),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getBatchPagePermissions } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

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

// ============================================================================
// GET /api/inbox - Contract Tests
// ============================================================================

describe('GET /api/inbox', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(parseBoundedIntParam).mockReturnValue(20);
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as any);
    vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map());
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only read options', async () => {
      const request = new Request('http://localhost/api/inbox');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('dashboard inbox (no driveId)', () => {
    it('should return empty items when no DMs or channels exist', async () => {
      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.items).toEqual([]);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.hasMore).toBe(false);
    });

    it('should return DM items from the first execute call', async () => {
      // First call = DMs, second call = channels
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'dm_1',
              last_message_at: '2024-01-01T00:00:00Z',
              last_message: 'Hello',
              other_user_name: 'Alice',
              other_user_display_name: null,
              other_user_avatar_url: null,
              unread_count: '2',
            },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].type).toBe('dm');
      expect(body.items[0].name).toBe('Alice');
      expect(body.items[0].unreadCount).toBe(2);
    });

    it('should return channel items with permissions check', async () => {
      // First call = DMs (empty), second call = channels
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'chan_1',
              name: 'General',
              drive_id: 'drive_1',
              drive_name: 'Team Drive',
              last_message: 'Hi everyone',
              last_message_at: '2024-01-01T00:00:00Z',
              sender_name: 'Bob',
              unread_count: '5',
            },
          ],
        } as any);

      vi.mocked(getBatchPagePermissions).mockResolvedValue(
        new Map([['chan_1', { canView: true, canEdit: false }]])
      );

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].type).toBe('channel');
      expect(body.items[0].name).toBe('General');
      expect(body.items[0].driveId).toBe('drive_1');
    });

    it('should filter out channels user cannot view', async () => {
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'chan_1',
              name: 'Private',
              drive_id: 'drive_1',
              drive_name: 'Drive',
              last_message: null,
              last_message_at: null,
              sender_name: null,
              unread_count: '0',
            },
          ],
        } as any);

      vi.mocked(getBatchPagePermissions).mockResolvedValue(
        new Map([['chan_1', { canView: false, canEdit: false }]])
      );

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(body.items).toHaveLength(0);
    });

    it('should sort combined items by lastMessageAt descending', async () => {
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'dm_1',
              last_message_at: '2024-01-01T00:00:00Z',
              last_message: 'Old DM',
              other_user_name: 'Alice',
              other_user_display_name: null,
              other_user_avatar_url: null,
              unread_count: '0',
            },
          ],
        } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'chan_1',
              name: 'General',
              drive_id: 'drive_1',
              drive_name: 'Team',
              last_message: 'Recent',
              last_message_at: '2024-06-01T00:00:00Z',
              sender_name: 'Bob',
              unread_count: '0',
            },
          ],
        } as any);

      vi.mocked(getBatchPagePermissions).mockResolvedValue(
        new Map([['chan_1', { canView: true, canEdit: false }]])
      );

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      // Channel with more recent timestamp should be first
      expect(body.items[0].id).toBe('chan_1');
      expect(body.items[1].id).toBe('dm_1');
    });
  });

  describe('drive-specific inbox (with driveId)', () => {
    it('should only return channels for specified drive', async () => {
      vi.mocked(db.execute).mockResolvedValue({
        rows: [
          {
            id: 'chan_1',
            name: 'Dev',
            drive_id: 'drive_specific',
            drive_name: 'Dev Drive',
            last_message: 'Test',
            last_message_at: '2024-01-01T00:00:00Z',
            sender_name: 'Alice',
            unread_count: '0',
          },
        ],
      } as any);

      vi.mocked(getBatchPagePermissions).mockResolvedValue(
        new Map([['chan_1', { canView: true, canEdit: false }]])
      );

      const request = new Request('http://localhost/api/inbox?driveId=drive_specific');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].driveId).toBe('drive_specific');
      // Should only call execute once (channels only, no DMs)
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('pagination', () => {
    it('should return hasMore=false when items fit within limit', async () => {
      vi.mocked(parseBoundedIntParam).mockReturnValue(20);

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(body.pagination.hasMore).toBe(false);
      expect(body.pagination.nextCursor).toBeNull();
    });

    it('should use display name over user name when available', async () => {
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'dm_1',
              last_message_at: '2024-01-01T00:00:00Z',
              last_message: 'Hello',
              other_user_name: 'alice123',
              other_user_display_name: 'Alice Smith',
              other_user_avatar_url: 'https://example.com/avatar.png',
              unread_count: '0',
            },
          ],
        } as any)
        .mockResolvedValueOnce({ rows: [] } as any);

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(body.items[0].name).toBe('Alice Smith');
      expect(body.items[0].avatarUrl).toBe('https://example.com/avatar.png');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error('Connection failed'));

      const request = new Request('http://localhost/api/inbox');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch inbox');
    });
  });
});
