/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/messages/conversations/[conversationId]
//
// Tests GET handler for fetching a single conversation's metadata.
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

const createContext = (conversationId: string) => ({
  params: Promise.resolve({ conversationId }),
});

const mockConversationDetailRow = {
  id: 'conv_1',
  participant1Id: 'user_123',
  participant2Id: 'user_456',
  lastMessageAt: '2024-06-01T12:00:00Z',
  lastMessagePreview: 'Hello there',
  createdAt: '2024-01-01T00:00:00Z',
  other_user_id: 'user_456',
  user_id: 'user_456',
  user_name: 'Other User',
  user_email: 'other@example.com',
  user_image: null,
  user_username: 'otheruser',
  user_display_name: 'Other Display',
  user_avatar_url: 'https://example.com/avatar.jpg',
};

// ============================================================================
// GET /api/messages/conversations/[conversationId] - Contract Tests
// ============================================================================

describe('GET /api/messages/conversations/[conversationId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation found
    vi.mocked(db.execute).mockResolvedValue({
      rows: [mockConversationDetailRow],
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(
        'https://example.com/api/messages/conversations/conv_1'
      );
      const response = await GET(request, createContext('conv_1'));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with read auth options', async () => {
      const request = new Request(
        'https://example.com/api/messages/conversations/conv_1'
      );
      await GET(request, createContext('conv_1'));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('success responses', () => {
    it('should return conversation with other user info when found', async () => {
      const request = new Request(
        'https://example.com/api/messages/conversations/conv_1'
      );
      const response = await GET(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversation).toMatchObject({
        id: 'conv_1',
        participant1Id: 'user_123',
        participant2Id: 'user_456',
        lastMessageAt: '2024-06-01T12:00:00Z',
        lastMessagePreview: 'Hello there',
        otherUser: {
          id: 'user_456',
          name: 'Other User',
          email: 'other@example.com',
          image: null,
          username: 'otheruser',
          displayName: 'Other Display',
          avatarUrl: 'https://example.com/avatar.jpg',
        },
      });
    });

    it('should use conversationId from params', async () => {
      const request = new Request(
        'https://example.com/api/messages/conversations/conv_42'
      );
      await GET(request, createContext('conv_42'));

      expect(db.execute).toHaveBeenCalled();
    });
  });

  describe('not found', () => {
    it('should return 404 when conversation not found (empty rows)', async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as any);

      const request = new Request(
        'https://example.com/api/messages/conversations/conv_nonexistent'
      );
      const response = await GET(request, createContext('conv_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error('Database error'));

      const request = new Request(
        'https://example.com/api/messages/conversations/conv_1'
      );
      const response = await GET(request, createContext('conv_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch conversation');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB failure');
      vi.mocked(db.execute).mockRejectedValue(error);

      const request = new Request(
        'https://example.com/api/messages/conversations/conv_1'
      );
      await GET(request, createContext('conv_1'));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching conversation:',
        error
      );
    });
  });
});
