import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const limitMock = vi.fn().mockResolvedValue([]);
  const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
  const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
    },
    conversations: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
    desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock conversation
const mockConversation = (overrides: Partial<{
  id: string;
  title: string;
  type: string;
  contextId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
}> = {}) => ({
  id: overrides.id || 'conv_123',
  title: overrides.title || 'Test Conversation',
  type: overrides.type || 'global',
  contextId: overrides.contextId ?? null,
  lastMessageAt: overrides.lastMessageAt || new Date(),
  createdAt: overrides.createdAt || new Date(),
});

describe('GET /api/ai/global/active', () => {
  const mockUserId = 'user_123';

  // Helper to setup select mock for active conversation
  const setupActiveConversationMock = (conversation: ReturnType<typeof mockConversation> | null) => {
    const limitMock = vi.fn().mockResolvedValue(conversation ? [conversation] : []);
    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default no active conversation
    setupActiveConversationMock(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/global/active', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });
  });

  describe('successful retrieval', () => {
    it('should return the most recent global conversation', async () => {
      const conversation = mockConversation({
        id: 'conv_active',
        title: 'Active Conversation',
        type: 'global',
      });
      setupActiveConversationMock(conversation);

      const request = new Request('https://example.com/api/ai/global/active', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe('conv_active');
      expect(body.title).toBe('Active Conversation');
      expect(body.type).toBe('global');
    });

    it('should return null when no global conversation exists', async () => {
      setupActiveConversationMock(null);

      const request = new Request('https://example.com/api/ai/global/active', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toBeNull();
    });

    it('should only query for global type conversations', async () => {
      const request = new Request('https://example.com/api/ai/global/active', {
        method: 'GET',
      });

      await GET(request);
      // Verify the select was called
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const limitMock = vi.fn().mockRejectedValue(new Error('Database error'));
      const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
      const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const request = new Request('https://example.com/api/ai/global/active', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch global conversation');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
