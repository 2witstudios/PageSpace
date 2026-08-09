/**
 * Contract tests for GET/PATCH/DELETE /api/ai/global/[id]
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getConversationById: vi.fn(),
    updateConversationTitle: vi.fn(),
    softDeleteConversation: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock logging (boundary)
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  expelConversationFromSession: vi.fn(),
  findWorkspaceOfConversation: vi.fn(),
  // Pass-through: these DELETE-route tests are about the guard-then-delete
  // sequence at the call site, not lock contention (that's
  // `agent-workspaces-runtime`'s own test suite).
}));

import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { expelConversationFromSession, findWorkspaceOfConversation } from '@/lib/agent-workspaces/agent-workspaces-runtime';

// Test fixtures
const mockUserId = 'user_123';
const mockConversationId = 'conv_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockConversation = (overrides: Partial<{
  id: string;
  userId: string;
  title: string | null;
  type: string;
  contextId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
  workspaceId: string | null;
  closedInWorkspaceAt: Date | null;
}> = {}) => ({
  id: overrides.id ?? mockConversationId,
  userId: overrides.userId ?? mockUserId,
  title: overrides.title ?? 'Test Conversation',
  type: overrides.type ?? 'global',
  contextId: overrides.contextId ?? null,
  lastMessageAt: overrides.lastMessageAt ?? new Date(),
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
  isActive: overrides.isActive ?? true,
  workspaceId: overrides.workspaceId ?? null,
  closedInWorkspaceAt: overrides.closedInWorkspaceAt ?? null,
});

const createContext = (id: string) => ({
  params: Promise.resolve({ id }),
});

const createGetRequest = (id: string) =>
  new Request(`https://example.com/api/ai/global/${id}`, { method: 'GET' });

const createPatchRequest = (id: string, body: Record<string, unknown>) =>
  new Request(`https://example.com/api/ai/global/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

const createDeleteRequest = (id: string) =>
  new Request(`https://example.com/api/ai/global/${id}`, { method: 'DELETE' });

describe('GET /api/ai/global/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation exists
    vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(
      mockConversation()
    );
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createGetRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('conversation not found', () => {
    it('should return 404 when conversation does not exist', async () => {
      vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(null);

      const request = createGetRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('successful retrieval', () => {
    it('should return conversation details', async () => {
      const conversation = mockConversation({
        id: mockConversationId,
        title: 'My Conversation',
      });
      vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(conversation);

      const request = createGetRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe(mockConversationId);
      expect(body.title).toBe('My Conversation');
    });

    it('should call repository with userId and conversationId', async () => {
      const request = createGetRequest(mockConversationId);
      const context = createContext(mockConversationId);

      await GET(request, context);

      expect(globalConversationRepository.getConversationById).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.getConversationById).mockRejectedValue(
        new Error('Database error')
      );

      const request = createGetRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch conversation');
      const fetchErrorArgs = vi.mocked(loggers.api.error).mock.calls[0];
      expect(fetchErrorArgs[0]).toBe('Error fetching conversation:');
      expect(fetchErrorArgs[1]).toBeInstanceOf(Error);
      expect((fetchErrorArgs[1] as Error).message).toBe('Database error');
    });
  });
});

describe('PATCH /api/ai/global/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: update succeeds
    vi.mocked(globalConversationRepository.updateConversationTitle).mockResolvedValue(
      mockConversation()
    );
  });

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
      vi.mocked(globalConversationRepository.updateConversationTitle).mockResolvedValue(null);

      const request = createPatchRequest(mockConversationId, { title: 'Updated' });
      const context = createContext(mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('successful update', () => {
    it('should update conversation title and return updated conversation', async () => {
      const updatedConversation = mockConversation({
        id: mockConversationId,
        title: 'Updated Title',
      });
      vi.mocked(globalConversationRepository.updateConversationTitle).mockResolvedValue(
        updatedConversation
      );

      const request = createPatchRequest(mockConversationId, { title: 'Updated Title' });
      const context = createContext(mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('Updated Title');
    });

    it('should call repository with correct arguments', async () => {
      const request = createPatchRequest(mockConversationId, { title: 'New Title' });
      const context = createContext(mockConversationId);

      await PATCH(request, context);

      expect(globalConversationRepository.updateConversationTitle).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId,
        'New Title'
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.updateConversationTitle).mockRejectedValue(
        new Error('Database error')
      );

      const request = createPatchRequest(mockConversationId, { title: 'Updated' });
      const context = createContext(mockConversationId);

      const response = await PATCH(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update conversation');
      const updateErrorArgs = vi.mocked(loggers.api.error).mock.calls[0];
      expect(updateErrorArgs[0]).toBe('Error updating conversation:');
      expect(updateErrorArgs[1]).toBeInstanceOf(Error);
      expect((updateErrorArgs[1] as Error).message).toBe('Database error');
    });
  });
});

describe('DELETE /api/ai/global/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: a plain (non-session-bound) conversation
    vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(
      mockConversation()
    );

    // Default: delete succeeds
    vi.mocked(globalConversationRepository.softDeleteConversation).mockResolvedValue(
      mockConversation({ isActive: false })
    );

    // Default: the thread belongs to no workspace, so the membership half is
    // never reached. Tests about the guard set a workspace explicitly.
    vi.mocked(findWorkspaceOfConversation).mockResolvedValue(null);
    vi.mocked(expelConversationFromSession).mockResolvedValue('expelled');
  });

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
      vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(null);

      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
      expect(globalConversationRepository.softDeleteConversation).not.toHaveBeenCalled();
    });
  });

  describe('successful deletion', () => {
    it('should soft delete conversation and return success', async () => {
      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should call repository with correct arguments', async () => {
      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);

      await DELETE(request, context);

      expect(globalConversationRepository.softDeleteConversation).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId
      );
    });

    it('does not touch membership for a thread that belongs to no workspace', async () => {
      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);

      await DELETE(request, context);

      expect(expelConversationFromSession).not.toHaveBeenCalled();
    });
  });

  describe('the never-empty guard, now decided against the workspace\'s own tree', () => {
    it("refuses to delete a thread that is its workspace's LAST conversation", async () => {
      vi.mocked(findWorkspaceOfConversation).mockResolvedValue('ses_1');
      vi.mocked(expelConversationFromSession).mockResolvedValue('last_conversation');

      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);
      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.reason).toBe('last_conversation');
      // Refused BEFORE the history write. Under the old shape the guard was a
      // count on a second connection under a second lock; here it is a count
      // over the tree inside the transaction that would have changed it.
      expect(globalConversationRepository.softDeleteConversation).not.toHaveBeenCalled();
      expect(auditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'security.rate.limited' }),
      );
    });

    it('deletes when the workspace holds another conversation, removing the membership FIRST', async () => {
      vi.mocked(findWorkspaceOfConversation).mockResolvedValue('ses_1');
      vi.mocked(expelConversationFromSession).mockResolvedValue('expelled');

      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);
      const response = await DELETE(request, context);

      expect(response.status).toBe(200);
      expect(expelConversationFromSession).toHaveBeenCalledWith({
        conversationId: mockConversationId,
        workspaceId: 'ses_1',
        actingUserId: mockUserId,
        requireSurvivor: true,
      });
      expect(globalConversationRepository.softDeleteConversation).toHaveBeenCalledWith(mockUserId, mockConversationId);
    });

    it('500s without deleting history when the membership write itself fails', async () => {
      // The ordering that makes the survivable failure the one that can happen:
      // a thread out of its workspace with intact history is re-claimable, a
      // pane bound to a dead thread is not.
      vi.mocked(findWorkspaceOfConversation).mockResolvedValue('ses_1');
      vi.mocked(expelConversationFromSession).mockResolvedValue('refused');

      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);
      const response = await DELETE(request, context);

      expect(response.status).toBe(500);
      expect(globalConversationRepository.softDeleteConversation).not.toHaveBeenCalled();
    });
  });

  describe('legacy shapes', () => {
    it('deletes a thread whose workspace vanished — no membership left to remove', async () => {
      // The node's `rootId` FK cascades, so a deleted workspace takes its
      // membership with it and this reads as "belongs to nothing".
      vi.mocked(findWorkspaceOfConversation).mockResolvedValue(null);

      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);
      const response = await DELETE(request, context);

      expect(response.status).toBe(200);
      expect(expelConversationFromSession).not.toHaveBeenCalled();
      expect(globalConversationRepository.softDeleteConversation).toHaveBeenCalledWith(mockUserId, mockConversationId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.softDeleteConversation).mockRejectedValue(
        new Error('Database error')
      );

      const request = createDeleteRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete conversation');
      const deleteErrorArgs = vi.mocked(loggers.api.error).mock.calls[0];
      expect(deleteErrorArgs[0]).toBe('Error deleting conversation:');
      expect(deleteErrorArgs[1]).toBeInstanceOf(Error);
      expect((deleteErrorArgs[1] as Error).message).toBe('Database error');
    });
  });
});
