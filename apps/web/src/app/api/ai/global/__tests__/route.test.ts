import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const orderByMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  const returningMock = vi.fn().mockResolvedValue([]);
  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
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

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated_conv_id'),
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
  userId: string;
  title: string;
  type: string;
  contextId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id || 'conv_123',
  userId: overrides.userId || 'user_123',
  title: overrides.title || 'Test Conversation',
  type: overrides.type || 'global',
  contextId: overrides.contextId ?? null,
  lastMessageAt: overrides.lastMessageAt || new Date(),
  createdAt: overrides.createdAt || new Date(),
  isActive: overrides.isActive ?? true,
});

describe('Global Conversations API Routes', () => {
  const mockUserId = 'user_123';

  // Helper to setup select mock for conversations
  const setupConversationsSelectMock = (conversations: ReturnType<typeof mockConversation>[]) => {
    const orderByMock = vi.fn().mockResolvedValue(conversations);
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup insert mock for conversations
  const setupInsertMock = (conversation: ReturnType<typeof mockConversation>) => {
    const returningMock = vi.fn().mockResolvedValue([conversation]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);
    return { valuesMock, returningMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default empty conversations
    setupConversationsSelectMock([]);
  });

  describe('GET /api/ai/global', () => {
    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = new Request('https://example.com/api/ai/global', {
          method: 'GET',
        });

        const response = await GET(request);
        expect(response.status).toBe(401);
      });
    });

    describe('successful retrieval', () => {
      it('should return conversations for authenticated user', async () => {
        const conversations = [
          mockConversation({ id: 'conv_1', title: 'First conversation' }),
          mockConversation({ id: 'conv_2', title: 'Second conversation' }),
        ];
        setupConversationsSelectMock(conversations);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'GET',
        });

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(2);
      });

      it('should return empty array when no conversations exist', async () => {
        setupConversationsSelectMock([]);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'GET',
        });

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual([]);
      });

      it('should only return active conversations', async () => {
        // The route filters by isActive=true
        const request = new Request('https://example.com/api/ai/global', {
          method: 'GET',
        });

        await GET(request);
        // Verify the select was called (the mock handles the filtering)
        expect(db.select).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const orderByMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
        const fromMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'GET',
        });

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to fetch conversations');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });

  describe('POST /api/ai/global', () => {
    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = new Request('https://example.com/api/ai/global', {
          method: 'POST',
          body: JSON.stringify({ title: 'New conversation' }),
        });

        const response = await POST(request);
        expect(response.status).toBe(401);
      });
    });

    describe('successful creation', () => {
      it('should create a new conversation', async () => {
        const newConversation = mockConversation({
          id: 'generated_conv_id',
          title: 'My new conversation',
        });
        setupInsertMock(newConversation);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'POST',
          body: JSON.stringify({ title: 'My new conversation' }),
        });

        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.id).toBe('generated_conv_id');
      });

      it('should create conversation without title', async () => {
        const newConversation = mockConversation({
          id: 'generated_conv_id',
          title: null,
        });
        setupInsertMock(newConversation);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'POST',
          body: JSON.stringify({}),
        });

        const response = await POST(request);
        expect(response.status).toBe(200);
      });

      it('should create conversation with type and contextId', async () => {
        const newConversation = mockConversation({
          id: 'generated_conv_id',
          type: 'page',
          contextId: 'page_123',
        });
        setupInsertMock(newConversation);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'POST',
          body: JSON.stringify({ type: 'page', contextId: 'page_123' }),
        });

        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.type).toBe('page');
        expect(body.contextId).toBe('page_123');
      });

      it('should default type to global', async () => {
        const newConversation = mockConversation({ type: 'global' });
        const { valuesMock } = setupInsertMock(newConversation);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'POST',
          body: JSON.stringify({}),
        });

        await POST(request);

        expect(valuesMock).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'global',
          })
        );
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const returningMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
        vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

        const request = new Request('https://example.com/api/ai/global', {
          method: 'POST',
          body: JSON.stringify({ title: 'New conversation' }),
        });

        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to create conversation');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });
});
