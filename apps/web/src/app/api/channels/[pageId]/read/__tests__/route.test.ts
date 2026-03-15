/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/channels/[pageId]/read
//
// Tests POST handler that marks a channel as read for the authenticated user.
// Mocks at the DB query level.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
    execute: vi.fn(),
  },
  pages: { id: 'id' },
  eq: vi.fn(),
  sql: vi.fn((...args: any[]) => args),
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

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
import { POST } from '../route';

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

const makeParams = (pageId: string) => ({
  params: Promise.resolve({ pageId }),
});

// ============================================================================
// POST /api/channels/[pageId]/read
// ============================================================================

describe('POST /api/channels/[pageId]/read', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_channel_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: channel exists
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: pageId,
      type: 'CHANNEL',
      driveId: 'drive_1',
    } as any);

    // Default: execute succeeds
    vi.mocked(db.execute).mockResolvedValue(undefined as any);
  });

  const makePostRequest = () =>
    new Request(`https://example.com/api/channels/${pageId}/read`, {
      method: 'POST',
    });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = makePostRequest();
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 404 when channel not found', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as any);

      const request = makePostRequest();
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Channel not found');
    });

    it('should return 404 when page is not type CHANNEL', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        id: pageId,
        type: 'DOCUMENT',
        driveId: 'drive_1',
      } as any);

      const request = makePostRequest();
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Channel not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = makePostRequest();
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });
  });

  describe('success responses', () => {
    it('should mark channel as read and return success', async () => {
      const request = makePostRequest();
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('should upsert read status via db.execute', async () => {
      const request = makePostRequest();
      await POST(request, makeParams(pageId));

      expect(db.execute).toHaveBeenCalled();
    });

    it('should broadcast read_status_changed event', async () => {
      const request = makePostRequest();
      await POST(request, makeParams(pageId));

      expect(broadcastInboxEvent).toHaveBeenCalledWith(mockUserId, {
        operation: 'read_status_changed',
        type: 'channel',
        id: pageId,
        driveId: 'drive_1',
        unreadCount: 0,
      });
    });
  });
});
