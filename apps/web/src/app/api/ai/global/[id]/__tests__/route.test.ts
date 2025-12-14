import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const returningMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });

  return {
    db: {
      select: selectMock,
      update: updateMock,
    },
    conversations: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
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
  userId: string;
  title: string;
  type: string;
  contextId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id || 'conv_123',
  userId: overrides.userId || 'user_123',
  title: overrides.title || 'Test Conversation',
  type: overrides.type || 'global',
  contextId: overrides.contextId ?? null,
  lastMessageAt: overrides.lastMessageAt || new Date(),
  createdAt: overrides.createdAt || new Date(),
  updatedAt: overrides.updatedAt || new Date(),
  isActive: overrides.isActive ?? true,
});

describe('Global Conversation [id] Routes', () => {
  const mockUserId = 'user_123';
  const mockConversationId = 'conv_123';

  // Helper to setup select mock
  const setupConversationSelectMock = (conversation: ReturnType<typeof mockConversation> | undefined) => {
    const whereMock = vi.fn().mockResolvedValue(conversation ? [conversation] : []);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup update mock
  const setupUpdateMock = (result: ReturnType<typeof mockConversation> | undefined) => {
    const returningMock = vi.fn().mockResolvedValue(result ? [result] : []);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock, returningMock };
  };

  const createContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default conversation exists
    setupConversationSelectMock(mockConversation());
  });

  describe('GET /api/ai/global/[id]', () => {
    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = new Request(`https://example.com/api/ai/global/${mockConversationId}`, {
          method: 'GET',
        });
        const context = createContext(mockConversationId);

        const response = await GET(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('conversation not found', () => {
      it('should return 404 when conversation does not exist', async () => {
        setupConversationSelectMock(undefined);

        const request = new Request(`https://example.com/api/ai/global/${mockConversationId}`, {
          method: 'GET',
        });
        const context = createContext(mockConversationId);

        const response = await GET(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Conversation not found');
      });

      it('should return 404 for conversation belonging to another user', async () => {
        // Conversation exists but belongs to different user
        // This is handled by the where clause checking userId
        setupConversationSelectMock(undefined);

        const request = new Request(`https://example.com/api/ai/global/${mockConversationId}`, {
          method: 'GET',
        });
        const context = createContext(mockConversationId);

        const response = await GET(request, context);
        expect(response.status).toBe(404);
      });
    });

    describe('successful retrieval', () => {
      it('should return conversation details', async () => {
        const conversation = mockConversation({
          id: mockConversationId,
          title: 'My Conversation',
        });
        setupConversationSelectMock(conversation);

        const request = new Request(`https://example.com/api/ai/global/${mockConversationId}`, {
          method: 'GET',
        });
        const context = createContext(mockConversationId);

        const response = await GET(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.id).toBe(mockConversationId);
        expect(body.title).toBe('My Conversation');
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const whereMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const fromMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

        const request = new Request(`https://example.com/api/ai/global/${mockConversationId}`, {
          method: 'GET',
        });
        const context = createContext(mockConversationId);

        const response = await GET(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to fetch conversation');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });

  describe('PATCH /api/ai/global/[id]', () => {
    const createPatchRequest = (id: string, body: object) => {
      return new Request(`https://example.com/api/ai/global/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = createPatchRequest(mockConversationId, { title: 'Updated' });
        const context = createContext(mockConversationId);

        const response = await PATCH(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('conversation not found', () => {
      it('should return 404 when conversation does not exist', async () => {
        setupUpdateMock(undefined);

        const request = createPatchRequest(mockConversationId, { title: 'Updated' });
        const context = createContext(mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Conversation not found');
      });
    });

    describe('successful update', () => {
      it('should update conversation title', async () => {
        const updatedConversation = mockConversation({
          id: mockConversationId,
          title: 'Updated Title',
        });
        setupUpdateMock(updatedConversation);

        const request = createPatchRequest(mockConversationId, { title: 'Updated Title' });
        const context = createContext(mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.title).toBe('Updated Title');
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const returningMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
        const setMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

        const request = createPatchRequest(mockConversationId, { title: 'Updated' });
        const context = createContext(mockConversationId);

        const response = await PATCH(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to update conversation');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });

  describe('DELETE /api/ai/global/[id]', () => {
    const createDeleteRequest = (id: string) => {
      return new Request(`https://example.com/api/ai/global/${id}`, {
        method: 'DELETE',
      });
    };

    describe('authentication', () => {
      it('should return 401 when not authenticated', async () => {
        vi.mocked(isAuthError).mockReturnValue(true);
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

        const request = createDeleteRequest(mockConversationId);
        const context = createContext(mockConversationId);

        const response = await DELETE(request, context);
        expect(response.status).toBe(401);
      });
    });

    describe('conversation not found', () => {
      it('should return 404 when conversation does not exist', async () => {
        setupUpdateMock(undefined);

        const request = createDeleteRequest(mockConversationId);
        const context = createContext(mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Conversation not found');
      });
    });

    describe('successful deletion', () => {
      it('should soft delete conversation', async () => {
        const deletedConversation = mockConversation({
          id: mockConversationId,
          isActive: false,
        });
        const { setMock } = setupUpdateMock(deletedConversation);

        const request = createDeleteRequest(mockConversationId);
        const context = createContext(mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(setMock).toHaveBeenCalledWith(
          expect.objectContaining({
            isActive: false,
          })
        );
      });
    });

    describe('error handling', () => {
      it('should handle database errors gracefully', async () => {
        const returningMock = vi.fn().mockRejectedValue(new Error('Database error'));
        const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
        const setMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

        const request = createDeleteRequest(mockConversationId);
        const context = createContext(mockConversationId);

        const response = await DELETE(request, context);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to delete conversation');
        expect(loggers.api.error).toHaveBeenCalled();
      });
    });
  });
});
